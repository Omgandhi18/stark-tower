//! What a crash left behind, read into something a person or an agent can act on:
//! the report macOS writes (`.ips`), the panics Starkline wrote down while it ran,
//! and what the system logged just before. Reading and writing up only; `crash_log`
//! decides what's kept.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// macOS's report type for a crash (hangs and others have their own).
const CRASH_BUG_TYPE: &str = "309";
/// What Rust says when a panic (or an Objective-C exception) reaches an `extern "C"` function.
pub const CANNOT_UNWIND: &str = "panic in a function that cannot unwind";
/// A panic this close to the crash is what caused it.
const CAUSE_WINDOW_MS: i64 = 10_000;
/// The crashed thread's frames shown in a write-up.
const FRAMES_SHOWN: usize = 30;
/// How far back, and past the crash, the system log is read.
const LOG_BEFORE_MS: i64 = 2 * 60_000;
const LOG_AFTER_MS: i64 = 5_000;
/// Lines of system log kept (the latest).
const LOG_LINES: usize = 200;
/// `log show` can be slow on a busy Mac; past this it's given up on.
const LOG_TIMEOUT: Duration = Duration::from_secs(90);
/// Function names from the Rust runtime itself, not the code that crashed.
const RUNTIME_PREFIXES: [&str; 5] = ["std::", "core::", "alloc::", "__rustc", "rust_begin_unwind"];
/// Words in a system log line that say what went wrong.
const TELLING_WORDS: [&str; 3] = ["***", "exception", "assertion"];

/// The parts of a macOS crash report the crash log uses.
#[derive(Debug, Clone, PartialEq)]
pub struct MacReport {
    pub incident: String,
    pub process: String,
    pub pid: u32,
    pub version: String,
    /// Milliseconds since the epoch.
    pub crashed_at: i64,
    pub started_at: Option<i64>,
    /// "EXC_CRASH (SIGABRT)".
    pub exception: String,
    /// "Abort trap: 6, abort() called".
    pub termination: String,
    /// "main (com.apple.main-thread)".
    pub thread: String,
    pub frames: Vec<Frame>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    pub image: String,
    /// Demangled where it's a Rust function.
    pub symbol: String,
    /// In the crashed program itself, not a system library.
    pub own: bool,
}

/// A panic Starkline wrote down as it happened (one JSON line each).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Panic {
    pub at: i64,
    pub thread: String,
    pub message: String,
    pub location: String,
    pub backtrace: String,
}

/// From a report's first line: its incident id, when it's a crash of `process`.
pub fn crash_incident(header_line: &str, process: &str) -> Option<String> {
    let header: Value = serde_json::from_str(header_line).ok()?;
    let name = header.get("app_name").or_else(|| header.get("name")).and_then(Value::as_str)?;
    let crash = header.get("bug_type").and_then(Value::as_str) == Some(CRASH_BUG_TYPE);
    if name != process || !crash {
        return None;
    }
    header.get("incident_id").and_then(Value::as_str).map(str::to_string)
}

/// Read a whole `.ips` crash report: a header line, then the report itself.
pub fn read_mac_report(text: &str) -> Option<MacReport> {
    let (header_line, body) = text.split_once('\n')?;
    let header: Value = serde_json::from_str(header_line).ok()?;
    let body: Value = serde_json::from_str(body).ok()?;
    let process = str_at(&header, "app_name").or_else(|| str_at(&header, "name"))?.to_string();
    let crashed_at = str_at(&body, "captureTime").and_then(parse_report_time)?;
    let version = str_at(&header, "app_version")
        .or_else(|| body.pointer("/bundleInfo/CFBundleShortVersionString").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string();
    let frames = crashed_frames(&body, &process);
    Some(MacReport {
        incident: str_at(&header, "incident_id").or_else(|| str_at(&body, "incident")).unwrap_or_default().to_string(),
        pid: body.get("pid").and_then(Value::as_u64).and_then(|p| u32::try_from(p).ok())?,
        version,
        crashed_at,
        started_at: str_at(&body, "procLaunch").and_then(parse_report_time),
        exception: exception_line(&body),
        termination: termination_line(&body),
        thread: crashed_thread_name(&body),
        frames,
        process,
    })
}

fn str_at<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// "2026-10-09 12:34:21.3465 +0530" in milliseconds since the epoch.
fn parse_report_time(text: &str) -> Option<i64> {
    chrono::DateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S%.f %z").ok().map(|t| t.timestamp_millis())
}

fn exception_line(body: &Value) -> String {
    let kind = body.pointer("/exception/type").and_then(Value::as_str).unwrap_or_default();
    match body.pointer("/exception/signal").and_then(Value::as_str) {
        Some(signal) if !kind.is_empty() => format!("{kind} ({signal})"),
        Some(signal) => signal.to_string(),
        None => kind.to_string(),
    }
}

fn termination_line(body: &Value) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(indicator) = body.pointer("/termination/indicator").and_then(Value::as_str) {
        parts.push(indicator.to_string());
    }
    // "Application Specific Information": what the library that ended it said.
    if let Some(asi) = body.get("asi").and_then(Value::as_object) {
        parts.extend(asi.values().filter_map(Value::as_array).flatten().filter_map(Value::as_str).map(str::to_string));
    }
    parts.join(", ")
}

fn crashed_thread(body: &Value) -> Option<&Value> {
    let index = body.get("faultingThread").and_then(Value::as_u64)?;
    body.get("threads")?.get(usize::try_from(index).ok()?)
}

fn crashed_thread_name(body: &Value) -> String {
    let Some(thread) = crashed_thread(body) else { return String::new() };
    match (str_at(thread, "name"), str_at(thread, "queue")) {
        (Some(name), Some(queue)) => format!("{name} ({queue})"),
        (Some(name), None) => name.to_string(),
        (None, Some(queue)) => queue.to_string(),
        (None, None) => String::new(),
    }
}

fn crashed_frames(body: &Value, process: &str) -> Vec<Frame> {
    let images: Vec<String> = body
        .get("usedImages")
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|i| str_at(i, "name").unwrap_or("?").to_string()).collect())
        .unwrap_or_default();
    let Some(frames) = crashed_thread(body).and_then(|t| t.get("frames")).and_then(Value::as_array) else {
        return Vec::new();
    };
    frames
        .iter()
        .map(|f| {
            let image = f.get("imageIndex").and_then(Value::as_u64).and_then(|i| images.get(i as usize)).cloned().unwrap_or_else(|| "?".into());
            let symbol = match str_at(f, "symbol") {
                Some(s) => demangle(s),
                None => format!("+{}", f.get("imageOffset").and_then(Value::as_u64).unwrap_or(0)),
            };
            Frame { own: image == process, image, symbol }
        })
        .collect()
}

/// A Rust symbol as source would name it; anything else as it is.
pub fn demangle(symbol: &str) -> String {
    match rustc_demangle::try_demangle(symbol) {
        Ok(name) => format!("{name:#}"),
        Err(_) => symbol.to_string(),
    }
}

/// The function in the program's own code it stopped in, past the Rust runtime's.
pub fn place(report: &MacReport) -> Option<String> {
    report
        .frames
        .iter()
        .filter(|f| f.own && !f.symbol.starts_with('+'))
        .find(|f| !RUNTIME_PREFIXES.iter().any(|p| f.symbol.starts_with(p)))
        .map(|f| f.symbol.clone())
}

/// Panics written down as JSON lines; lines that don't read are skipped.
pub fn read_panics(text: &str) -> Vec<Panic> {
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// A run that ended with no crash report was ended by its last panic only if that was
/// on the main thread: elsewhere a panic ends just its own thread.
pub fn panic_was_fatal(panics: &[Panic]) -> bool {
    panics.last().is_some_and(|p| p.thread == "main")
}

/// What went wrong, in one line: the panic that caused it, else what the system logged
/// (an assertion, an uncaught exception), else how the process ended.
pub fn reason(report: Option<&MacReport>, panics: &[Panic], log: &[String], crashed_at: i64) -> String {
    let cause = panics
        .iter()
        .rev()
        .filter(|p| p.message != CANNOT_UNWIND)
        .find(|p| (crashed_at - p.at).abs() <= CAUSE_WINDOW_MS);
    if let Some(p) = cause {
        return format!("panicked at {}: {}", p.location, p.message);
    }
    if let Some(line) = log.iter().rev().find(|l| telling(l)) {
        return log_message(line).to_string();
    }
    if let Some(p) = panics.last() {
        return p.message.clone();
    }
    match report {
        Some(r) if !r.termination.is_empty() => format!("{}: {}", r.exception, r.termination),
        Some(r) if !r.exception.is_empty() => r.exception.clone(),
        _ => "Starkline stopped without saying why".into(),
    }
}

fn telling(line: &str) -> bool {
    let lower = log_message(line).to_lowercase();
    TELLING_WORDS.iter().any(|w| lower.contains(w))
}

/// A `log show --style compact` line without its time, type, process and subsystem.
pub fn log_message(line: &str) -> &str {
    static PREFIX: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let prefix = PREFIX.get_or_init(|| {
        regex::Regex::new(r"^\d{4}-\d{2}-\d{2} [\d:.]+ +\S+ +.+?\[\d+:[0-9a-fA-F]+\] +(?:\[[^\]]+\] +)?").expect("valid pattern")
    });
    match prefix.find(line) {
        Some(m) => &line[m.end()..],
        None => line,
    }
}

/// Errors, faults and exceptions the system logged for a process in the minutes
/// before it crashed. Empty if the log can't be read (or no longer reaches back).
pub fn system_log(pid: u32, crashed_at: i64) -> Vec<String> {
    let (Some(start), Some(end)) = (log_time(crashed_at - LOG_BEFORE_MS), log_time(crashed_at + LOG_AFTER_MS)) else {
        return Vec::new();
    };
    let predicate = format!(
        "processID == {pid} AND (messageType == error OR messageType == fault OR eventMessage CONTAINS[c] \"exception\" OR eventMessage CONTAINS[c] \"assertion\")"
    );
    let mut command = Command::new("/usr/bin/log");
    command.args(["show", "--style", "compact", "--start", &start, "--end", &end, "--predicate", &predicate]);
    let Some(output) = output_within(command, LOG_TIMEOUT) else { return Vec::new() };
    log_lines(&output)
}

/// The log's own lines (each starts with its date), the latest `LOG_LINES`.
fn log_lines(output: &str) -> Vec<String> {
    let dated = |l: &&str| l.len() > 10 && l.as_bytes()[..10].iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    let lines: Vec<String> = output.lines().filter(dated).map(str::to_string).collect();
    let skip = lines.len().saturating_sub(LOG_LINES);
    lines.into_iter().skip(skip).collect()
}

/// Local time as `log show` takes it.
fn log_time(ms: i64) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|t| t.format("%Y-%m-%d %H:%M:%S").to_string())
}

/// A command's output, or None if it couldn't run or took longer than `limit`.
fn output_within(mut command: Command, limit: Duration) -> Option<String> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Read as it arrives, so a long output can't fill the pipe and stall the command.
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
        }
    }
    reader.join().ok()
}

/// What the write-up says about the crash itself.
pub struct Facts<'a> {
    pub crashed_at: i64,
    pub started_at: Option<i64>,
    pub version: &'a str,
    pub pid: u32,
    pub reason: &'a str,
    pub place: Option<&'a str>,
}

/// The crash in Markdown, for the developer and the agent fixing it: what went wrong,
/// where, the crashed thread, the panics and what the system logged.
pub fn write_up(facts: &Facts, report: Option<&MacReport>, panics: &[Panic], log: &[String]) -> String {
    let mut out = format!("# Starkline crashed: {}\n\n", local_time(facts.crashed_at, "%-d %b %Y, %H:%M:%S"));
    out.push_str(&format!("- **What went wrong:** {}\n", facts.reason));
    if let Some(place) = facts.place {
        out.push_str(&format!("- **Where:** `{place}`\n"));
    }
    if let Some(r) = report {
        out.push_str(&format!("- **How it ended:** {}\n", [r.exception.as_str(), r.termination.as_str()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join(", ")));
    }
    out.push_str(&format!("- **Version:** {} (process {})\n", facts.version, facts.pid));
    if let Some(started) = facts.started_at {
        out.push_str(&format!("- **Running for:** {}, since {}\n", duration(facts.crashed_at - started), local_time(started, "%-d %b %H:%M:%S")));
    }

    if let Some(r) = report.filter(|r| !r.frames.is_empty()) {
        let thread = if r.thread.is_empty() { String::new() } else { format!(": {}", r.thread) };
        out.push_str(&format!("\n## Crashed thread{thread}\n\n```text\n"));
        let width = r.frames.iter().take(FRAMES_SHOWN).map(|f| f.image.len()).max().unwrap_or(0);
        for (i, f) in r.frames.iter().take(FRAMES_SHOWN).enumerate() {
            out.push_str(&format!("{i:>2}  {:<width$}  {}\n", f.image, f.symbol));
        }
        out.push_str("```\n");
    }

    if !panics.is_empty() {
        out.push_str("\n## Rust panics in that run\n");
        for p in panics {
            out.push_str(&format!("\n### {} on {}: {}\n\nAt `{}`.\n\n```text\n{}\n```\n", local_time(p.at, "%H:%M:%S"), p.thread, p.message, p.location, p.backtrace.trim_end()));
        }
    }

    out.push_str("\n## What the system logged just before\n\n");
    if log.is_empty() {
        out.push_str("Nothing: no errors or exceptions were logged for this process, or the system log no longer reaches back that far.\n");
    } else {
        out.push_str(&format!("```text\n{}\n```\n", log.join("\n")));
    }
    if report.is_some() {
        out.push_str("\nmacOS's full crash report is the `.ips` file kept with this one.\n");
    }
    out
}

fn local_time(ms: i64, format: &str) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|t| t.format(format).to_string()).unwrap_or_default()
}

/// "1 h 25 min", "3 min", "40 s".
fn duration(ms: i64) -> String {
    let seconds = (ms / 1000).max(0);
    let (hours, minutes) = (seconds / 3600, (seconds % 3600) / 60);
    match (hours, minutes) {
        (0, 0) => format!("{seconds} s"),
        (0, m) => format!("{m} min"),
        (h, 0) => format!("{h} h"),
        (h, m) => format!("{h} h {m} min"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed-down report shaped like the ones macOS writes for Starkline.
    fn sample_report() -> String {
        let header = r#"{"app_name":"Starkline","timestamp":"2026-10-09 12:34:23.00 +0530","app_version":"0.1.0","bug_type":"309","name":"Starkline","incident_id":"43B888D8-F5A2-40B8-94FD-E1901D3319F5"}"#;
        let body = serde_json::json!({
            "pid": 8993,
            "captureTime": "2026-10-09 12:34:21.3465 +0530",
            "procLaunch": "2026-10-09 11:09:04.7789 +0530",
            "exception": {"type": "EXC_CRASH", "signal": "SIGABRT"},
            "termination": {"indicator": "Abort trap: 6"},
            "asi": {"libsystem_c.dylib": ["abort() called"]},
            "faultingThread": 0,
            "threads": [{"name": "main", "queue": "com.apple.main-thread", "frames": [
                {"imageIndex": 1, "imageOffset": 38480, "symbol": "__pthread_kill"},
                {"imageIndex": 0, "imageOffset": 1, "symbol": "_RNvNtCsa9BKTri5B3M_3std7process5abort"},
                {"imageIndex": 0, "imageOffset": 2, "symbol": "_RNvCs9wFQrvczXsK_7___rustc17rust_begin_unwind"},
                {"imageIndex": 0, "imageOffset": 3, "symbol": "_RNvNtCsgtPOCBgevO_4core9panicking19panic_cannot_unwind"},
                {"imageIndex": 0, "imageOffset": 4, "symbol": "_RNvNtNtNtCs3SP3SOwnY46_3tao13platform_impl8platform3app10send_event"},
                {"imageIndex": 2, "imageOffset": 5, "symbol": "-[NSApplication _handleEvent:]"},
                {"imageIndex": 0, "imageOffset": 6}
            ]}],
            "usedImages": [{"name": "Starkline"}, {"name": "libsystem_kernel.dylib"}, {"name": "AppKit"}]
        });
        format!("{header}\n{body}")
    }

    #[test]
    fn reads_a_macos_crash_report() {
        let report = read_mac_report(&sample_report()).expect("report");
        assert_eq!(report.pid, 8993);
        assert_eq!(report.process, "Starkline");
        assert_eq!(report.version, "0.1.0");
        assert_eq!(report.incident, "43B888D8-F5A2-40B8-94FD-E1901D3319F5");
        assert_eq!(report.crashed_at, parse_report_time("2026-10-09 12:34:21.3465 +0530").unwrap());
        assert!(report.started_at.unwrap() < report.crashed_at);
        assert_eq!(report.exception, "EXC_CRASH (SIGABRT)");
        assert_eq!(report.termination, "Abort trap: 6, abort() called");
        assert_eq!(report.thread, "main (com.apple.main-thread)");
        assert_eq!(report.frames[4].symbol, "tao::platform_impl::platform::app::send_event");
        assert_eq!(report.frames[5].symbol, "-[NSApplication _handleEvent:]");
        assert_eq!(report.frames[6].symbol, "+6");
        assert!(report.frames[4].own && !report.frames[5].own);
    }

    #[test]
    fn says_where_it_crashed_past_the_rust_runtime() {
        let report = read_mac_report(&sample_report()).unwrap();
        assert_eq!(place(&report).as_deref(), Some("tao::platform_impl::platform::app::send_event"));
    }

    #[test]
    fn only_crash_reports_of_this_program_count() {
        let header = |name: &str, kind: &str| format!(r#"{{"app_name":"{name}","bug_type":"{kind}","incident_id":"X"}}"#);
        assert_eq!(crash_incident(&header("Starkline", "309"), "Starkline").as_deref(), Some("X"));
        assert_eq!(crash_incident(&header("Starkline", "298"), "Starkline"), None);
        assert_eq!(crash_incident(&header("Safari", "309"), "Starkline"), None);
        assert_eq!(crash_incident("not json", "Starkline"), None);
    }

    fn panic_at(at: i64, thread: &str, message: &str) -> Panic {
        Panic { at, thread: thread.into(), message: message.into(), location: "src/x.rs:1:1".into(), backtrace: String::new() }
    }

    #[test]
    fn the_panic_behind_the_crash_is_the_reason() {
        let panics = [panic_at(1_000, "main", "boom"), panic_at(1_100, "main", CANNOT_UNWIND)];
        assert_eq!(reason(None, &panics, &[], 1_200), "panicked at src/x.rs:1:1: boom");
    }

    #[test]
    fn an_old_panic_isnt_blamed_for_a_later_crash() {
        let log = vec!["2026-10-09 12:34:21.215 E  Starkline[8993:9362b7] [com.apple.Foundation:general] *** Assertion failure in <private>, NSCampoLightweightUIController.m:1429".to_string()];
        let panics = [panic_at(0, "worker", "long ago"), panic_at(100_000, "main", CANNOT_UNWIND)];
        assert_eq!(reason(None, &panics, &log, 100_000), "*** Assertion failure in <private>, NSCampoLightweightUIController.m:1429");
    }

    #[test]
    fn with_nothing_else_the_reason_is_how_it_ended() {
        let report = read_mac_report(&sample_report()).unwrap();
        assert_eq!(reason(Some(&report), &[], &[], report.crashed_at), "EXC_CRASH (SIGABRT): Abort trap: 6, abort() called");
        assert_eq!(reason(None, &[panic_at(0, "main", CANNOT_UNWIND)], &[], 60_000), CANNOT_UNWIND);
    }

    #[test]
    fn only_a_main_thread_panic_ends_the_app_on_its_own() {
        assert!(panic_was_fatal(&[panic_at(0, "worker", "x"), panic_at(1, "main", "y")]));
        assert!(!panic_was_fatal(&[panic_at(0, "main", "x"), panic_at(1, "worker", "y")]));
        assert!(!panic_was_fatal(&[]));
    }

    #[test]
    fn keeps_only_the_system_logs_own_lines() {
        let output = "Timestamp               Ty Process[PID:TID]\n2026-10-09 12:34:21.215 E  Starkline[1:a] x\nFiltering the log data\n";
        assert_eq!(log_lines(output), vec!["2026-10-09 12:34:21.215 E  Starkline[1:a] x".to_string()]);
        assert_eq!(log_message("2026-10-09 12:34:21.215 E  Starkline[1:a] [sub:cat] hello"), "hello");
        assert_eq!(log_message("2026-10-09 12:34:21.215 F  Starkline[1:9a] hi"), "hi");
        assert_eq!(log_message("plain"), "plain");
    }

    #[test]
    fn writes_up_a_crash_for_people_and_agents() {
        let report = read_mac_report(&sample_report()).unwrap();
        let facts = Facts { crashed_at: report.crashed_at, started_at: report.started_at, version: "0.1.0", pid: 8993, reason: "*** Assertion failure", place: Some("tao::platform_impl::platform::app::send_event") };
        let text = write_up(&facts, Some(&report), &[panic_at(report.crashed_at, "main", CANNOT_UNWIND)], &["line one".into()]);
        assert!(text.starts_with("# Starkline crashed: 9 Oct 2026"));
        assert!(text.contains("- **What went wrong:** *** Assertion failure"));
        assert!(text.contains("- **Where:** `tao::platform_impl::platform::app::send_event`"));
        assert!(text.contains("EXC_CRASH (SIGABRT), Abort trap: 6, abort() called"));
        assert!(text.contains("- **Version:** 0.1.0 (process 8993)"));
        assert!(text.contains("- **Running for:** 1 h 25 min, since 9 Oct 11:09:04"));
        assert!(text.contains("## Crashed thread: main (com.apple.main-thread)"));
        assert!(text.contains("## Rust panics in that run"));
        assert!(text.contains("```text\nline one\n```"));
        let quiet = write_up(&facts, None, &[], &[]);
        assert!(quiet.contains("Nothing: no errors or exceptions were logged"));
        assert!(!quiet.contains(".ips"));
    }

    #[test]
    fn durations_read_naturally() {
        assert_eq!(duration(40_000), "40 s");
        assert_eq!(duration(3 * 60_000), "3 min");
        assert_eq!(duration(2 * 3_600_000), "2 h");
        assert_eq!(duration(85 * 60_000), "1 h 25 min");
    }
}
