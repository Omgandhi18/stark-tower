//! How much of each subscription's usage limit is left: Claude's 5-hour and
//! weekly windows (and any weekly limit of its own a model has), and Codex's.
//!
//! The numbers come from the CLIs themselves, never from their credentials:
//! - Claude Code's `/usage`, run headless (`claude -p /usage`). It's a local
//!   command: no model call, no tokens. The CLI asks Anthropic with its own sign-in.
//! - The `rate_limit_event` Claude Code streams with every turn (5-hour and weekly).
//! - Codex's app server: `account/rateLimits/read`, and the
//!   `account/rateLimits/updated` it sends a live chat after each turn.
//!
//! A reading is kept in memory only; nothing here is saved.

use chrono::{DateTime, Datelike, Local, NaiveDate, NaiveTime, TimeZone};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// `claude -p /usage` takes a few seconds; one that hangs is given up on.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// The shortest gap between two reads of the same provider, however often they're asked for.
const MIN_GAP: Duration = Duration::from_secs(20);
const CLAUDE: &str = "claude";
const CODEX: &str = "codex";

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct LimitWindow {
    /// Stable key: "five_hour", "seven_day", "seven_day:fable", "codex:primary".
    pub id: String,
    pub label: String,
    pub used_percent: f64,
    /// When the window resets, in Unix milliseconds.
    pub resets_at: Option<i64>,
    /// The CLI's own words for the reset, when the time couldn't be read.
    pub resets_text: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
pub struct ProviderLimits {
    /// "claude" | "codex".
    pub provider: String,
    pub name: String,
    /// The plan the provider reports ("ChatGPT Plus"), when it says.
    pub plan: Option<String>,
    pub windows: Vec<LimitWindow>,
    /// Why there are no numbers, or why the ones shown couldn't be refreshed.
    pub unavailable: Option<String>,
    /// The provider says a limit has been reached.
    pub limited: bool,
    /// When the numbers shown were read, in Unix milliseconds.
    pub updated_at: Option<i64>,
    /// A read is under way.
    pub checking: bool,
}

#[derive(Clone, Debug, Default, Serialize, specta::Type)]
pub struct UsageLimits {
    pub providers: Vec<ProviderLimits>,
}

impl ProviderLimits {
    fn empty(provider: &str) -> Self {
        Self {
            provider: provider.into(),
            name: if provider == CLAUDE { "Claude" } else { "Codex" }.into(),
            plan: None,
            windows: vec![],
            unavailable: None,
            limited: false,
            updated_at: None,
            checking: false,
        }
    }

    /// Add or replace windows by id, keeping their order.
    fn merge(&mut self, windows: Vec<LimitWindow>) {
        for w in windows {
            match self.windows.iter_mut().find(|old| old.id == w.id) {
                Some(old) => *old = w,
                None => self.windows.push(w),
            }
        }
    }
}

/// What a read found: a definite answer (numbers, or the CLI saying it has none) or a failure.
#[derive(Debug, PartialEq)]
enum Reading {
    Found { windows: Vec<LimitWindow>, plan: Option<String>, limited: bool },
    /// The CLI answered but has no limits to show (an API key, say), in its words.
    None(String),
}

#[derive(Default)]
struct Entry {
    limits: Option<ProviderLimits>,
    asked: Option<Instant>,
    asking: bool,
}

fn entries() -> &'static Mutex<HashMap<String, Entry>> {
    static ENTRIES: std::sync::OnceLock<Mutex<HashMap<String, Entry>>> = std::sync::OnceLock::new();
    ENTRIES.get_or_init(Default::default)
}

fn now_ms() -> i64 {
    Local::now().timestamp_millis()
}

/// The providers turned on in Settings: an enabled Claude Code or Codex engine, preferring
/// the one an enabled agent runs on when there are several.
fn targets(app: &tauri::AppHandle) -> Vec<(String, crate::config::EngineConfig)> {
    let Some(state) = app.try_state::<crate::AppState>() else { return vec![] };
    let config = state.config.lock().unwrap().clone();
    let mut found: Vec<(String, crate::config::EngineConfig)> = vec![];
    for (kind, provider) in [("claude-code", CLAUDE), ("codex", CODEX)] {
        let mut engines = config.engines.iter().filter(|e| e.enabled && e.kind == kind);
        let used = |e: &&crate::config::EngineConfig| config.agents.iter().any(|a| a.enabled && a.engine == e.id);
        let engine = engines.clone().find(used).or_else(|| engines.next());
        if let Some(engine) = engine {
            let mut engine = engine.clone();
            crate::secrets::hydrate(&state.secrets.lock().unwrap(), &mut engine);
            found.push((provider.into(), engine));
        }
    }
    found
}

/// The limits of every provider in use, as last read. A provider whose reading is older
/// than `max_age` is read again in the background; `limits://changed` says when it's in.
pub fn snapshot(app: &tauri::AppHandle, max_age: Duration) -> UsageLimits {
    let targets = targets(app);
    let mut entries = entries().lock().unwrap();
    let mut providers = vec![];
    for (provider, engine) in targets {
        let entry = entries.entry(provider.clone()).or_default();
        let stale = entry.asked.is_none_or(|at| at.elapsed() >= max_age.max(MIN_GAP));
        if stale && !entry.asking {
            entry.asking = true;
            entry.asked = Some(Instant::now());
            let (app, provider) = (app.clone(), provider.clone());
            std::thread::spawn(move || {
                let reading = read(&provider, &engine);
                settle(&app, &provider, reading);
            });
        }
        let mut limits = entry.limits.clone().unwrap_or_else(|| ProviderLimits::empty(&provider));
        limits.checking = entry.asking;
        providers.push(limits);
    }
    UsageLimits { providers }
}

fn settle(app: &tauri::AppHandle, provider: &str, reading: Result<Reading, String>) {
    {
        let mut entries = entries().lock().unwrap();
        let entry = entries.entry(provider.into()).or_default();
        entry.asking = false;
        let limits = entry.limits.get_or_insert_with(|| ProviderLimits::empty(provider));
        match reading {
            Ok(Reading::Found { windows, plan, limited }) => {
                limits.windows = windows;
                limits.plan = plan.or(limits.plan.take());
                limits.limited = limited;
                limits.unavailable = None;
                limits.updated_at = Some(now_ms());
            }
            Ok(Reading::None(why)) => {
                limits.windows.clear();
                limits.limited = false;
                limits.unavailable = Some(why);
                limits.updated_at = Some(now_ms());
            }
            // Numbers already read stay, with the reason they couldn't be refreshed.
            Err(why) => limits.unavailable = Some(why),
        }
    }
    let _ = app.emit("limits://changed", ());
}

/// A reading that arrived on its own (a turn's event): it's merged in, and counts as a fresh read.
fn arrived(app: &tauri::AppHandle, provider: &str, update: impl FnOnce(&mut ProviderLimits)) {
    {
        let mut entries = entries().lock().unwrap();
        let entry = entries.entry(provider.into()).or_default();
        let limits = entry.limits.get_or_insert_with(|| ProviderLimits::empty(provider));
        update(limits);
        limits.unavailable = None;
        limits.updated_at = Some(now_ms());
    }
    let _ = app.emit("limits://changed", ());
}

fn read(provider: &str, engine: &crate::config::EngineConfig) -> Result<Reading, String> {
    let name = if provider == CLAUDE { "Claude Code" } else { "Codex" };
    let program = crate::chat::resolve_program(&engine.command).ok_or_else(|| format!("{name} isn't installed on this Mac."))?;
    if provider == CLAUDE {
        let mut cmd = Command::new(&program);
        cmd.args(["-p", "/usage", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config"]);
        engine_env(&mut cmd, &program, engine);
        parse_claude_usage(&run(cmd)?)
    } else {
        read_codex(&program, engine).map(|reply| codex_reading(&reply))
    }
}

/// The engine's environment, as its agents get it: its sign-in variables, and a PATH
/// that finds the CLI's own runtime (Codex is a Node script).
fn engine_env(cmd: &mut Command, program: &str, engine: &crate::config::EngineConfig) {
    let own = std::path::Path::new(program).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    let path = format!("{own}:{}", crate::shellenv::child_path());
    cmd.env("PATH", path).current_dir(std::env::temp_dir());
    for (k, v) in &engine.auth.env {
        if !v.trim().is_empty() && v != crate::secrets::SENTINEL {
            cmd.env(k, v);
        }
    }
}

/// Run a CLI to the end, or give up after a while. Its output, or why there's none.
fn run(mut cmd: Command) -> Result<String, String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("Claude Code couldn't start: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("Claude Code has no output stream.")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = tx.send(text);
    });
    let out = rx.recv_timeout(READ_TIMEOUT);
    crate::proc::kill_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
    out.map_err(|_| "Claude Code didn't answer in time.".to_string())
}

/// `claude -p /usage --output-format json`: a result whose text has a line per window,
/// "Current session: 27% used · resets Oct 10 at 2:19pm (Asia/Calcutta)".
fn parse_claude_usage(out: &str) -> Result<Reading, String> {
    parse_claude_usage_at(out, Local::now())
}

fn parse_claude_usage_at(out: &str, now: DateTime<Local>) -> Result<Reading, String> {
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| "Claude Code's usage couldn't be read.".to_string())?;
    let text = v.get("result").and_then(Value::as_str).unwrap_or("").trim();
    if v.get("is_error").and_then(Value::as_bool) == Some(true) {
        return Err(first_line(text).unwrap_or("Claude Code couldn't check usage.").to_string());
    }
    let windows: Vec<LimitWindow> = text.lines().filter_map(|line| claude_window(line.trim(), now)).collect();
    if windows.is_empty() {
        return Ok(Reading::None(first_line(text).unwrap_or("Claude Code didn't report any usage limits.").to_string()));
    }
    let limited = windows.iter().any(|w| w.used_percent >= 100.0);
    Ok(Reading::Found { windows, plan: None, limited })
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|l| !l.is_empty())
}

fn claude_window(line: &str, now: DateTime<Local>) -> Option<LimitWindow> {
    let rest = line.strip_prefix("Current ")?;
    let (name, detail) = rest.split_once(':')?;
    let (percent, after) = detail.trim().split_once("% used")?;
    let used_percent: f64 = percent.trim().parse().ok()?;
    let reset = after.split_once("resets ").map(|(_, r)| r.trim().to_string()).filter(|r| !r.is_empty());
    let name = name.trim();
    let (id, label) = if name == "session" {
        ("five_hour".to_string(), "5-hour session".to_string())
    } else if let Some(scope) = name.strip_prefix("week") {
        match scope.trim().trim_start_matches('(').trim_end_matches(')').trim() {
            "" | "all models" => ("seven_day".to_string(), "Weekly · all models".to_string()),
            model => (format!("seven_day:{}", model.to_lowercase()), format!("Weekly · {model}")),
        }
    } else {
        (name.to_lowercase().replace(' ', "_"), capitalize(name))
    };
    let resets_at = reset.as_deref().and_then(|r| parse_reset(r, now));
    Some(LimitWindow { id, label, used_percent, resets_at, resets_text: reset.filter(|_| resets_at.is_none()) })
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
}

/// "Oct 10 at 2:19pm (Asia/Calcutta)", "Oct 10, 2026 at 2pm" or "2:19pm": the CLI
/// writes it in this Mac's time zone (it runs with Starkline's environment).
fn parse_reset(text: &str, now: DateTime<Local>) -> Option<i64> {
    let text = text.split(" (").next()?.trim();
    let (date, time) = match text.split_once(" at ") {
        Some((d, t)) => (Some(d.trim()), t.trim()),
        None => (None, text),
    };
    let time = parse_time(time)?;
    let at = match date {
        Some(d) => {
            let (month_day, year) = match d.split_once(',') {
                Some((md, y)) => (md.trim(), Some(y.trim().parse::<i32>().ok()?)),
                None => (d, None),
            };
            let (month, day) = month_day.split_once(' ')?;
            let month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
                .iter()
                .position(|m| month.to_lowercase().starts_with(m))? as u32
                + 1;
            let day: u32 = day.trim().parse().ok()?;
            let years = year.map(|y| vec![y]).unwrap_or_else(|| vec![now.year() - 1, now.year(), now.year() + 1]);
            years
                .into_iter()
                .filter_map(|y| NaiveDate::from_ymd_opt(y, month, day))
                .filter_map(|d| Local.from_local_datetime(&d.and_time(time)).earliest())
                .min_by_key(|t| (t.timestamp() - now.timestamp()).abs())?
        }
        None => {
            let today = Local.from_local_datetime(&now.date_naive().and_time(time)).earliest()?;
            if today < now - chrono::Duration::minutes(1) {
                Local.from_local_datetime(&(now.date_naive() + chrono::Duration::days(1)).and_time(time)).earliest()?
            } else {
                today
            }
        }
    };
    Some(at.timestamp_millis())
}

/// "2:19pm", "2pm", "14:19".
fn parse_time(text: &str) -> Option<NaiveTime> {
    let t = text.trim().to_lowercase();
    let (clock, pm) = match (t.strip_suffix("pm"), t.strip_suffix("am")) {
        (Some(c), _) => (c.trim(), Some(true)),
        (_, Some(c)) => (c.trim(), Some(false)),
        _ => (t.as_str(), None),
    };
    let (h, m) = match clock.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (clock.parse::<u32>().ok()?, 0),
    };
    let h = match pm {
        Some(true) if h < 12 => h + 12,
        Some(false) if h == 12 => 0,
        _ => h,
    };
    NaiveTime::from_hms_opt(h, m, 0)
}

/// A turn's `rate_limit_event`: utilization 0–1, times in Unix seconds.
fn claude_event_windows(info: &Value) -> Vec<LimitWindow> {
    let window = |id: &str, label: &str, w: &Value| -> Option<LimitWindow> {
        Some(LimitWindow {
            id: id.into(),
            label: label.into(),
            used_percent: (w.get("utilization")?.as_f64()? * 100.0).round(),
            resets_at: w.get("resetsAt").and_then(Value::as_i64).map(|s| s * 1000),
            resets_text: None,
        })
    };
    let mut windows = vec![];
    if let Some(unified) = info.get("unifiedWindows") {
        windows.extend(unified.get("five_hour").and_then(|w| window("five_hour", "5-hour session", w)));
        windows.extend(unified.get("seven_day").and_then(|w| window("seven_day", "Weekly · all models", w)));
    }
    // The window that binds now, when it isn't one of those two (a model's own weekly limit).
    let binding = info.get("rateLimitType").and_then(Value::as_str).unwrap_or("");
    let own = match binding {
        "five_hour" if windows.is_empty() => Some(("five_hour".to_string(), "5-hour session".to_string())),
        "seven_day" if windows.is_empty() => Some(("seven_day".to_string(), "Weekly · all models".to_string())),
        t => t.strip_prefix("seven_day_").filter(|m| matches!(*m, "opus" | "sonnet")).map(|m| (format!("seven_day:{m}"), format!("Weekly · {}", capitalize(m)))),
    };
    if let Some((id, label)) = own {
        windows.extend(window(&id, &label, info));
    }
    windows
}

/// Claude Code streamed a `rate_limit_event` during a turn.
pub(crate) fn claude_event(app: &tauri::AppHandle, v: &Value) {
    let Some(info) = v.get("rate_limit_info") else { return };
    let windows = claude_event_windows(info);
    if windows.is_empty() {
        return;
    }
    let limited = info.get("status").and_then(Value::as_str) == Some("rejected");
    arrived(app, CLAUDE, |limits| {
        limits.merge(windows);
        limits.limited = limited;
    });
}

fn read_codex(program: &str, engine: &crate::config::EngineConfig) -> Result<Value, String> {
    let mut cmd = Command::new(program);
    // Its own process group, so stopping it also stops the native binary an npm install starts.
    cmd.arg("app-server").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).process_group(0);
    engine_env(&mut cmd, program, engine);
    let mut child = cmd.spawn().map_err(|e| format!("Codex couldn't start: {e}"))?;
    let rpc = Arc::new(crate::rpc::Rpc::new(child.stdin.take().ok_or("Codex has no input stream.")?));
    let stdout = child.stdout.take().ok_or("Codex has no output stream.")?;
    {
        let rpc = rpc.clone();
        std::thread::spawn(move || crate::rpc::pump(stdout, &rpc, |_| {}));
    }
    let reply = (|| {
        let info = json!({ "clientInfo": { "name": "starkline", "title": "Starkline", "version": env!("CARGO_PKG_VERSION") }, "capabilities": null });
        rpc.request("initialize", info, READ_TIMEOUT)?;
        rpc.notify("initialized", Value::Null)?;
        let account = rpc.request("account/read", json!({}), READ_TIMEOUT)?;
        if account.get("account").is_none_or(Value::is_null) {
            return Err("Codex isn't signed in with ChatGPT, so it has no plan limits to show.".to_string());
        }
        rpc.request("account/rateLimits/read", Value::Null, READ_TIMEOUT)
    })();
    crate::proc::kill_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
    reply
}

/// How long a Codex window is, as people say it.
fn window_label(minutes: Option<i64>) -> String {
    match minutes {
        Some(10_080) => "Weekly".into(),
        Some(m) if m > 0 && m % 1_440 == 0 => format!("{}-day", m / 1_440),
        Some(m) if m > 0 && m % 60 == 0 => format!("{}-hour", m / 60),
        Some(m) if m > 0 => format!("{m}-minute"),
        _ => "Usage".into(),
    }
}

fn plan_name(plan: &str) -> Option<String> {
    let name = match plan {
        "" | "unknown" => return None,
        "prolite" => "Pro Lite".to_string(),
        other => other.split('_').map(capitalize).collect::<Vec<_>>().join(" "),
    };
    Some(format!("ChatGPT {name}"))
}

/// One Codex limit's windows. Missing windows are left out (a rolling update is sparse).
fn codex_windows(snapshot: &Value) -> Vec<LimitWindow> {
    let limit = snapshot.get("limitId").and_then(Value::as_str).unwrap_or(CODEX);
    let name = snapshot.get("limitName").and_then(Value::as_str).filter(|n| !n.trim().is_empty());
    ["primary", "secondary"]
        .iter()
        .filter_map(|slot| {
            let w = snapshot.get(*slot).filter(|w| !w.is_null())?;
            let label = window_label(w.get("windowDurationMins").and_then(Value::as_i64));
            Some(LimitWindow {
                id: format!("{limit}:{slot}"),
                label: name.map(|n| format!("{n} · {label}")).unwrap_or(label),
                used_percent: w.get("usedPercent").and_then(Value::as_f64)?,
                resets_at: w.get("resetsAt").and_then(Value::as_i64).map(|s| s * 1000),
                resets_text: None,
            })
        })
        .collect()
}

fn codex_reached(snapshot: &Value) -> bool {
    snapshot.get("rateLimitReachedType").is_some_and(|t| !t.is_null())
}

/// `account/rateLimits/read`: every limit by id when Codex lists them, else the one.
fn codex_reading(reply: &Value) -> Reading {
    let snapshots: Vec<&Value> = match reply.get("rateLimitsByLimitId").and_then(Value::as_object) {
        Some(by_id) if !by_id.is_empty() => by_id.values().collect(),
        _ => reply.get("rateLimits").into_iter().collect(),
    };
    let windows: Vec<LimitWindow> = snapshots.iter().flat_map(|s| codex_windows(s)).collect();
    let plan = snapshots.iter().find_map(|s| s.get("planType").and_then(Value::as_str)).and_then(plan_name);
    if windows.is_empty() {
        return Reading::None("Codex didn't report any usage limits for this account.".into());
    }
    Reading::Found { windows, plan, limited: snapshots.iter().any(|s| codex_reached(s)) }
}

/// A live Codex chat sent `account/rateLimits/updated`: merged into the last reading.
pub(crate) fn codex_updated(app: &tauri::AppHandle, params: &Value) {
    let Some(snapshot) = params.get("rateLimits") else { return };
    let windows = codex_windows(snapshot);
    let plan = snapshot.get("planType").and_then(Value::as_str).and_then(plan_name);
    if windows.is_empty() && plan.is_none() {
        return;
    }
    let limited = codex_reached(snapshot);
    arrived(app, CODEX, |limits| {
        limits.merge(windows);
        limits.plan = plan.or(limits.plan.take());
        limits.limited = limited;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    const USAGE: &str = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0,"local_command":"usage","result":"You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 27% used · resets Oct 10 at 2:19pm (Asia/Calcutta)\nCurrent week (all models): 87% used · resets Oct 11 at 4:29am (Asia/Calcutta)\nCurrent week (Fable): 0% used · resets Oct 11 at 4:30am (Asia/Calcutta)\n\nWhat's contributing to your limits usage?\nLast 24h · 1690 requests · 20 sessions\n  93% of your usage was at >150k context"}"#;

    #[test]
    fn reads_claude_usage_windows_and_their_resets() {
        let now = at(2026, 10, 10, 12, 0);
        let Ok(Reading::Found { windows, limited, .. }) = parse_claude_usage_at(USAGE, now) else { panic!("no reading") };
        assert!(!limited);
        let ids: Vec<_> = windows.iter().map(|w| (w.id.as_str(), w.label.as_str(), w.used_percent)).collect();
        assert_eq!(
            ids,
            vec![("five_hour", "5-hour session", 27.0), ("seven_day", "Weekly · all models", 87.0), ("seven_day:fable", "Weekly · Fable", 0.0)]
        );
        assert_eq!(windows[0].resets_at, Some(at(2026, 10, 10, 14, 19).timestamp_millis()));
        assert_eq!(windows[1].resets_at, Some(at(2026, 10, 11, 4, 29).timestamp_millis()));
        assert!(windows.iter().all(|w| w.resets_text.is_none()));
    }

    #[test]
    fn claude_without_limits_or_failing_says_why() {
        let api = r#"{"is_error":false,"result":"/usage is only available for subscription plans."}"#;
        assert_eq!(parse_claude_usage(api), Ok(Reading::None("/usage is only available for subscription plans.".into())));
        let failed = r#"{"is_error":true,"result":"Not logged in · Please run /login"}"#;
        assert_eq!(parse_claude_usage(failed), Err("Not logged in · Please run /login".into()));
        assert!(parse_claude_usage("not json").is_err());
    }

    #[test]
    fn reset_times_read_in_local_time_with_the_nearest_year() {
        let now = at(2026, 12, 30, 22, 0);
        assert_eq!(parse_reset("Jan 2 at 4am (Asia/Calcutta)", now), Some(at(2027, 1, 2, 4, 0).timestamp_millis()));
        assert_eq!(parse_reset("Dec 31, 2026 at 12:05am", now), Some(at(2026, 12, 31, 0, 5).timestamp_millis()));
        assert_eq!(parse_reset("12pm", now), Some(at(2026, 12, 31, 12, 0).timestamp_millis()));
        assert_eq!(parse_reset("23:15", now), Some(at(2026, 12, 30, 23, 15).timestamp_millis()));
        assert_eq!(parse_reset("soon", now), None);
        // A time it can't read keeps the CLI's words.
        let line = claude_window("Current session: 5% used · resets shortly", now).unwrap();
        assert_eq!((line.resets_at, line.resets_text.as_deref()), (None, Some("shortly")));
    }

    #[test]
    fn a_turns_rate_limit_event_gives_both_windows_and_a_models_own() {
        let info = json!({"status":"allowed_warning","resetsAt":1791673200,"rateLimitType":"seven_day","utilization":0.86,"unifiedWindows":{"five_hour":{"utilization":0.23,"resetsAt":1791622200},"seven_day":{"utilization":0.86,"resetsAt":1791673200}}});
        let windows = claude_event_windows(&info);
        assert_eq!(windows.len(), 2);
        assert_eq!((windows[0].id.as_str(), windows[0].used_percent, windows[0].resets_at), ("five_hour", 23.0, Some(1_791_622_200_000)));
        assert_eq!((windows[1].id.as_str(), windows[1].used_percent), ("seven_day", 86.0));
        let opus = json!({"status":"rejected","resetsAt":1791673200,"rateLimitType":"seven_day_opus","utilization":1.0});
        let windows = claude_event_windows(&opus);
        assert_eq!((windows[0].id.as_str(), windows[0].label.as_str(), windows[0].used_percent), ("seven_day:opus", "Weekly · Opus", 100.0));
    }

    #[test]
    fn codex_limits_are_named_by_their_length_and_plan() {
        let reply = json!({"rateLimits":{"limitId":"codex","primary":{"usedPercent":0,"windowDurationMins":43200,"resetsAt":1794205785},"secondary":null,"planType":"free","rateLimitReachedType":null},
            "rateLimitsByLimitId":{"codex":{"limitId":"codex","limitName":null,"primary":{"usedPercent":12,"windowDurationMins":300,"resetsAt":1794205785},"secondary":{"usedPercent":40,"windowDurationMins":10080,"resetsAt":1794600000},"planType":"plus","rateLimitReachedType":null}}});
        let Reading::Found { windows, plan, limited } = codex_reading(&reply) else { panic!("no reading") };
        assert_eq!(plan.as_deref(), Some("ChatGPT Plus"));
        assert!(!limited);
        assert_eq!(
            windows.iter().map(|w| (w.id.as_str(), w.label.as_str(), w.used_percent)).collect::<Vec<_>>(),
            vec![("codex:primary", "5-hour", 12.0), ("codex:secondary", "Weekly", 40.0)]
        );
        assert_eq!(windows[1].resets_at, Some(1_794_600_000_000));
        assert_eq!(window_label(Some(43_200)), "30-day");
        assert_eq!(plan_name("self_serve_business_prolite").as_deref(), Some("ChatGPT Self Serve Business Prolite"));
        assert_eq!(codex_reading(&json!({"rateLimits":{"primary":null}})), Reading::None("Codex didn't report any usage limits for this account.".into()));
    }

    #[test]
    fn rolling_updates_merge_and_keep_what_they_leave_out() {
        let mut limits = ProviderLimits::empty(CODEX);
        limits.merge(codex_windows(&json!({"limitId":"codex","primary":{"usedPercent":10,"windowDurationMins":300},"secondary":{"usedPercent":30,"windowDurationMins":10080}})));
        limits.merge(codex_windows(&json!({"limitId":"codex","primary":{"usedPercent":15,"windowDurationMins":300},"secondary":null})));
        assert_eq!(limits.windows.iter().map(|w| w.used_percent).collect::<Vec<_>>(), vec![15.0, 30.0]);
        assert!(codex_reached(&json!({"rateLimitReachedType":"rate_limit_reached"})));
    }

    /// Reads the real CLIs on this Mac. `cargo test live_usage_limits -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_usage_limits() {
        let engines = crate::config::default_config().engines;
        for (provider, kind) in [(CLAUDE, "claude-code"), (CODEX, "codex")] {
            let mut engine = engines.iter().find(|e| e.kind == kind).unwrap().clone();
            // CODEX_COMMAND=/path/to/codex when it isn't on the login shell's PATH (nvm).
            if let (CODEX, Ok(command)) = (provider, std::env::var("CODEX_COMMAND")) {
                engine.command = command;
            }
            let engine = &engine;
            println!("{provider}: {:?}", read(provider, engine));
        }
    }
}
