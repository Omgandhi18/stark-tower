use crate::agents::{AgentKind, AgentStatus};
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

/// Mirror a significant event onto the git-versioned floor log.
fn floor_log(app: &tauri::AppHandle, agent_id: &str, kind: &str, detail: &str) {
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
    stdin: ChildStdin,
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
fn persist(
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

fn simple(app: &tauri::AppHandle, agent_id: &str, kind: &str, text: Option<String>) {
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

/// A headless agent repeating the same tool call over and over is stuck in a
/// loop (and quietly burning quota — the PTY breaker never sees this path). Mark
/// it Blocked, surface + log it, and end a live persistent session to stop the
/// burn. One-shot delegation workers are bounded, so they're only surfaced.
fn trip_headless_breaker(app: &tauri::AppHandle, agent_id: &str, tool: &str, persistent: bool) {
    crate::pty::emit_status(app, agent_id, AgentStatus::Blocked);
    let _ = app.emit("breaker://trip", agent_id.to_string());
    let note = format!("Runaway containment: repeated `{tool}` calls in a loop — agent paused.");
    simple(app, agent_id, "system", Some(note.clone()));
    persist(app, agent_id, "system", Some(&note), None, None);
    if let Some(state) = app.try_state::<crate::AppState>() {
        let e = state.ledger.record(agent_id, "containment", &note, 9);
        let _ = app.emit("ledger://entry", e);
    }
    if persistent {
        if let Some(state) = app.try_state::<crate::AppState>() {
            let removed = state.chat.sessions.lock().unwrap().remove(agent_id);
            drop(removed); // Drop → group-kill, outside the sessions lock.
        }
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
                    "mcp__stark__ask_human,mcp__stark__delegate"
                } else {
                    "mcp__stark__ask_human"
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
    for (k, v) in &engine.auth.env {
        if !v.trim().is_empty() {
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
                            state.ledger.set_session(agent_id, c, sid);
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
            crate::breaker::reset(agent_id); // turn ended cleanly — clear the loop guard
            crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
            // The orchestrator's turn just ended — if he dispatched workers this
            // turn, seal the batch so it flushes back once every worker finishes.
            if crate::prompts::agent_is_orchestrator(app, agent_id) {
                seal_batch(app);
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
    let engine = crate::prompts::agent_engine(app, agent_id);
    if resolve_program(&engine.command).is_none() {
        return Err(missing_engine_error(&engine));
    }
    let model = crate::prompts::agent_model(app, agent_id, &engine);
    let is_orch = crate::prompts::agent_is_orchestrator(app, agent_id);
    // If we've talked to this agent in this directory before, resume that
    // session so the conversation continues with full context.
    let resume = app
        .try_state::<crate::AppState>()
        .and_then(|s| s.ledger.get_session(agent_id, cwd));
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
    let cwd2 = cwd.to_string();
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
                state.ledger.forget_session(&id2, &cwd2);
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
            seal_batch(&app2);
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
    let engine = crate::prompts::agent_engine(app, agent_id);
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

/// Register a newly-dispatched worker into JARVIS's current delegation batch.
/// A delegate arriving after the previous batch fully drained starts a fresh one.
pub(crate) fn register_delegation(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut b = state.delegations.lock().unwrap();
        if b.sealed && b.pending == 0 {
            let g = b.gen.wrapping_add(1);
            *b = DelegationState::default(); // previous batch done → start fresh
            b.gen = g;
        }
        b.sealed = false;
        b.pending += 1;
    }
}

/// Record a finished worker and try to close out the batch.
pub(crate) fn complete_delegation(app: &tauri::AppHandle, agent: &str, task: &str, result: &str) {
    let mut arm_watchdog = None;
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut b = state.delegations.lock().unwrap();
        b.results.push((agent.to_string(), task.to_string(), result.to_string()));
        b.pending = b.pending.saturating_sub(1);
        // Every worker is in but the orchestrator hasn't ended its turn yet. Arm a
        // watchdog so the results can't be stranded if it errors out or hangs and
        // never emits a `result` (which is what normally seals the batch).
        if b.pending == 0 && !b.sealed {
            arm_watchdog = Some(b.gen);
        }
    }
    try_flush(app);
    if let Some(gen) = arm_watchdog {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(12));
            let stale = app
                .try_state::<crate::AppState>()
                .map(|s| {
                    let mut b = s.delegations.lock().unwrap();
                    if b.gen == gen && !b.sealed && b.pending == 0 && !b.results.is_empty() {
                        b.sealed = true; // force the seal so try_flush can drain it
                        true
                    } else {
                        false
                    }
                })
                .unwrap_or(false);
            if stale {
                eprintln!("[delegation] watchdog sealed a batch the orchestrator never closed");
                try_flush(&app);
            }
        });
    }
}

/// The orchestrator's delegating turn has ended — seal the batch so it can flush
/// once every worker is in. Called on the orchestrator's `result` (or on its
/// session exiting mid-turn, so a crash can't strand the workers' output).
fn seal_batch(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.delegations.lock().unwrap().sealed = true;
    }
    try_flush(app);
}

/// If the batch is sealed and drained, hand the collected results back to JARVIS
/// as one follow-up message so he can synthesize a single reply.
fn try_flush(app: &tauri::AppHandle) {
    let batch = {
        let Some(state) = app.try_state::<crate::AppState>() else { return };
        let mut b = state.delegations.lock().unwrap();
        if b.sealed && b.pending == 0 && !b.results.is_empty() {
            std::mem::take(&mut *b) // reset to default, take the results
        } else {
            return;
        }
    };

    let mut body = String::from(
        "[DELEGATION RESULTS] The worker(s) you dispatched have finished. Synthesize these into \
ONE clear reply for Om — call out anything that needs his decision. Don't re-delegate unless \
something is genuinely incomplete.\n\n",
    );
    for (agent, task, result) in &batch.results {
        body.push_str(&format!(
            "## {} — {}\n{}\n\n---\n\n",
            agent.to_uppercase(),
            truncate(task, 80),
            result
        ));
    }
    // If the orchestrator isn't live to synthesize, don't lose the work — surface
    // it on his tab and log it instead of dropping it silently.
    if !inject_to_orchestrator(app, &body) {
        dead_letter(app, &batch);
    }
}

/// The current orchestrator's agent id (falls back to "jarvis").
fn orchestrator_id(app: &tauri::AppHandle) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agents.iter().find(|a| a.kind == AgentKind::Orchestrator) {
            return a.id.clone();
        }
    }
    "jarvis".to_string()
}

/// Feed a message into an agent's live session as a new user turn. Returns false
/// if the session isn't running. No side effects beyond the write + Thinking.
fn inject_user_turn(app: &tauri::AppHandle, agent_id: &str, text: &str) -> bool {
    let Some(state) = app.try_state::<crate::AppState>() else { return false };
    let mut map = state.chat.sessions.lock().unwrap();
    let Some(s) = map.get_mut(agent_id) else { return false };
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    if s.stdin.write_all(format!("{}\n", msg).as_bytes()).is_ok() {
        let _ = s.stdin.flush();
        drop(map);
        crate::pty::emit_status(app, agent_id, AgentStatus::Thinking);
        true
    } else {
        false
    }
}

/// Feed a message into the orchestrator's live session as a new user turn (used
/// to deliver delegation results). Returns false if his session isn't running.
fn inject_to_orchestrator(app: &tauri::AppHandle, text: &str) -> bool {
    let oid = orchestrator_id(app);
    if inject_user_turn(app, &oid, text) {
        persist(app, &oid, "system", Some("Worker results received — synthesizing."), None, None);
        true
    } else {
        false
    }
}

/// A standup mission: nudge a LIVE orchestrator to review the board and
/// re-engage stalled workers. Never spawns one — autonomy only extends a session
/// the user already opened.
pub fn run_standup(app: &tauri::AppHandle) {
    let oid = orchestrator_id(app);
    let msg = "[STANDUP] Floor check. Review the in-flight tasks and each worker's status: \
re-engage anyone stalled or blocked, close or reassign tasks that are done, and keep the board \
accurate. If everything in-flight is on track and nothing needs Om, say so briefly. Do NOT start \
new work Om didn't ask for.";
    if inject_user_turn(app, &oid, msg) {
        persist(app, &oid, "system", Some("Standup — reviewing the floor."), None, None);
        if let Some(state) = app.try_state::<crate::AppState>() {
            let e = state.ledger.record(&oid, "standup", "floor check", 1);
            let _ = app.emit("ledger://entry", e);
        }
        floor_log(app, &oid, "standup", "floor check");
    }
}

/// Last-resort delivery when the orchestrator's session is gone at flush time:
/// post the collected results to its tab and the ledger so they're recoverable
/// rather than silently dropped.
fn dead_letter(app: &tauri::AppHandle, batch: &DelegationState) {
    let oid = orchestrator_id(app);
    eprintln!(
        "[delegation] orchestrator offline at flush — dead-lettering {} result(s)",
        batch.results.len()
    );
    let note = "Delegation results arrived while the orchestrator was offline — delivered here so they aren't lost. Reopen the chat to have them synthesized.";
    simple(app, &oid, "system", Some(note.to_string()));
    persist(app, &oid, "system", Some(note), None, None);
    for (agent, task, result) in &batch.results {
        let text = format!("## {} — {}\n{}", agent.to_uppercase(), truncate(task, 80), result);
        simple(app, &oid, "text", Some(text.clone()));
        persist(app, &oid, "agent", Some(&text), None, None);
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        let e = state.ledger.record(
            &oid,
            "delegate",
            "delegation results dead-lettered (orchestrator offline)",
            2,
        );
        let _ = app.emit("ledger://entry", e);
    }
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
