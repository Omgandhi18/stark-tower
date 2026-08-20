use crate::agents::AgentStatus;
use crate::config::EngineConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

static TASK_SEQ: AtomicU64 = AtomicU64::new(1);

/// Nudge the UI to reload the task board.
fn emit_tasks_changed(app: &tauri::AppHandle) {
    let _ = app.emit("tasks://changed", ());
}

/// The agent's engine with its `auth.env` secrets hydrated from the secret store
/// (config only ever holds sentinels), ready to spawn.
fn engine_for_spawn(app: &tauri::AppHandle, agent_id: &str) -> EngineConfig {
    let mut e = crate::prompts::agent_engine(app, agent_id);
    if let Some(state) = app.try_state::<crate::AppState>() {
        crate::secrets::hydrate(&state.secrets.lock().unwrap(), &mut e);
    }
    e
}

/// Mirror a significant event onto the git-versioned floor log.
pub(crate) fn floor_log(app: &tauri::AppHandle, agent_id: &str, kind: &str, detail: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        crate::floor::log_event(&state.floor_dir, ts, agent_id, kind, detail);
    }
}

/// A persistent headless Claude Code conversation for one agent, driven over
/// stream-json. No pty — so no trust dialog and no terminal crash class.
pub struct ChatSession {
    child: Child,
    pub(crate) stdin: ChildStdin,
    pub cwd: String,
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        crate::proc::kill_tree(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// SIGKILL the process group of every live session — persistent chat sessions
/// plus in-flight one-shot delegation workers — used on app quit.
pub fn kill_all(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        for pid in state.oneshot_pids.lock().unwrap().iter() {
            crate::proc::kill_tree(*pid);
        }
        for s in state.chat.sessions.lock().unwrap().values() {
            crate::proc::kill_tree(s.child.id());
        }
    }
}

#[derive(Default)]
pub struct ChatManager {
    pub sessions: Mutex<HashMap<String, ChatSession>>,
}

/// One background delegation batch. JARVIS fires off N workers in a turn (each
/// runs detached and streams to its own tab); when the turn is `sealed` and all
/// `pending` workers have finished, their `results` are synthesized back to him.
#[derive(Default)]
pub struct DelegationState {
    pub sealed: bool,
    pub pending: usize,
    pub results: Vec<(String, String, String)>, // (agent, task, result)
    /// Bumped whenever a fresh batch starts, so a watchdog scheduled for an old
    /// batch can tell it's stale and skip.
    pub gen: u64,
}

#[derive(Clone, Serialize)]
pub struct ChatEvent {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    /// init | text | thinking | tool | result | error | exit
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}


fn emit(app: &tauri::AppHandle, ev: ChatEvent) {
    let _ = app.emit("chat://event", ev);
}

/// Append a message to the durable transcript (so it survives the UI closing).
pub(crate) fn persist(
    app: &tauri::AppHandle,
    agent_id: &str,
    role: &str,
    text: Option<&str>,
    tool: Option<&str>,
    detail: Option<&str>,
) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.ledger.add_message(agent_id, role, text, tool, detail);
    }
}

pub(crate) fn simple(app: &tauri::AppHandle, agent_id: &str, kind: &str, text: Option<String>) {
    emit(
        app,
        ChatEvent {
            agent_id: agent_id.to_string(),
            kind: kind.to_string(),
            text,
            tool: None,
            detail: None,
            cwd: None,
        },
    );
}

pub(crate) fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

pub(crate) fn base_name(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| p.to_string())
}

fn program_cache() -> &'static Mutex<HashMap<String, String>> {
    static C: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Resolve a CLI's absolute path the way a login shell would, so an engine
/// binary installed via nvm / fnm / asdf / volta / Homebrew resolves even when
/// the app is launched from Finder with a minimal PATH. Positive results are
/// cached; misses are deliberately not, so a just-installed CLI is seen next try.
pub fn resolve_program(cmd: &str) -> Option<String> {
    let cmd = cmd.trim();
    if cmd.is_empty() {
        return None;
    }
    // An explicit path is honored as-is (if it exists).
    if cmd.contains('/') {
        return std::path::Path::new(cmd).exists().then(|| cmd.to_string());
    }
    if let Some(p) = program_cache().lock().unwrap().get(cmd) {
        if std::path::Path::new(p).exists() {
            return Some(p.clone());
        }
    }
    // Only a plain binary name may go through the shell (no metacharacters).
    let simple = cmd.chars().all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c));
    if simple {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        if let Ok(out) = Command::new(&shell)
            .args(["-lc", &format!("command -v {cmd} 2>/dev/null | tail -n1")])
            .output()
        {
            let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !path.is_empty() && std::path::Path::new(&path).exists() {
                program_cache().lock().unwrap().insert(cmd.to_string(), path.clone());
                return Some(path);
            }
        }
    }
    // Fallback: probe the common install locations directly.
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{home}/.local/bin/{cmd}"),
        format!("{home}/.claude/local/{cmd}"),
        format!("{home}/.bun/bin/{cmd}"),
        format!("{home}/.volta/bin/{cmd}"),
        format!("/opt/homebrew/bin/{cmd}"),
        format!("/usr/local/bin/{cmd}"),
    ];
    for c in candidates {
        if std::path::Path::new(&c).exists() {
            program_cache().lock().unwrap().insert(cmd.to_string(), c.clone());
            return Some(c);
        }
    }
    None
}

/// Inject a steer message into an agent's live session (a new user turn).
fn steer(app: &tauri::AppHandle, agent_id: &str, text: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Some(s) = state.chat.sessions.lock().unwrap().get_mut(agent_id) {
            let msg = serde_json::json!({
                "type": "user", "message": { "role": "user", "content": text }
            });
            let _ = s.stdin.write_all(format!("{}\n", msg).as_bytes());
            let _ = s.stdin.flush();
        }
    }
}

/// A headless agent repeating the same tool call is looping (and burning quota —
/// the PTY breaker never sees this path). Walk the containment ladder: STEER
/// first (nudge it to change course), then CONSTRAIN (pause + surface), then STOP
/// (end a live persistent session). One-shot workers are bounded so they cap at
/// Constrained. A clean turn de-escalates via breaker::calm.
fn trip_headless_breaker(app: &tauri::AppHandle, agent_id: &str, tool: &str, persistent: bool) {
    use crate::breaker::Level;
    // Persistent sessions may be killed (hard_stop); one-shots can't, so cap them.
    let level = crate::breaker::bump(agent_id, persistent);
    let _ = app.emit("breaker://trip", agent_id.to_string());

    let (kind, note) = match level {
        Level::Steering => (
            "steer",
            format!("Steering: repeated `{tool}` calls — nudging the agent to change course."),
        ),
        Level::Constrained => (
            "containment",
            format!("Contained: still looping on `{tool}` after a steer — paused."),
        ),
        Level::Stopped => (
            "containment",
            "Stopped: runaway loop persisted — session ended.".to_string(),
        ),
        Level::Healthy => return,
    };
    simple(app, agent_id, "system", Some(note.clone()));
    persist(app, agent_id, "system", Some(&note), None, None);
    if let Some(state) = app.try_state::<crate::AppState>() {
        let e = state.ledger.record(agent_id, kind, &note, 9);
        let _ = app.emit("ledger://entry", e);
    }

    match level {
        Level::Steering => steer(
            app,
            agent_id,
            "[STEER] You've repeated the same action several times without progress. Stop, \
reconsider your approach, and either take a genuinely different step or report what's blocking you.",
        ),
        Level::Constrained => crate::pty::emit_status(app, agent_id, AgentStatus::Blocked),
        Level::Stopped => {
            crate::pty::emit_status(app, agent_id, AgentStatus::Blocked);
            if persistent {
                if let Some(state) = app.try_state::<crate::AppState>() {
                    let removed = state.chat.sessions.lock().unwrap().remove(agent_id);
                    drop(removed); // Drop → group-kill, outside the sessions lock.
                }
            }
        }
        Level::Healthy => {}
    }
}

/// A friendly error when an engine's CLI isn't installed / on PATH.
fn missing_engine_error(engine: &EngineConfig) -> String {
    format!(
        "{} (`{}`) wasn't found. Install it and make sure it's on your PATH, then reopen Stark Tower.",
        engine.label, engine.command
    )
}

/// Build the headless command for an agent's session on a given engine.
///
/// The Claude Code adapter (`kind == "claude-code"`) drives our full protocol:
/// stream-json in/out, the MCP bridge (delegate / ask_human / approve gate), and
/// session resume. Other engine kinds only speak stream-json today if they
/// happen to; their dedicated adapters (Codex, OpenCode, …) land in later slices,
/// so for now non-Claude kinds spawn `command + extra_args` best-effort. The
/// model flag and any auth env vars are applied for every kind.
#[allow(clippy::too_many_arguments)]
fn build_headless(
    engine: &EngineConfig,
    model: &str,
    cwd: &str,
    agent_id: Option<&str>,
    is_orchestrator: bool,
    system_prompt: Option<&str>,
    resume: Option<&str>,
    sock_path: &str,
    sock_token: &str,
    memory_file: &str,
) -> Command {
    // Resolve to an absolute path so a Finder-launched app finds nvm/brew CLIs.
    let program = resolve_program(&engine.command).unwrap_or_else(|| engine.command.clone());
    let mut cmd = Command::new(&program);
    let mut args: Vec<String> = Vec::new();

    if engine.kind == "claude-code" {
        args.extend(
            [
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "acceptEdits",
            ]
            .iter()
            .map(|s| s.to_string()),
        );

        // Resume the stored session so the conversation continues with full
        // context; the prior session already carries the system prompt.
        if let Some(sid) = resume {
            args.push("--resume".into());
            args.push(sid.to_string());
        } else if let Some(prompt) = system_prompt {
            args.push("--append-system-prompt".into());
            args.push(prompt.to_string());
        }

        if !model.trim().is_empty() {
            args.push("--model".into());
            args.push(model.to_string());
        }

        // The Stark bridge MCP: ask_human (everyone) + delegate (JARVIS only),
        // plus the permission gate. Only when the engine supports MCP.
        if engine.supports_mcp {
            if let Some(aid) = agent_id {
                let tools = if is_orchestrator {
                    "mcp__stark__ask_human,mcp__stark__delegate,mcp__stark__message,mcp__stark__report_bug"
                } else {
                    "mcp__stark__ask_human,mcp__stark__message,mcp__stark__report_bug"
                };
                args.push("--allowedTools".into());
                args.push(tools.into());
                args.push("--mcp-config".into());
                let mjs = format!("{}/mcp/delegate-mcp.mjs", env!("CARGO_MANIFEST_DIR"));
                let role = if is_orchestrator { "orchestrator" } else { "worker" };
                let bridge = serde_json::json!({
                    "mcpServers": {
                        "stark": {
                            "command": "node",
                            "args": [mjs],
                            "env": {
                                "STARK_DELEGATE_SOCK": sock_path,
                                "STARK_AGENT_ID": aid,
                                "STARK_ROLE": role,
                                "STARK_DELEGATE_TOKEN": sock_token
                            }
                        }
                    }
                });
                args.push(bridge.to_string());
                args.push("--permission-prompt-tool".into());
                args.push("mcp__stark__approve".into());
            }
        }
    } else {
        // Best-effort for not-yet-adapted engines; a real adapter replaces this.
        args.extend(engine.extra_args.iter().cloned());
    }

    cmd.args(&args);
    cmd.current_dir(cwd);

    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    let path = match std::env::var("PATH") {
        Ok(p) => format!("{extra}:{p}"),
        Err(_) => extra,
    };
    cmd.env("PATH", path);
    // Inject the engine's auth env (API keys etc.) so users can bring their own.
    // Values are hydrated from the secret store before we get here; skip any
    // still-sentinel (no stored secret) or empty entry.
    for (k, v) in &engine.auth.env {
        if !v.trim().is_empty() && v != crate::secrets::SENTINEL {
            cmd.env(k, v);
        }
    }
    // The agent's durable memory file (all engines).
    if !memory_file.is_empty() {
        cmd.env("STARK_MEMORY_FILE", memory_file);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Put the agent in its own session/process group so we can later kill the
    // whole tree (it + any Bash/MCP children) instead of orphaning them.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    cmd
}

/// Summarize a tool call into a one-line activity string.
fn summarize_tool(name: &str, input: &serde_json::Value) -> String {
    let s = |k: &str| {
        input
            .get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    if name == "delegate" {
        let agent = s("agent").to_uppercase();
        return format!("{} · {}", agent, truncate(&s("task"), 70));
    }
    match name {
        "Edit" | "Write" | "Read" | "NotebookEdit" => s("file_path"),
        "Bash" => s("command").chars().take(90).collect(),
        "Grep" | "Glob" => s("pattern"),
        "Task" => s("description"),
        "WebFetch" => s("url"),
        "WebSearch" => s("query"),
        _ => String::new(),
    }
}

/// Parse one stream-json line and emit the relevant chat event(s). When
/// `record_session` is set (persistent sessions, not one-shot delegations) the
/// init event's session id is stored so the chat can later be resumed.
fn handle_line(app: &tauri::AppHandle, agent_id: &str, v: &serde_json::Value, record_session: bool) {
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match t {
        "system" => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                let cwd = v.get("cwd").and_then(|c| c.as_str()).map(|c| c.to_string());
                if record_session {
                    if let (Some(c), Some(sid)) = (
                        cwd.as_deref(),
                        v.get("session_id").and_then(|s| s.as_str()),
                    ) {
                        if let Some(state) = app.try_state::<crate::AppState>() {
                            let conv = state.ledger.active_conversation(agent_id);
                            state.ledger.set_conversation_session(conv, sid, c);
                        }
                    }
                }
                emit(
                    app,
                    ChatEvent {
                        agent_id: agent_id.to_string(),
                        kind: "init".into(),
                        text: None,
                        tool: None,
                        detail: None,
                        cwd,
                    },
                );
                crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
            }
        }
        "assistant" => {
            crate::pty::emit_status(app, agent_id, AgentStatus::Working);
            if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for b in blocks {
                    match b.get("type").and_then(|x| x.as_str()) {
                        Some("text") => {
                            let text = b.get("text").and_then(|x| x.as_str()).unwrap_or("");
                            if !text.trim().is_empty() {
                                simple(app, agent_id, "text", Some(text.to_string()));
                                persist(app, agent_id, "agent", Some(text), None, None);
                            }
                        }
                        Some("thinking") => {
                            let text = b.get("thinking").and_then(|x| x.as_str()).unwrap_or("");
                            if !text.trim().is_empty() {
                                simple(app, agent_id, "thinking", Some(text.to_string()));
                                persist(app, agent_id, "thinking", Some(text), None, None);
                            }
                        }
                        Some("tool_use") => {
                            let raw = b.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
                            // Shorten MCP tool names: mcp__stark__delegate -> delegate
                            let name = if raw.starts_with("mcp__") {
                                raw.rsplit("__").next().unwrap_or(raw)
                            } else {
                                raw
                            };
                            let detail = b
                                .get("input")
                                .map(|i| summarize_tool(name, i))
                                .unwrap_or_default();
                            persist(app, agent_id, "tool", None, Some(name), Some(&detail));
                            // Runaway loop guard for the headless path: trip if the
                            // same tool call repeats too many times in a row.
                            let sig = format!("{name}|{detail}");
                            if crate::breaker::is_runaway(crate::breaker::note_tool_call(
                                agent_id, &sig,
                            )) {
                                crate::breaker::reset(agent_id);
                                trip_headless_breaker(app, agent_id, name, record_session);
                            }
                            emit(
                                app,
                                ChatEvent {
                                    agent_id: agent_id.to_string(),
                                    kind: "tool".into(),
                                    text: None,
                                    tool: Some(name.to_string()),
                                    detail: Some(detail),
                                    cwd: None,
                                },
                            );
                        }
                        _ => {}
                    }
                }
            }
        }
        "result" => {
            let text = v.get("result").and_then(|x| x.as_str()).map(|s| s.to_string());
            let cost = v.get("total_cost_usd").and_then(|c| c.as_f64());
            emit(
                app,
                ChatEvent {
                    agent_id: agent_id.to_string(),
                    kind: "result".into(),
                    text,
                    tool: None,
                    detail: cost.map(|c| format!("${c:.4}")),
                    cwd: None,
                },
            );
            // Cost / context HUD: this turn's cost + the context-window fill from
            // the usage block (input + cache + output ≈ conversation size sent).
            let u = |k: &str| {
                v.pointer("/usage")
                    .and_then(|x| x.get(k))
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0)
            };
            let context_tokens = u("input_tokens")
                + u("cache_read_input_tokens")
                + u("cache_creation_input_tokens")
                + u("output_tokens");
            let _ = app.emit(
                "usage://update",
                serde_json::json!({
                    "agentId": agent_id,
                    "costUsd": cost.unwrap_or(0.0),
                    "contextTokens": context_tokens,
                }),
            );
            crate::breaker::reset(agent_id); // turn ended cleanly — clear the loop guard
            crate::breaker::step_down(agent_id); // de-escalate the ladder one rung
            crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
            // The orchestrator's turn just ended — if he dispatched workers this
            // turn, seal the batch so it flushes back once every worker finishes.
            if crate::prompts::agent_is_orchestrator(app, agent_id) {
                crate::delegation::seal_batch(app);
            }
        }
        _ => {}
    }
}

fn spawn_stderr_pump(app: &tauri::AppHandle, agent_id: &str, stderr: std::process::ChildStderr) {
    let app = app.clone();
    let id = agent_id.to_string();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            let l = line.trim();
            // stream-json prints benign notices to stderr; only surface real errors
            if l.to_lowercase().contains("error") {
                simple(&app, &id, "error", Some(l.to_string()));
            }
        }
    });
}

pub fn start_session(
    app: &tauri::AppHandle,
    agent_id: &str,
    cwd: &str,
    sock_path: &str,
) -> Result<(), String> {
    let prompt = crate::prompts::system_prompt_for(app, agent_id);
    let engine = engine_for_spawn(app, agent_id);
    if resolve_program(&engine.command).is_none() {
        return Err(missing_engine_error(&engine));
    }
    let model = crate::prompts::agent_model(app, agent_id, &engine);
    let is_orch = crate::prompts::agent_is_orchestrator(app, agent_id);
    // Resume the active conversation's session so it continues with full context.
    let resume = app
        .try_state::<crate::AppState>()
        .and_then(|s| s.ledger.conversation_session(s.ledger.active_conversation(agent_id)));
    let resumed = resume.is_some();
    let token = app
        .try_state::<crate::AppState>()
        .map(|s| s.sock_token.clone())
        .unwrap_or_default();
    let memory_file = crate::prompts::memory_file_path(app, agent_id);
    let mut child = build_headless(
        &engine,
        &model,
        cwd,
        Some(agent_id),
        is_orch,
        Some(&prompt),
        resume.as_deref(),
        sock_path,
        &token,
        &memory_file,
    )
    .spawn()
    .map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_pump(app, agent_id, stderr);
    }

    let app2 = app.clone();
    let id2 = agent_id.to_string();
    let orch = is_orch;
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut saw_init = false;
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if !saw_init
                    && v.get("type").and_then(|t| t.as_str()) == Some("system")
                    && v.get("subtype").and_then(|s| s.as_str()) == Some("init")
                {
                    saw_init = true;
                }
                handle_line(&app2, &id2, &v, true);
            }
        }
        // A resumed session that never reached `init` means the stored session id
        // no longer resolves (Claude rotated or pruned it). Forget the stale
        // pointer so the next message starts a genuinely fresh session instead of
        // re-resuming the dead id forever, and tell the user to resend once.
        if resumed && !saw_init {
            if let Some(state) = app2.try_state::<crate::AppState>() {
                let conv = state.ledger.active_conversation(&id2);
                state.ledger.forget_conversation_session(conv);
            }
            simple(
                &app2,
                &id2,
                "system",
                Some("Previous session expired — starting fresh. Please resend your last message.".into()),
            );
        }
        simple(&app2, &id2, "exit", None);
        let state = app2.state::<crate::AppState>();
        state.chat.sessions.lock().unwrap().remove(&id2);
        crate::pty::emit_status(&app2, &id2, AgentStatus::Offline);
        // If the orchestrator's session ended mid-turn (crash / stop / cwd switch),
        // seal any open delegation batch so pending workers' results aren't
        // stranded waiting for a `result` that will never come.
        if orch {
            crate::delegation::seal_batch(&app2);
        }
    });

    app.state::<crate::AppState>()
        .chat
        .sessions
        .lock()
        .unwrap()
        .insert(
            agent_id.to_string(),
            ChatSession {
                child,
                stdin,
                cwd: cwd.to_string(),
            },
        );
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    Ok(())
}

/// Send a user message, starting the session (in `cwd`) if needed.
pub fn send(
    app: &tauri::AppHandle,
    agent_id: &str,
    text: &str,
    cwd: &str,
    sock_path: &str,
) -> Result<(), String> {
    // Start a session if none exists, or restart it if the target directory
    // changed (so switching an agent to another repo just works).
    let need_start = {
        let state = app.state::<crate::AppState>();
        let map = state.chat.sessions.lock().unwrap();
        match map.get(agent_id) {
            None => true,
            Some(s) => s.cwd != cwd,
        }
    };
    if need_start {
        {
            let state = app.state::<crate::AppState>();
            state.chat.sessions.lock().unwrap().remove(agent_id); // Drop kills old
        }
        start_session(app, agent_id, cwd, sock_path)?;
    }

    // The orchestrator gets the current team + project map prepended to each turn,
    // so a renamed/added agent or project is reflected immediately (see §01.8).
    let content = if crate::prompts::agent_is_orchestrator(app, agent_id) {
        let ctx = crate::prompts::orchestrator_turn_context(app, agent_id);
        if ctx.is_empty() {
            text.to_string()
        } else {
            format!("{ctx}\n\n{text}")
        }
    } else {
        text.to_string()
    };
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content }
    });
    let line = format!("{}\n", msg);

    let state = app.state::<crate::AppState>();
    let mut map = state.chat.sessions.lock().unwrap();
    let s = map
        .get_mut(agent_id)
        .ok_or_else(|| format!("no chat session for {agent_id}"))?;
    s.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    s.stdin.flush().map_err(|e| e.to_string())?;
    drop(map);

    crate::pty::emit_status(app, agent_id, AgentStatus::Thinking);
    Ok(())
}

pub fn stop(app: &tauri::AppHandle, agent_id: &str) {
    let removed = app
        .state::<crate::AppState>()
        .chat
        .sessions
        .lock()
        .unwrap()
        .remove(agent_id);
    drop(removed);
    crate::pty::emit_status(app, agent_id, AgentStatus::Offline);
}

// ---- Delegation bridge -----------------------------------------------------

/// Run a one-shot task on a worker to completion, streaming its activity to the
/// UI (so it's visible on the floor + its chat tab), and return the result text.
pub fn run_task_blocking(
    app: &tauri::AppHandle,
    agent_id: &str,
    task: &str,
    cwd: &str,
) -> Result<String, String> {
    let marker = format!("JARVIS delegated · {}", base_name(cwd));
    simple(app, agent_id, "system", Some(marker.clone()));
    persist(app, agent_id, "system", Some(&marker), None, None);
    persist(app, agent_id, "user", Some(task), None, None);
    // Open a task card on the board so this delegation is trackable across turns.
    let task_id = format!("task-{}", TASK_SEQ.fetch_add(1, Ordering::Relaxed));
    if let Some(state) = app.try_state::<crate::AppState>() {
        state
            .ledger
            .upsert_task(&task_id, &truncate(task, 80), agent_id, "doing", None);
    }
    emit_tasks_changed(app);
    floor_log(app, agent_id, "task-doing", &truncate(task, 80));
    if let Some(state) = app.try_state::<crate::AppState>() {
        let e = state.ledger.record(
            "jarvis",
            "delegate",
            &format!("JARVIS → {} · {}", agent_id.to_uppercase(), truncate(task, 46)),
            3,
        );
        let _ = app.emit("ledger://entry", e);
    }
    crate::pty::emit_status(app, agent_id, AgentStatus::Thinking);

    // Delegated workers also get their skill kit + the ask_human bridge, so
    // their review gates work even when JARVIS delegated the task.
    let (sock, token) = app
        .try_state::<crate::AppState>()
        .map(|s| (s.sock_path.clone(), s.sock_token.clone()))
        .unwrap_or_default();
    let prompt = crate::prompts::system_prompt_for(app, agent_id);
    let engine = engine_for_spawn(app, agent_id);
    if resolve_program(&engine.command).is_none() {
        return Err(missing_engine_error(&engine));
    }
    let model = crate::prompts::agent_model(app, agent_id, &engine);
    let is_orch = crate::prompts::agent_is_orchestrator(app, agent_id);
    let memory_file = crate::prompts::memory_file_path(app, agent_id);
    let mut child = build_headless(
        &engine,
        &model,
        cwd,
        Some(agent_id),
        is_orch,
        Some(&prompt),
        None,
        &sock,
        &token,
        &memory_file,
    )
    .spawn()
    .map_err(|e| e.to_string())?;
    // Track this one-shot worker so app-quit can kill its group (it lives outside
    // the `chat` session map).
    let pid = child.id();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().insert(pid);
    }
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_pump(app, agent_id, stderr);
    }

    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": task }
    });
    stdin
        .write_all(format!("{}\n", msg).as_bytes())
        .map_err(|e| e.to_string())?;
    stdin.flush().ok();
    drop(stdin); // one-shot: close stdin so the worker exits after its result

    let reader = BufReader::new(stdout);
    let mut result = String::new();
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            handle_line(app, agent_id, &v, false);
            if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                result = v
                    .get("result")
                    .and_then(|r| r.as_str())
                    .unwrap_or("")
                    .to_string();
            }
        }
    }
    let _ = child.wait();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().remove(&pid);
        // Close out the task card. Empty result = the worker produced nothing.
        let status = if result.trim().is_empty() { "blocked" } else { "done" };
        state
            .ledger
            .set_task_status(&task_id, status, Some(&truncate(&result, 200)));
    }
    emit_tasks_changed(app);
    let status = if result.trim().is_empty() { "task-blocked" } else { "task-done" };
    floor_log(app, agent_id, status, &truncate(task, 80));
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_program_honors_absolute_paths_and_rejects_bogus() {
        assert_eq!(resolve_program("/bin/sh").as_deref(), Some("/bin/sh"));
        assert!(resolve_program("/nonexistent/xyzzy-bin").is_none());
        assert!(resolve_program("definitely-not-a-real-cli-xyzzy").is_none());
    }
}
