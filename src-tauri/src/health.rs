//! What the agent runtime can actually do right now, for the shell's status
//! indicator and Diagnostics: which provider CLIs are installed (their versions,
//! and whether they're signed in), and whether the data store and the agent
//! bridge are up. CLIs are asked off the main thread, so a health check never
//! waits on one.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;

/// Set once the agent bridge socket is listening.
static BRIDGE_UP: AtomicBool = AtomicBool::new(false);
/// Why the bridge couldn't start, when it couldn't.
static BRIDGE_ERROR: Mutex<Option<String>> = Mutex::new(None);
/// A CLI that doesn't answer within this is reported without the answer.
const PROBE_TIMEOUT: Duration = Duration::from_secs(4);
/// Sign-in can change while Starkline runs (the developer signs in in Terminal).
const SIGN_IN_TTL: Duration = Duration::from_secs(30);

pub fn set_bridge_up(up: bool) {
    BRIDGE_UP.store(up, Ordering::Relaxed);
    if up {
        *BRIDGE_ERROR.lock().unwrap() = None;
    }
}

/// The bridge couldn't start, and why.
pub fn set_bridge_failed(reason: String) {
    BRIDGE_UP.store(false, Ordering::Relaxed);
    *BRIDGE_ERROR.lock().unwrap() = Some(reason);
}

pub fn bridge_error() -> Option<String> {
    BRIDGE_ERROR.lock().unwrap().clone()
}

pub fn bridge_up() -> bool {
    BRIDGE_UP.load(Ordering::Relaxed)
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EngineHealth {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub enabled: bool,
    /// The CLI was found on this Mac.
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Whether the CLI has credentials, as it reports itself; None until it has answered.
    pub sign_in: Option<SignIn>,
}

/// A provider CLI's own account of whether it can reach its models.
#[derive(Clone, Debug, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SignIn {
    pub signed_in: bool,
    /// How ("ChatGPT", "API key", "7 credentials"), when the CLI says.
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    /// Where agent sessions run. "app": inside this window's process, so they
    /// end when Starkline quits (until the standalone supervisor ships).
    pub host: String,
    pub engines: Vec<EngineHealth>,
    /// The local database answers queries.
    pub data_store: bool,
    /// The socket agents use to delegate, ask and request approval is listening.
    pub bridge: bool,
    /// Why the bridge couldn't start, when it couldn't.
    pub bridge_error: Option<String>,
    /// Provider sessions running right now.
    pub live_sessions: u32,
    /// Node.js, which runs the bridge every agent uses to delegate, ask and get
    /// approval: its version, or None when it isn't installed.
    pub node: Option<String>,
    pub node_path: Option<String>,
    /// Agent sessions keep running with the window closed.
    pub background: bool,
}

/// Where Starkline's bridge scripts live: bundled with the app, or in the
/// source tree for development builds.
#[derive(Clone, Debug)]
pub struct BridgeScripts {
    pub mcp: String,
    pub hook: String,
    /// The folder holding both, which agents may never change.
    pub dir: String,
}

impl BridgeScripts {
    pub fn resolve(app: &tauri::AppHandle) -> BridgeScripts {
        use tauri::Manager;
        let bundled = app
            .path()
            .resolve("mcp", tauri::path::BaseDirectory::Resource)
            .ok()
            .filter(|dir| dir.join("delegate-mcp.mjs").is_file() && dir.join("gate-hook.mjs").is_file());
        let dir = bundled.unwrap_or_else(|| std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/mcp")));
        BridgeScripts {
            mcp: dir.join("delegate-mcp.mjs").to_string_lossy().to_string(),
            hook: dir.join("gate-hook.mjs").to_string_lossy().to_string(),
            dir: dir.to_string_lossy().to_string(),
        }
    }
}

/// What installed CLIs said about themselves: versions (once per launch) and
/// sign-in (refreshed now and then). A question not yet answered is asked on a
/// background thread; the answer arrives with a `health://changed` event.
#[derive(Clone, Default)]
pub struct Probes(Arc<Mutex<ProbeState>>);

#[derive(Default)]
struct ProbeState {
    /// Each CLI's version, and when it was asked (a CLI that didn't answer is asked again later).
    versions: HashMap<String, (Instant, Option<String>)>,
    sign_ins: HashMap<String, (Instant, Option<SignIn>)>,
    /// Questions being asked right now, so each is asked once at a time.
    asking: HashSet<String>,
}

impl Probes {
    pub fn version_of(&self, app: &tauri::AppHandle, path: &str) -> Option<String> {
        let key = format!("version:{path}");
        let mut state = self.0.lock().unwrap();
        let known = state.versions.get(path).cloned();
        // A version, once known, holds for the launch; no answer is asked again after a while.
        if let Some((at, version)) = &known {
            if version.is_some() || at.elapsed() < SIGN_IN_TTL {
                return version.clone();
            }
        }
        if state.asking.insert(key.clone()) {
            let (probes, app, path) = (self.clone(), app.clone(), path.to_string());
            std::thread::spawn(move || {
                let version = run(&path, &["--version"]).and_then(|(_, out)| first_line(&out));
                let mut state = probes.0.lock().unwrap();
                state.versions.insert(path, (Instant::now(), version));
                state.asking.remove(&key);
                drop(state);
                let _ = app.emit("health://changed", ());
            });
        }
        known.and_then(|(_, version)| version)
    }

    /// The last answer (even if stale, while a fresh one is asked for).
    pub fn sign_in_of(&self, app: &tauri::AppHandle, kind: &str, path: &str) -> Option<SignIn> {
        let key = format!("sign-in:{path}");
        let mut state = self.0.lock().unwrap();
        let known = state.sign_ins.get(path).cloned();
        let fresh = known.as_ref().is_some_and(|(at, _)| at.elapsed() < SIGN_IN_TTL);
        if !fresh && state.asking.insert(key.clone()) {
            let (probes, app, kind, path) = (self.clone(), app.clone(), kind.to_string(), path.to_string());
            std::thread::spawn(move || {
                let answer = probe_sign_in(&kind, &path);
                let mut state = probes.0.lock().unwrap();
                let changed = state.sign_ins.get(&path).map(|(_, s)| s) != Some(&answer);
                state.sign_ins.insert(path, (Instant::now(), answer));
                state.asking.remove(&key);
                drop(state);
                if changed {
                    let _ = app.emit("health://changed", ());
                }
            });
        }
        known.and_then(|(_, s)| s)
    }
}

/// Ask each provider's CLI in its own words whether it's signed in.
fn probe_sign_in(kind: &str, path: &str) -> Option<SignIn> {
    match kind {
        "claude-code" => run(path, &["auth", "status"]).and_then(|(_, out)| parse_claude_status(&out)),
        "codex" => run(path, &["login", "status"]).map(|(ok, out)| parse_codex_status(ok, &out)),
        "opencode" => run(path, &["auth", "list"]).map(|(_, out)| parse_opencode_auth(&out)),
        _ => None,
    }
}

/// `claude auth status` prints JSON: `{"loggedIn": true, "authMethod": "claude.ai", ...}`.
pub fn parse_claude_status(out: &str) -> Option<SignIn> {
    let v: serde_json::Value = serde_json::from_str(out.trim()).ok()?;
    let signed_in = v.get("loggedIn")?.as_bool()?;
    let method = v.get("authMethod").and_then(|m| m.as_str()).filter(|m| *m != "none");
    let detail = method.map(|m| match m {
        "claude.ai" => "Claude account".to_string(),
        "api_key" | "apiKey" => "API key".to_string(),
        other => other.replace(['_', '-'], " "),
    });
    Some(SignIn { signed_in, detail: detail.filter(|_| signed_in) })
}

/// `codex login status` prints "Logged in using ChatGPT" (or "Not logged in").
pub fn parse_codex_status(ok: bool, out: &str) -> SignIn {
    let line = first_line(out).unwrap_or_default();
    let using = line.strip_prefix("Logged in using ").map(|how| how.trim().to_string());
    SignIn { signed_in: ok && line.starts_with("Logged in"), detail: using }
}

/// `opencode auth list` draws a list ending in "N credentials"; it may be coloured.
pub fn parse_opencode_auth(out: &str) -> SignIn {
    let plain = strip_ansi(out);
    let count = plain
        .lines()
        .filter_map(|l| {
            let words: Vec<&str> = l.split_whitespace().collect();
            let at = words.iter().position(|w| *w == "credentials" || *w == "credential")?;
            words.get(at.checked_sub(1)?)?.parse::<u32>().ok()
        })
        .next()
        .unwrap_or(0);
    SignIn {
        signed_in: count > 0,
        detail: (count > 0).then(|| if count == 1 { "1 credential".to_string() } else { format!("{count} credentials") }),
    }
}

/// Text without terminal colour codes.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // ESC [ ... letter
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Run a CLI with a timeout: whether it succeeded, and what it printed.
fn run(path: &str, args: &[&str]) -> Option<(bool, String)> {
    let mut child = std::process::Command::new(path)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = tx.send(text);
    });
    match rx.recv_timeout(PROBE_TIMEOUT) {
        Ok(text) => {
            let ok = child.wait().map(|s| s.success()).unwrap_or(false);
            Some((ok, text))
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            None
        }
    }
}

fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_first_non_empty_line() {
        assert_eq!(first_line("\n  2.1.3 (Claude Code)\nmore").as_deref(), Some("2.1.3 (Claude Code)"));
        assert_eq!(first_line("   \n"), None);
    }

    #[test]
    fn runs_a_cli_and_reads_what_it_printed() {
        // /bin/echo prints its arguments back, which is enough to prove the probe runs.
        assert_eq!(run("/bin/echo", &["--version"]), Some((true, "--version\n".into())));
        assert_eq!(run("/nonexistent/cli", &["--version"]), None);
    }

    #[test]
    fn reads_each_providers_sign_in() {
        let claude = r#"{ "loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty" }"#;
        assert_eq!(parse_claude_status(claude), Some(SignIn { signed_in: true, detail: Some("Claude account".into()) }));
        let logged_out = r#"{ "loggedIn": false, "authMethod": "none" }"#;
        assert_eq!(parse_claude_status(logged_out), Some(SignIn { signed_in: false, detail: None }));
        assert_eq!(parse_claude_status("not json"), None);

        assert_eq!(parse_codex_status(true, "Logged in using ChatGPT\n"), SignIn { signed_in: true, detail: Some("ChatGPT".into()) });
        assert!(!parse_codex_status(false, "Not logged in\n").signed_in);

        let opencode = "\u{1b}[0m\n┌  Credentials \u{1b}[90m~/.local/share/opencode/auth.json\n│\n●  OpenAI \u{1b}[90moauth\n│\n└  7 credentials\n";
        assert_eq!(parse_opencode_auth(opencode), SignIn { signed_in: true, detail: Some("7 credentials".into()) });
        assert!(!parse_opencode_auth("┌  Credentials\n│\n└  0 credentials\n").signed_in);
    }
}
