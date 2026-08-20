use crate::agents::{AgentKind, AgentStatus};
use crate::config::EngineConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

static REVIEW_SEQ: AtomicU64 = AtomicU64::new(1);
static TASK_SEQ: AtomicU64 = AtomicU64::new(1);

/// Nudge the UI to reload the task board.
fn emit_tasks_changed(app: &tauri::AppHandle) {
    let _ = app.emit("tasks://changed", ());
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

/// App-level delegation mechanics, appended to JARVIS's (editable) personality
/// only when his engine supports the MCP bridge. Kept in code — not user-editable
/// — because it describes how *this app* wires delegation, not JARVIS's character.
const JARVIS_MECHANICS: &str = "How delegation works here: to parallelize, emit multiple \
`delegate` calls in the SAME turn (e.g. KAREN on the frontend and FRIDAY on the backend at once, \
or the same task across two directories) — they run concurrently. Delegation is NON-BLOCKING: the \
`delegate` tool returns IMMEDIATELY with just an acknowledgement, NOT the worker's output. So after \
delegating, briefly tell Om what you dispatched and to whom, then END YOUR TURN — do not wait or \
claim you have results yet. When the workers finish you'll automatically receive their outputs as a \
`[DELEGATION RESULTS]` message; THAT is when you synthesize everything into one clear reply for Om.\n\n\
Write each `delegate` task as a complete, self-contained CONTRACT — the worker never sees this \
conversation, so it must stand on its own. Cover four parts:\n\
- OBJECTIVE: the concrete outcome to achieve.\n\
- OUTPUT: exactly what to report back to you (a summary, a diff, a decision, findings…).\n\
- CONTEXT: the paths, commands, versions, and facts it needs — pass the right `directory`.\n\
- BOUNDARIES: what it must NOT touch or do, and anything to leave for a human.\n\
Keep it tight for a small task, but never omit the OBJECTIVE and OUTPUT.";

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

fn truncate(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut out: String = s.chars().take(max).collect();
        out.push('…');
        out
    }
}

fn base_name(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| p.to_string())
}

/// The current project map, so JARVIS can delegate to the right directory when
/// the user names a repo. Empty when no projects are configured.
fn project_map(app: &tauri::AppHandle) -> String {
    let mut s = String::new();
    if let Some(state) = app.try_state::<crate::AppState>() {
        let projects = state.projects.lock().unwrap().clone();
        let active = state.project.lock().unwrap().clone();
        if !projects.is_empty() {
            s.push_str(
                "Known projects you can delegate into (pass the absolute path as the `directory` argument):\n",
            );
            for p in &projects {
                s.push_str(&format!("- {} → {}\n", base_name(p), p));
            }
            s.push_str(&format!(
                "The active/default project is {active}. When the user names a project, map it to its path above. To work across several projects at once, delegate in parallel with the matching `directory` for each."
            ));
        }
    }
    s
}

/// The agent's editable personality (falls back to the built-in default).
fn personality_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            if !a.personality.trim().is_empty() {
                return a.personality.clone();
            }
        }
    }
    crate::config::default_personality(agent_id).to_string()
}

/// The engine an agent runs on (falls back to the built-in Claude Code engine).
fn agent_engine(app: &tauri::AppHandle, agent_id: &str) -> EngineConfig {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(e) = cfg.engine_for(agent_id) {
            return e.clone();
        }
    }
    crate::config::claude_default()
}

/// The model to run (agent override → engine default → "" for the engine's own).
fn agent_model(app: &tauri::AppHandle, agent_id: &str, engine: &EngineConfig) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            if !a.model.trim().is_empty() {
                return a.model.clone();
            }
        }
    }
    engine.model.clone()
}

/// Is this agent the lab's orchestrator (the one that can delegate)?
fn agent_is_orchestrator(app: &tauri::AppHandle, agent_id: &str) -> bool {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            return a.kind == AgentKind::Orchestrator;
        }
    }
    agent_id == "jarvis"
}

/// The agent's current display name (falls back to its id).
fn agent_name(app: &tauri::AppHandle, agent_id: &str) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agent(agent_id) {
            return a.name.clone();
        }
    }
    agent_id.to_string()
}

/// The live team the orchestrator can delegate to, built from the current config
/// so renamed and newly-added specialists show up automatically.
fn team_block(app: &tauri::AppHandle, self_id: &str) -> String {
    let Some(state) = app.try_state::<crate::AppState>() else {
        return String::new();
    };
    // Snapshot the roster first (drop the config lock before taking statuses, so
    // the two locks are never held at once).
    let workers: Vec<(String, String, String)> = {
        let cfg = state.config.lock().unwrap();
        cfg.agents
            .iter()
            .filter(|a| a.enabled && a.id != self_id && a.kind == AgentKind::Worker)
            .map(|a| (a.id.clone(), a.name.clone(), a.role.clone()))
            .collect()
    };
    if workers.is_empty() {
        return String::new();
    }
    let statuses = state.statuses.lock().unwrap();
    let lines: Vec<String> = workers
        .iter()
        .map(|(id, name, role)| {
            let word = match statuses.get(id).copied().unwrap_or(AgentStatus::Offline) {
                AgentStatus::Idle => "idle",
                AgentStatus::Thinking | AgentStatus::Working => "busy",
                AgentStatus::Blocked => "blocked",
                AgentStatus::Offline => "offline",
            };
            format!("- `{id}`: {name} ({role}) — {word}")
        })
        .collect();
    format!(
        "Your team — live status shown. Prefer an `idle` or `offline` worker; avoid piling work onto one that's already `busy` or `blocked`. Delegate by passing the worker's id to the `delegate` tool:\n{}",
        lines.join("\n")
    )
}

/// Resolve a delegate target (given by id or display name) to a canonical worker
/// id, or "" if it isn't an enabled worker.
fn resolve_worker_id(app: &tauri::AppHandle, input: &str) -> String {
    let q = input.trim().to_lowercase();
    if q.is_empty() {
        return String::new();
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        for a in &cfg.agents {
            if a.enabled && a.kind == AgentKind::Worker && a.id.to_lowercase() == q {
                return a.id.clone();
            }
        }
        for a in &cfg.agents {
            if a.enabled && a.kind == AgentKind::Worker && a.name.to_lowercase() == q {
                return a.id.clone();
            }
        }
    }
    String::new()
}

const ASK_HUMAN_NOTE: &str = "You have the `ask_human` tool — your review surface with Om. \
Use it for any sign-off, decision, findings gate, question, or to show a UI mockup \
(kind: \"mockup\", with a COMPLETE self-contained HTML document in `body` — inline CSS, no \
external CDN). It renders in the app and BLOCKS until Om decides, then returns his decision. \
Use it instead of any lavish or browser step.";

const JARVIS_PLAYBOOK: &str = "Planning playbook (the sarathi funnel) — for a large or foggy \
request, think before delegating: (1) if the idea is foggy, open it into a few distinct \
directions and settle on one; (2) stress-test the plan by asking Om the key open decisions via \
ask_human (kind: \"questions\") and folding in his answers; (3) cut the settled plan into small \
VERTICAL slices — each shippable on its own, no forward dependencies — and get sign-off via \
ask_human; (4) delegate one slice at a time to the right specialist. Skip all this for small, \
clear tasks. Route every human checkpoint through ask_human, never a browser.";

/// Assemble an agent's full system prompt: its editable personality, plus the
/// app mechanics its engine can actually use. JARVIS also gets the live project
/// map and, on an MCP engine, the delegation mechanics + planning playbook. The
/// ask_human note is appended only when the engine speaks our MCP bridge.
fn system_prompt_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    let personality = personality_for(app, agent_id);
    let mcp = agent_engine(app, agent_id).supports_mcp;

    let mut s = if agent_is_orchestrator(app, agent_id) {
        // Identity comes from config (so a renamed orchestrator introduces itself
        // correctly). The team roster + project map are NOT baked in here — they
        // change while a session is live, so they'd go stale and (worse) bust the
        // prompt cache. They ride each user turn instead (orchestrator_turn_context).
        let name = agent_name(app, agent_id);
        let mut s = format!("You are {name}, the orchestrator of this agent lab. {personality}");
        if mcp {
            s.push_str("\n\n");
            s.push_str(JARVIS_MECHANICS);
            s.push_str("\n\n");
            s.push_str(JARVIS_PLAYBOOK);
            s.push_str("\n\n");
            s.push_str(ASK_HUMAN_NOTE);
            s.push_str("\n\nYour current team and the projects you can delegate into are provided \
with each of Om's messages under [CURRENT TEAM & PROJECTS] — always use that list; it supersedes \
any roster mentioned earlier in this conversation.");
        }
        s
    } else {
        let mut s = personality;
        if mcp {
            s.push_str("\n\n");
            s.push_str(ASK_HUMAN_NOTE);
        }
        s
    };

    // Durable memory (all agents): the curation instruction + the current file.
    let mem = memory_block(app, agent_id);
    if !mem.is_empty() {
        s.push_str("\n\n");
        s.push_str(&mem);
    }
    s
}

/// Absolute path to an agent's durable memory file.
fn memory_file_path(app: &tauri::AppHandle, agent_id: &str) -> String {
    app.try_state::<crate::AppState>()
        .map(|s| {
            std::path::Path::new(&s.memory_dir)
                .join(format!("{agent_id}.md"))
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default()
}

/// The memory section for a system prompt: a standing instruction to curate the
/// file, plus its current contents so the agent recalls without a read.
fn memory_block(app: &tauri::AppHandle, agent_id: &str) -> String {
    let path = memory_file_path(app, agent_id);
    if path.is_empty() {
        return String::new();
    }
    let content = std::fs::read_to_string(&path).unwrap_or_default();
    let mut s = format!(
        "You keep a durable MEMORY file at {path} (also in $STARK_MEMORY_FILE). It persists across \
sessions. When you learn something durable — a project convention, a decision, a gotcha, where \
something lives — append a tight bullet to it with your Write/Edit tools. Keep it concise and \
prune stale lines; it is your long-term memory, not a log."
    );
    if content.trim().is_empty() {
        s.push_str("\n\n[YOUR MEMORY] (empty so far)");
    } else {
        s.push_str("\n\n[YOUR MEMORY]\n");
        s.push_str(content.trim());
    }
    s
}

/// The live team + project map, prepended to each of the orchestrator's user
/// turns so routing always reflects the current roster/projects — without baking
/// volatile state into the (cache-stable) system prompt.
fn orchestrator_turn_context(app: &tauri::AppHandle, agent_id: &str) -> String {
    let team = team_block(app, agent_id);
    let map = project_map(app);
    if team.is_empty() && map.is_empty() {
        return String::new();
    }
    let mut s = String::from("[CURRENT TEAM & PROJECTS] (this list supersedes any earlier one)\n");
    if !team.is_empty() {
        s.push_str(&team);
    }
    if !map.is_empty() {
        s.push_str("\n\n");
        s.push_str(&map);
    }
    s
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
            if agent_is_orchestrator(app, agent_id) {
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
    let prompt = system_prompt_for(app, agent_id);
    let engine = agent_engine(app, agent_id);
    if resolve_program(&engine.command).is_none() {
        return Err(missing_engine_error(&engine));
    }
    let model = agent_model(app, agent_id, &engine);
    let is_orch = agent_is_orchestrator(app, agent_id);
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
    let memory_file = memory_file_path(app, agent_id);
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
    let content = if agent_is_orchestrator(app, agent_id) {
        let ctx = orchestrator_turn_context(app, agent_id);
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
    let prompt = system_prompt_for(app, agent_id);
    let engine = agent_engine(app, agent_id);
    if resolve_program(&engine.command).is_none() {
        return Err(missing_engine_error(&engine));
    }
    let model = agent_model(app, agent_id, &engine);
    let is_orch = agent_is_orchestrator(app, agent_id);
    let memory_file = memory_file_path(app, agent_id);
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
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    Ok(result)
}

/// Register a newly-dispatched worker into JARVIS's current delegation batch.
/// A delegate arriving after the previous batch fully drained starts a fresh one.
fn register_delegation(app: &tauri::AppHandle) {
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
fn complete_delegation(app: &tauri::AppHandle, agent: &str, task: &str, result: &str) {
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

/// Listen on a Unix socket for delegation requests from JARVIS's MCP server.
pub fn start_delegation_server(app: tauri::AppHandle, sock_path: String) {
    let _ = std::fs::remove_file(&sock_path);
    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(_) => return,
    };
    // Owner-only on the socket node itself, on top of the 0700 app data dir.
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600));
    }
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app2 = app.clone();
            std::thread::spawn(move || handle_delegation(&app2, stream));
        }
    });
}

fn handle_delegation(app: &tauri::AppHandle, stream: UnixStream) {
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let reply = |w: &mut UnixStream, v: serde_json::Value| {
        let _ = w.write_all((v.to_string() + "\n").as_bytes());
    };

    let req: serde_json::Value = match serde_json::from_str(line.trim()) {
        Ok(v) => v,
        Err(_) => {
            reply(&mut writer, serde_json::json!({"error": "bad request"}));
            return;
        }
    };
    // Reject anything not carrying this launch's secret, so a stray local process
    // can't dispatch work, answer approvals, or enumerate the roster.
    let expected = app
        .try_state::<crate::AppState>()
        .map(|s| s.sock_token.clone())
        .unwrap_or_default();
    let got = req.get("token").and_then(|t| t.as_str()).unwrap_or("");
    if expected.is_empty() || got != expected {
        reply(&mut writer, serde_json::json!({"error": "unauthorized"}));
        return;
    }
    match req.get("type").and_then(|t| t.as_str()) {
        Some("review") => {
            handle_review(app, &mut writer, &req);
            return;
        }
        Some("approve") => {
            handle_approve(app, &mut writer, &req);
            return;
        }
        Some("roster") => {
            handle_roster(app, &mut writer, &req);
            return;
        }
        _ => {}
    }

    let agent_in = req.get("agent").and_then(|a| a.as_str()).unwrap_or("");
    let task = req.get("task").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let dir = req
        .get("directory")
        .and_then(|a| a.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());

    // Resolve the target against the live roster (by id or name), so renamed and
    // newly-added specialists are delegatable.
    let agent = resolve_worker_id(app, agent_in);
    if agent.is_empty() || task.trim().is_empty() {
        reply(
            &mut writer,
            serde_json::json!({"error": "unknown agent or empty task"}),
        );
        return;
    }

    let cwd = dir.unwrap_or_else(|| {
        let state = app.state::<crate::AppState>();
        let wd = state.workdirs.lock().unwrap().get("jarvis").cloned();
        wd.unwrap_or_else(|| state.project.lock().unwrap().clone())
    });
    // record the worker's dir too
    app.state::<crate::AppState>()
        .workdirs
        .lock()
        .unwrap()
        .insert(agent.clone(), cwd.clone());

    // Non-blocking: register the worker, ack JARVIS immediately so his turn
    // isn't frozen, then run the worker here (this is already a per-connection
    // background thread) and synthesize results back to him when the batch drains.
    register_delegation(app);
    reply(
        &mut writer,
        serde_json::json!({
            "result": format!(
                "Dispatched {} — running in the background. You'll receive the results as a \
[DELEGATION RESULTS] follow-up; acknowledge briefly now and synthesize then.",
                agent.to_uppercase()
            )
        }),
    );
    let _ = writer.flush();

    let result = run_task_blocking(app, &agent, &task, &cwd)
        .unwrap_or_else(|e| format!("(delegation failed: {e})"));
    complete_delegation(app, &agent, &task, &result);
}

/// Return the live team the orchestrator can delegate to, so the MCP server can
/// build a `delegate` tool whose agent list matches the current roster.
fn handle_roster(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let self_id = req.get("agentId").and_then(|s| s.as_str()).unwrap_or("");
    let mut workers = Vec::new();
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        for a in &cfg.agents {
            if a.enabled && a.id != self_id && a.kind == AgentKind::Worker {
                workers.push(serde_json::json!({
                    "id": a.id, "name": a.name, "role": a.role
                }));
            }
        }
    }
    let _ = writer.write_all(
        (serde_json::json!({ "workers": workers }).to_string() + "\n").as_bytes(),
    );
}

/// The lavish alternative: render a review in the app and BLOCK until the human
/// decides. Driven by the `ask_human` MCP tool over the socket.
fn handle_review(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let id = format!("rv-{}", REVIEW_SEQ.fetch_add(1, Ordering::Relaxed));
    let agent_id = req
        .get("agentId")
        .and_then(|s| s.as_str())
        .unwrap_or("jarvis")
        .to_string();
    let title = req
        .get("title")
        .and_then(|s| s.as_str())
        .unwrap_or("Review")
        .to_string();

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.state::<crate::AppState>()
        .reviews
        .lock()
        .unwrap()
        .insert(id.clone(), tx);

    let _ = app.emit(
        "review://request",
        serde_json::json!({
            "id": id,
            "agentId": agent_id,
            "title": title,
            "body": req.get("body").and_then(|s| s.as_str()).unwrap_or(""),
            "kind": req.get("kind").and_then(|s| s.as_str()).unwrap_or("choice"),
            "choices": req.get("choices").cloned().unwrap_or_else(|| serde_json::json!([])),
        }),
    );
    let e = app.state::<crate::AppState>().ledger.record(
        &agent_id,
        "review",
        &format!("awaiting your decision · {}", truncate(&title, 46)),
        1,
    );
    let _ = app.emit("ledger://entry", e);
    crate::pty::emit_status(app, &agent_id, AgentStatus::Blocked);

    // Block until review_respond delivers the decision.
    let decision = rx.recv().unwrap_or_default();
    app.state::<crate::AppState>()
        .reviews
        .lock()
        .unwrap()
        .remove(&id);
    crate::pty::emit_status(app, &agent_id, AgentStatus::Working);

    let _ = writer.write_all(
        (serde_json::json!({ "result": decision }).to_string() + "\n").as_bytes(),
    );
}

/// A risky command needs your go-ahead: render an Allow/Deny in the review
/// overlay and BLOCK until you decide. Driven by the `approve` permission gate.
fn handle_approve(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let command = req
        .get("command")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    let agent_id = req
        .get("agentId")
        .and_then(|s| s.as_str())
        .unwrap_or("jarvis")
        .to_string();
    let id = format!("rv-{}", REVIEW_SEQ.fetch_add(1, Ordering::Relaxed));

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    app.state::<crate::AppState>()
        .reviews
        .lock()
        .unwrap()
        .insert(id.clone(), tx);

    let _ = app.emit(
        "review://request",
        serde_json::json!({
            "id": id,
            "agentId": agent_id,
            "title": "Run command?",
            "body": format!("```sh\n{}\n```", command),
            "kind": "choice",
            "choices": ["Allow", "Deny"],
        }),
    );
    let e = app.state::<crate::AppState>().ledger.record(
        &agent_id,
        "command",
        &format!("awaiting approval · {}", truncate(&command, 46)),
        1,
    );
    let _ = app.emit("ledger://entry", e);
    crate::pty::emit_status(app, &agent_id, AgentStatus::Blocked);

    let decision = rx.recv().unwrap_or_default();
    app.state::<crate::AppState>()
        .reviews
        .lock()
        .unwrap()
        .remove(&id);
    crate::pty::emit_status(app, &agent_id, AgentStatus::Working);

    let approved = decision.starts_with("Allow");
    let _ = writer.write_all(
        (serde_json::json!({ "approved": approved }).to_string() + "\n").as_bytes(),
    );
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
