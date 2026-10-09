//! Starkline's own crash log. While it runs, every panic is written down as it happens.
//! At the next launch, a run that crashed (macOS wrote a crash report, or a panic on the
//! main thread ended it) gets a folder in the log: what went wrong and where, written
//! up, with the reports. The app then asks whether the maintenance agent should diagnose
//! and fix it now, in a chat of its own, or keep it for later (Settings > Diagnostics).

use crate::crash_report::{self, MacReport, Panic};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// The crash log, inside the app's data folder.
pub const FOLDER: &str = "crashes";
/// Panics written down by runs (one file per run), cleared when a run quits normally.
const RUNS: &str = "runs";
const PANICS_EXT: &str = "panics";
/// When the log started watching: crashes from before then are kept without asking.
const SINCE_FILE: &str = "watching-since";
/// In each crash's folder.
const RECORD: &str = "crash.json";
const WRITE_UP: &str = "crash.md";
const MAC_REPORT: &str = "macos-report.ips";
const PANICS: &str = "panics.jsonl";
const SYSTEM_LOG: &str = "system-log.txt";
/// Crashes kept; older ones go.
const KEPT: usize = 50;
/// Crash reports older than this aren't added when the log first looks.
const BACKFILL_MS: i64 = 30 * 24 * 3_600_000;
/// macOS keeps its system log for a few days; older crashes aren't looked up in it.
const SYSTEM_LOG_REACH_MS: i64 = 3 * 24 * 3_600_000;
/// macOS may still be writing a crash report just after a relaunch: a panic with no
/// report yet is left this long before it's judged on its own.
const REPORT_GRACE: Duration = Duration::from_secs(20);
/// When the log looks again, for reports that were still being written.
const SECOND_LOOK: Duration = Duration::from_secs(30);
/// Where macOS keeps crash reports, under the home folder.
const MAC_REPORT_DIRS: [&str; 2] = ["Library/Logs/DiagnosticReports", "Library/Logs/DiagnosticReports/Retired"];
const MAC_REPORT_EXT: &str = "ips";
/// Crash reports are named after the program; this one is called Starkline.
const DEFAULT_PROCESS: &str = "Starkline";
pub const CHANGED_EVENT: &str = "crashes://changed";

/// This run's panics file, once the log is watching.
static PANICS_FILE: OnceLock<PathBuf> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum CrashStatus {
    /// Not asked about yet.
    New,
    /// The developer chose to look into it later (or it predates the log).
    Later,
    /// Handed to the maintenance agent.
    Diagnosing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Crash {
    /// Its folder: when it crashed and the process, e.g. "2026-10-09-123421-8993".
    pub id: String,
    /// Milliseconds since the epoch.
    pub crashed_at: i64,
    pub started_at: Option<i64>,
    pub version: String,
    pub pid: u32,
    /// What went wrong, in one line.
    pub reason: String,
    /// The function in Starkline's code it stopped in, when macOS's report says.
    pub place: Option<String>,
    pub status: CrashStatus,
    /// The task diagnosing it.
    pub task_id: Option<String>,
    /// macOS's id for its crash report, so a report is logged once.
    pub incident: Option<String>,
    /// Where its files are (filled in when read; saved empty).
    pub folder: String,
}

/// The crash log's folder.
pub fn root(app: &tauri::AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join(FOLDER)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Start watching: from now on every panic is written down. Call first thing in setup.
pub fn watch(root: &Path) {
    let runs = root.join(RUNS);
    if std::fs::create_dir_all(&runs).is_err() {
        eprintln!("[crash-log] couldn't create {}", runs.display());
        return;
    }
    let since = root.join(SINCE_FILE);
    if !since.exists() {
        let _ = std::fs::write(&since, now_ms().to_string());
    }
    let file = runs.join(format!("{}-{}.{PANICS_EXT}", std::process::id(), now_ms()));
    if PANICS_FILE.set(file).is_err() {
        return;
    }
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write_panic(info);
        previous(info);
    }));
}

/// Append one panic to this run's file. Runs inside the panic, so nothing here may panic.
fn write_panic(info: &std::panic::PanicHookInfo) {
    let Some(path) = PANICS_FILE.get() else { return };
    let payload = info.payload();
    let message = payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic without a message".into());
    let record = Panic {
        at: now_ms(),
        thread: std::thread::current().name().unwrap_or("unnamed").to_string(),
        message,
        location: info.location().map(|l| l.to_string()).unwrap_or_default(),
        backtrace: std::backtrace::Backtrace::force_capture().to_string(),
    };
    let Ok(line) = serde_json::to_string(&record) else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(format!("{line}\n").as_bytes());
    }
}

/// Starkline is quitting normally: whatever panicked along the way didn't end it.
pub fn clean_exit() {
    if let Some(path) = PANICS_FILE.get() {
        let _ = std::fs::remove_file(path);
    }
}

/// Look for crashes from earlier runs now, and once more shortly after.
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        look(&app);
        std::thread::sleep(SECOND_LOOK);
        look(&app);
    });
}

fn look(app: &tauri::AppHandle) {
    let root = root(app);
    let added = collect(&root, &Sources::this_mac());
    if added.is_empty() {
        return;
    }
    let _ = app.emit(CHANGED_EVENT, ());
    // The system log is slow to read; each crash's write-up is filled in as it arrives.
    for id in &added {
        if add_system_log(&root, id) {
            let _ = app.emit(CHANGED_EVENT, ());
        }
    }
    prune(&root, KEPT);
}

/// Where crash evidence comes from. Real runs use `this_mac`; tests point it elsewhere.
pub struct Sources {
    pub report_dirs: Vec<PathBuf>,
    /// The program's name, as crash reports name it.
    pub process: String,
    pub own_pid: u32,
    pub alive: fn(u32) -> bool,
    pub now: i64,
}

impl Sources {
    fn this_mac() -> Self {
        let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
        let process = std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| DEFAULT_PROCESS.into());
        Sources { report_dirs: MAC_REPORT_DIRS.iter().map(|d| home.join(d)).collect(), process, own_pid: std::process::id(), alive: process_alive, now: now_ms() }
    }
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else { return false };
    // Signal 0 checks without signalling; EPERM means it exists but isn't ours.
    unsafe { libc::kill(pid, 0) == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM) }
}

#[cfg(not(unix))]
fn process_alive(_pid: u32) -> bool {
    false
}

/// One finished run's panics file.
struct RunPanics {
    file: PathBuf,
    started_at: Option<i64>,
    panics: Vec<Panic>,
    written: Option<std::time::SystemTime>,
}

/// Add every crash not in the log yet; returns the new crashes' ids.
pub fn collect(root: &Path, sources: &Sources) -> Vec<String> {
    let records = read_all(root);
    let known: HashSet<String> = records.iter().filter_map(|c| c.incident.clone()).collect();
    let since = std::fs::read_to_string(root.join(SINCE_FILE)).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(sources.now);
    let mut runs = finished_runs(&root.join(RUNS), sources);
    let mut added = Vec::new();

    for (path, report) in mac_reports(sources, &known) {
        let run = runs.remove(&report.pid);
        if let Some(id) = record(root, since, Some((&path, &report)), run.as_ref()) {
            added.push(id);
        }
        if let Some(run) = run {
            let _ = std::fs::remove_file(&run.file);
        }
    }
    for run in runs.into_values() {
        let fresh = run.written.and_then(|t| t.elapsed().ok()).is_none_or(|age| age < REPORT_GRACE);
        if fresh {
            continue;
        }
        if crash_report::panic_was_fatal(&run.panics) {
            if let Some(id) = record(root, since, None, Some(&run)) {
                added.push(id);
            }
        }
        let _ = std::fs::remove_file(&run.file);
    }
    added
}

/// Panics files left by runs that have ended, by process id.
fn finished_runs(dir: &Path, sources: &Sources) -> HashMap<u32, RunPanics> {
    let mut runs = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else { return runs };
    for path in entries.flatten().map(|e| e.path()) {
        if path.extension().and_then(|e| e.to_str()) != Some(PANICS_EXT) {
            continue;
        }
        let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let mut parts = stem.splitn(2, '-');
        let Some(pid) = parts.next().and_then(|p| p.parse::<u32>().ok()) else { continue };
        if pid == sources.own_pid || (sources.alive)(pid) {
            continue;
        }
        let panics = crash_report::read_panics(&std::fs::read_to_string(&path).unwrap_or_default());
        let written = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
        runs.insert(pid, RunPanics { started_at: parts.next().and_then(|s| s.parse().ok()), file: path, panics, written });
    }
    runs
}

/// macOS's crash reports for this program that aren't in the log, oldest first.
fn mac_reports(sources: &Sources, known: &HashSet<String>) -> Vec<(PathBuf, MacReport)> {
    let prefix = format!("{}-", sources.process);
    let mut found: Vec<(PathBuf, MacReport)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in &sources.report_dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for path in entries.flatten().map(|e| e.path()) {
            let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            if !name.starts_with(&prefix) || path.extension().and_then(|e| e.to_str()) != Some(MAC_REPORT_EXT) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let header = text.lines().next().unwrap_or_default();
            let Some(incident) = crash_report::crash_incident(header, &sources.process) else { continue };
            if known.contains(&incident) || !seen.insert(incident) {
                continue;
            }
            match crash_report::read_mac_report(&text) {
                Some(report) if sources.now - report.crashed_at <= BACKFILL_MS => found.push((path, report)),
                _ => {}
            }
        }
    }
    found.sort_by_key(|(_, r)| r.crashed_at);
    found
}

/// Give a crash its folder: the record, the reports and a write-up. None if it's there already.
fn record(root: &Path, since: i64, report: Option<(&Path, &MacReport)>, run: Option<&RunPanics>) -> Option<String> {
    let panics: &[Panic] = run.map(|r| r.panics.as_slice()).unwrap_or_default();
    let mac = report.map(|(_, r)| r);
    let crashed_at = mac.map(|r| r.crashed_at).or_else(|| panics.last().map(|p| p.at))?;
    let pid = mac.map(|r| r.pid).or_else(|| run.and_then(|r| pid_of(&r.file)))?;
    let id = format!("{}-{pid}", local(crashed_at, "%Y-%m-%d-%H%M%S"));
    let folder = root.join(&id);
    if folder.exists() || std::fs::create_dir_all(&folder).is_err() {
        return None;
    }
    if let Some((path, _)) = report {
        let _ = std::fs::copy(path, folder.join(MAC_REPORT));
    }
    if !panics.is_empty() {
        let lines: Vec<String> = panics.iter().filter_map(|p| serde_json::to_string(p).ok()).collect();
        let _ = std::fs::write(folder.join(PANICS), lines.join("\n") + "\n");
    }
    let crash = Crash {
        id: id.clone(),
        crashed_at,
        started_at: mac.and_then(|r| r.started_at).or_else(|| run.and_then(|r| r.started_at)),
        version: mac.map(|r| r.version.clone()).filter(|v| !v.is_empty()).unwrap_or_else(|| env!("CARGO_PKG_VERSION").into()),
        pid,
        reason: crash_report::reason(mac, panics, &[], crashed_at),
        place: mac.and_then(crash_report::place),
        status: if crashed_at < since { CrashStatus::Later } else { CrashStatus::New },
        task_id: None,
        incident: mac.map(|r| r.incident.clone()).filter(|i| !i.is_empty()),
        folder: String::new(),
    };
    write_record(&folder, &crash, mac, panics, &[]);
    Some(id)
}

fn pid_of(panics_file: &Path) -> Option<u32> {
    panics_file.file_stem()?.to_string_lossy().split('-').next()?.parse().ok()
}

/// Save a crash's record and its write-up.
fn write_record(folder: &Path, crash: &Crash, report: Option<&MacReport>, panics: &[Panic], log: &[String]) {
    let facts = crash_report::Facts {
        crashed_at: crash.crashed_at,
        started_at: crash.started_at,
        version: &crash.version,
        pid: crash.pid,
        reason: &crash.reason,
        place: crash.place.as_deref(),
    };
    let _ = std::fs::write(folder.join(WRITE_UP), crash_report::write_up(&facts, report, panics, log));
    if let Ok(json) = serde_json::to_string_pretty(&Crash { folder: String::new(), ..crash.clone() }) {
        let _ = std::fs::write(folder.join(RECORD), json);
    }
}

/// Read what the system logged before the crash into its write-up, which may sharpen the
/// reason (an assertion, an uncaught exception). Returns whether anything changed.
fn add_system_log(root: &Path, id: &str) -> bool {
    let folder = root.join(id);
    let Some(mut crash) = read(root, id) else { return false };
    if folder.join(SYSTEM_LOG).exists() {
        return false;
    }
    let log = if now_ms() - crash.crashed_at <= SYSTEM_LOG_REACH_MS { crash_report::system_log(crash.pid, crash.crashed_at) } else { Vec::new() };
    let _ = std::fs::write(folder.join(SYSTEM_LOG), log.join("\n"));
    let report = std::fs::read_to_string(folder.join(MAC_REPORT)).ok().and_then(|t| crash_report::read_mac_report(&t));
    let panics = crash_report::read_panics(&std::fs::read_to_string(folder.join(PANICS)).unwrap_or_default());
    crash.reason = crash_report::reason(report.as_ref(), &panics, &log, crash.crashed_at);
    write_record(&folder, &crash, report.as_ref(), &panics, &log);
    true
}

fn local(ms: i64, format: &str) -> String {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|t| t.format(format).to_string()).unwrap_or_else(|| ms.to_string())
}

fn read(root: &Path, id: &str) -> Option<Crash> {
    // Ids are folder names the log made; anything else (a path) isn't one.
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let folder = root.join(id);
    let mut crash: Crash = serde_json::from_str(&std::fs::read_to_string(folder.join(RECORD)).ok()?).ok()?;
    crash.folder = folder.to_string_lossy().into_owned();
    Some(crash)
}

fn read_all(root: &Path) -> Vec<Crash> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut crashes: Vec<Crash> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| read(root, &e.file_name().to_string_lossy()))
        .collect();
    crashes.sort_by_key(|c| std::cmp::Reverse(c.crashed_at));
    crashes
}

fn save(root: &Path, crash: &Crash) {
    if let Ok(json) = serde_json::to_string_pretty(&Crash { folder: String::new(), ..crash.clone() }) {
        let _ = std::fs::write(root.join(&crash.id).join(RECORD), json);
    }
}

/// Keep the newest `keep` crashes.
fn prune(root: &Path, keep: usize) {
    for old in read_all(root).into_iter().skip(keep) {
        let _ = std::fs::remove_dir_all(root.join(&old.id));
    }
}

/// The crash log, newest first.
pub fn list(app: &tauri::AppHandle) -> Vec<Crash> {
    read_all(&root(app))
}

/// The developer will look into these later: the next launch doesn't ask about them.
pub fn keep_for_later(app: &tauri::AppHandle, ids: &[String]) {
    let root = root(app);
    for mut crash in ids.iter().filter_map(|id| read(&root, id)).filter(|c| c.status == CrashStatus::New) {
        crash.status = CrashStatus::Later;
        save(&root, &crash);
    }
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Hand crashes to the maintenance agent: in a chat of its own, in Starkline's code, it
/// works out what happened and fixes it. The write-ups and macOS's reports go with it.
pub fn diagnose(app: &tauri::AppHandle, ids: &[String]) -> Result<crate::ledger::Task, String> {
    let root = root(app);
    let mut crashes: Vec<Crash> = ids.iter().filter_map(|id| read(&root, id)).collect();
    if crashes.is_empty() {
        return Err("Those crashes aren't in the crash log any more.".into());
    }
    crashes.sort_by_key(|c| c.crashed_at);
    let state = app.try_state::<crate::AppState>().ok_or("Starkline isn't ready yet.")?;
    let agent = crate::maintenance_agent(&state).ok_or("There's no maintenance agent on the roster to look into it. Add one in Agents.")?;
    let code = crate::repo_root();
    if !Path::new(&code).is_dir() {
        return Err(format!("Starkline's code isn't at {code} on this Mac, so there's nowhere to fix it."));
    }
    let files = evidence(app, &crashes)?;
    let title = title_for(&crashes);
    let origin = crate::tasks::Origin { requested_by: crate::tasks::BY_DEVELOPER, title: Some(&title), note: "You asked to look into a crash" };
    let task = crate::tasks::start_in_new_chat(app, &agent, &prompt_for(&crashes), Some(code), &files, &origin);
    let task = match task {
        Ok(task) => task,
        Err(e) => {
            crate::attachments::remove(&crate::attachments::root(app), &files);
            return Err(e);
        }
    };
    for mut crash in crashes {
        crash.status = CrashStatus::Diagnosing;
        crash.task_id = Some(task.id.clone());
        save(&root, &crash);
    }
    let _ = app.emit(CHANGED_EVENT, ());
    Ok(task)
}

/// Each crash's write-up and macOS report, as files in the chat the agent can read.
fn evidence(app: &tauri::AppHandle, crashes: &[Crash]) -> Result<Vec<crate::attachments::Attachment>, String> {
    let kept = crate::attachments::root(app);
    let mut files = Vec::new();
    for crash in crashes {
        let folder = Path::new(&crash.folder);
        for (source, name) in [(WRITE_UP, format!("starkline-crash-{}.md", crash.id)), (MAC_REPORT, format!("starkline-crash-{}.ips", crash.id))] {
            if !folder.join(source).is_file() {
                continue;
            }
            match crate::attachments::store_copy_as(&kept, &folder.join(source), &name) {
                Ok(file) => files.push(file),
                Err(e) => {
                    crate::attachments::remove(&kept, &files);
                    return Err(e);
                }
            }
        }
    }
    Ok(files)
}

fn title_for(crashes: &[Crash]) -> String {
    match crashes {
        [one] => format!("Fix the crash on {}", local(one.crashed_at, "%-d %b at %H:%M")),
        many => format!("Fix {} crashes since {}", many.len(), local(many[0].crashed_at, "%-d %b")),
    }
}

/// What the maintenance agent is asked.
fn prompt_for(crashes: &[Crash]) -> String {
    let when = match crashes {
        [one] => format!("Starkline crashed on {}.", local(one.crashed_at, "%-d %b %Y at %H:%M:%S")),
        many => format!("Starkline crashed {} times.", many.len()),
    };
    let mut prompt = format!(
        "{when} Find out why and fix it properly, here in Starkline's own code.\n\n\
For each crash, the attached Markdown file says what went wrong, where, the crashed thread, any Rust panics \
and what macOS logged just before; the `.ips` file is macOS's full crash report.\n\n\
- Work out the root cause from that evidence and say what happened, plainly.\n\
- Fix the cause. If it's in a dependency or in macOS itself, make Starkline survive it rather than hide it, \
and say why that's the right place for the fix.\n\
- Check the fix builds and the relevant tests pass.\n\
- If the evidence isn't enough to be sure, say what's missing and what would catch it next time, instead of guessing.\n\n\
The crashes:\n"
    );
    for crash in crashes {
        let place = crash.place.as_deref().map(|p| format!(" (in `{p}`)")).unwrap_or_default();
        prompt.push_str(&format!("- {}: {}{place}\n", local(crash.crashed_at, "%-d %b %H:%M:%S"), crash.reason));
    }
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder per call: tests run side by side.
    fn dir(label: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let d = std::env::temp_dir().join(format!("stark-crash-log-{label}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn report_text(pid: u32, incident: &str, capture: &str) -> String {
        let header = format!(r#"{{"app_name":"Starkline","app_version":"0.1.0","bug_type":"309","name":"Starkline","incident_id":"{incident}"}}"#);
        let body = serde_json::json!({
            "pid": pid,
            "captureTime": capture,
            "procLaunch": "2026-10-09 11:09:04.7789 +0530",
            "exception": {"type": "EXC_CRASH", "signal": "SIGABRT"},
            "termination": {"indicator": "Abort trap: 6"},
            "faultingThread": 0,
            "threads": [{"name": "main", "frames": [
                {"imageIndex": 0, "imageOffset": 4, "symbol": "_RNvNtNtNtCs3SP3SOwnY46_3tao13platform_impl8platform3app10send_event"}
            ]}],
            "usedImages": [{"name": "Starkline"}]
        });
        format!("{header}\n{body}")
    }

    fn sources(reports: &Path, now: i64) -> Sources {
        Sources { report_dirs: vec![reports.to_path_buf()], process: "Starkline".into(), own_pid: 1, alive: |_| false, now }
    }

    fn crash_time() -> i64 {
        chrono::DateTime::parse_from_rfc3339("2026-10-09T12:34:21+05:30").unwrap().timestamp_millis()
    }

    #[test]
    fn a_macos_crash_report_becomes_a_new_crash_once() {
        let (root, reports) = (dir("root"), dir("reports"));
        std::fs::write(root.join(SINCE_FILE), (crash_time() - 60_000).to_string()).unwrap();
        std::fs::write(reports.join("Starkline-2026-10-09-123423.ips"), report_text(8993, "INC-1", "2026-10-09 12:34:21.3465 +0530")).unwrap();
        std::fs::write(reports.join("Safari-2026-10-09-123423.ips"), "{}\n{}").unwrap();

        let added = collect(&root, &sources(&reports, crash_time() + 60_000));
        assert_eq!(added.len(), 1);
        let crash = read(&root, &added[0]).unwrap();
        assert_eq!((crash.pid, crash.status, crash.incident.as_deref()), (8993, CrashStatus::New, Some("INC-1")));
        assert_eq!(crash.place.as_deref(), Some("tao::platform_impl::platform::app::send_event"));
        assert_eq!(crash.reason, "EXC_CRASH (SIGABRT): Abort trap: 6");
        let folder = root.join(&crash.id);
        assert!(folder.join(MAC_REPORT).is_file() && folder.join(WRITE_UP).is_file());

        // The same report isn't logged twice.
        assert!(collect(&root, &sources(&reports, crash_time() + 120_000)).is_empty());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(reports);
    }

    #[test]
    fn crashes_from_before_the_log_watched_are_kept_without_asking() {
        let (root, reports) = (dir("root"), dir("reports"));
        std::fs::write(root.join(SINCE_FILE), (crash_time() + 60_000).to_string()).unwrap();
        std::fs::write(reports.join("Starkline-a.ips"), report_text(1234, "INC-2", "2026-10-09 12:34:21.0 +0530")).unwrap();
        let added = collect(&root, &sources(&reports, crash_time() + 120_000));
        assert_eq!(read(&root, &added[0]).unwrap().status, CrashStatus::Later);
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(reports);
    }

    #[test]
    fn a_runs_panics_go_with_its_crash_report() {
        let (root, reports) = (dir("root"), dir("reports"));
        std::fs::create_dir_all(root.join(RUNS)).unwrap();
        let panic = Panic { at: crash_time() - 500, thread: "main".into(), message: "boom".into(), location: "src/chat.rs:9:1".into(), backtrace: "bt".into() };
        let panics_file = root.join(RUNS).join(format!("8993-{}.{PANICS_EXT}", crash_time() - 3_600_000));
        std::fs::write(&panics_file, serde_json::to_string(&panic).unwrap() + "\n").unwrap();
        std::fs::write(reports.join("Starkline-b.ips"), report_text(8993, "INC-3", "2026-10-09 12:34:21.0 +0530")).unwrap();

        let added = collect(&root, &sources(&reports, crash_time() + 60_000));
        let crash = read(&root, &added[0]).unwrap();
        assert_eq!(crash.reason, "panicked at src/chat.rs:9:1: boom");
        assert!(root.join(&crash.id).join(PANICS).is_file());
        assert!(!panics_file.exists(), "the run's panics were taken into the crash");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(reports);
    }

    #[test]
    fn a_panic_off_the_main_thread_with_no_report_isnt_a_crash() {
        let (root, reports) = (dir("root"), dir("reports"));
        let runs = root.join(RUNS);
        std::fs::create_dir_all(&runs).unwrap();
        let worker = Panic { at: 1, thread: "worker".into(), message: "x".into(), location: String::new(), backtrace: String::new() };
        let main = Panic { thread: "main".into(), ..worker.clone() };
        let quiet = runs.join(format!("700-1.{PANICS_EXT}"));
        let fatal = runs.join(format!("701-1.{PANICS_EXT}"));
        std::fs::write(&quiet, serde_json::to_string(&worker).unwrap()).unwrap();
        std::fs::write(&fatal, serde_json::to_string(&main).unwrap()).unwrap();
        // Written long enough ago that macOS would have written its report by now.
        let old = std::time::SystemTime::now() - Duration::from_secs(3_600);
        for f in [&quiet, &fatal] {
            std::fs::File::options().write(true).open(f).unwrap().set_modified(old).unwrap();
        }

        let added = collect(&root, &sources(&reports, now_ms()));
        assert_eq!(added.len(), 1);
        assert_eq!(read(&root, &added[0]).unwrap().pid, 701);
        assert!(!quiet.exists() && !fatal.exists());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(reports);
    }

    #[test]
    fn a_running_instances_panics_are_left_alone() {
        let (root, reports) = (dir("root"), dir("reports"));
        let runs = root.join(RUNS);
        std::fs::create_dir_all(&runs).unwrap();
        let file = runs.join(format!("42-1.{PANICS_EXT}"));
        std::fs::write(&file, "{}").unwrap();
        let alive = Sources { alive: |_| true, ..sources(&reports, now_ms()) };
        assert!(collect(&root, &alive).is_empty());
        assert!(file.exists());
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(reports);
    }

    #[test]
    fn keeps_only_the_newest_crashes() {
        let root = dir("root");
        for (i, id) in ["a", "b", "c"].iter().enumerate() {
            std::fs::create_dir_all(root.join(id)).unwrap();
            let crash = Crash { id: id.to_string(), crashed_at: i as i64, started_at: None, version: "0".into(), pid: 1, reason: String::new(), place: None, status: CrashStatus::Later, task_id: None, incident: None, folder: String::new() };
            save(&root, &crash);
        }
        prune(&root, 2);
        let left: Vec<String> = read_all(&root).into_iter().map(|c| c.id).collect();
        assert_eq!(left, vec!["c", "b"]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_crash_id_cant_reach_outside_the_log() {
        let root = dir("root");
        assert!(read(&root, "../x").is_none());
        assert!(read(&root, "a/b").is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    /// This Mac's own Starkline crash reports, read into a scratch log with the system log.
    /// `cargo test live_crash_reports -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_crash_reports() {
        let root = dir("live");
        let mac = Sources { process: DEFAULT_PROCESS.into(), ..Sources::this_mac() };
        let added = collect(&root, &mac);
        for id in &added {
            add_system_log(&root, id);
            let crash = read(&root, id).unwrap();
            println!("{} pid {} {:?}\n  reason: {}\n  place: {:?}", crash.id, crash.pid, crash.status, crash.reason, crash.place);
        }
        if let Some(id) = added.last() {
            println!("\n{}", std::fs::read_to_string(root.join(id).join(WRITE_UP)).unwrap());
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn asks_the_maintenance_agent_about_each_crash() {
        let crash = |at: i64, reason: &str| Crash { id: "x".into(), crashed_at: at, started_at: None, version: "0.1.0".into(), pid: 1, reason: reason.into(), place: Some("tao::send_event".into()), status: CrashStatus::New, task_id: None, incident: None, folder: String::new() };
        let one = prompt_for(&[crash(crash_time(), "*** Assertion failure")]);
        assert!(one.starts_with("Starkline crashed on 9 Oct 2026 at 12:34:21."));
        assert!(one.contains("- 9 Oct 12:34:21: *** Assertion failure (in `tao::send_event`)"));
        let three = prompt_for(&[crash(crash_time(), "a"), crash(crash_time() + 1, "b"), crash(crash_time() + 2, "c")]);
        assert!(three.starts_with("Starkline crashed 3 times."));
        assert_eq!(title_for(&[crash(crash_time(), "a")]), "Fix the crash on 9 Oct at 12:34");
        assert_eq!(title_for(&[crash(crash_time(), "a"), crash(crash_time() + 1, "b")]), "Fix 2 crashes since 9 Oct");
    }
}
