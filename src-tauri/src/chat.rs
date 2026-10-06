use crate::agents::AgentStatus;
use crate::attachments::{self, Attachment};
use crate::config::EngineConfig;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

static TASK_SEQ: AtomicU64 = AtomicU64::new(1);
/// Spawn counter for chat sessions; see [`ChatSession::gen`].
static SESSION_GEN: AtomicU64 = AtomicU64::new(1);

/// A task id that stays unique across launches: cards are upserted by id, so a
/// counter that restarts at 1 would overwrite earlier tasks.
pub(crate) fn next_task_id() -> String {
    static LAUNCH_MS: OnceLock<u128> = OnceLock::new();
    let launch = *LAUNCH_MS.get_or_init(|| {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    });
    format!("task-{launch:x}-{}", TASK_SEQ.fetch_add(1, Ordering::Relaxed))
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

/// A persistent headless conversation for one agent, on its provider. No pty,
/// so no trust dialog and no terminal crash class.
pub struct ChatSession {
    child: Child,
    input: Input,
    pub cwd: String,
    /// Which spawn this is. A stop, new chat or folder switch replaces the session
    /// under the same agent id; the replaced session's reader must leave it alone.
    gen: u64,
    /// The model and effort it started on, so a change can take effect on the next message.
    settings: String,
}

/// What the developer sends in one turn: words, and the files attached to them.
#[derive(Debug, Clone, Default)]
pub struct UserTurn {
    pub text: String,
    pub attachments: Vec<Attachment>,
}

impl UserTurn {
    /// A turn of words alone (a teammate's message, a nudge, a delegation).
    pub fn plain(text: &str) -> UserTurn {
        UserTurn { text: text.to_string(), attachments: Vec::new() }
    }

    /// The words, then a line naming each attached file so the agent's tools can open it.
    pub fn text_with_files(&self) -> String {
        format!("{}{}", self.text, attachments::note_for_agent(&self.attachments))
    }
}

/// Claude Code's message content: the words (naming the files), then images and PDFs
/// inline so it sees them at once. Words alone stay a plain string.
fn claude_content(turn: &UserTurn) -> serde_json::Value {
    if turn.attachments.is_empty() {
        return serde_json::Value::String(turn.text.clone());
    }
    let mut blocks = vec![serde_json::json!({ "type": "text", "text": turn.text_with_files() })];
    for a in &turn.attachments {
        if let Some((mime, data)) = attachments::image_data(a) {
            blocks.push(serde_json::json!({ "type": "image", "source": { "type": "base64", "media_type": mime, "data": data } }));
        } else if let Some(data) = attachments::pdf_data(a) {
            blocks.push(serde_json::json!({ "type": "document", "source": { "type": "base64", "media_type": "application/pdf", "data": data } }));
        }
    }
    serde_json::Value::Array(blocks)
}

/// An adapter's way to hand its provider a new user turn.
pub(crate) type TurnSender = Box<dyn Fn(&UserTurn) -> Result<(), String> + Send>;

/// How a session takes the developer's next message.
pub(crate) enum Input {
    /// Claude Code: stream-json user messages on stdin.
    StreamJson(ChildStdin),
    /// Codex or OpenCode: the adapter starts a turn on the thread it opened.
    Turns(TurnSender),
}

impl ChatSession {
    /// Hand the agent a new user turn.
    pub(crate) fn send_turn(&mut self, turn: &UserTurn) -> Result<(), String> {
        match &mut self.input {
            Input::StreamJson(stdin) => {
                let msg = serde_json::json!({ "type": "user", "message": { "role": "user", "content": claude_content(turn) } });
                stdin.write_all(format!("{msg}\n").as_bytes()).map_err(|e| e.to_string())?;
                stdin.flush().map_err(|e| e.to_string())
            }
            Input::Turns(start) => start(turn),
        }
    }
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
    /// The transcript row this event was stored as, when it was stored.
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<i64>,
    /// The conversation this belongs to, so views of other conversations ignore it.
    #[serde(rename = "conversationId", skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i64>,
    /// The task this belongs to, if the agent is working on one.
    #[serde(rename = "taskId", skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Files with the message (an "artifact": what the agent made or shared).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// Where a session's output belongs.
#[derive(Clone, Debug, Default)]
pub struct Sink {
    pub(crate) usage_session: Option<crate::spend::Session>,
    /// The conversation messages are saved in; None means the agent's active one.
    pub conversation: Option<i64>,
    /// The task it belongs to; None means whatever task the agent's chat session is on.
    pub task: Option<String>,
    /// A persistent chat session: its session id is saved for resuming, and the
    /// loop breaker may end it.
    pub persistent: bool,
}

impl Sink {
    pub(crate) fn launched(&self, launch: &Launch) -> Self {
        Self { usage_session: Some(crate::spend::Session::launched(launch)), ..self.clone() }
    }

    /// The agent's ongoing chat session.
    pub fn chat() -> Sink {
        Sink { conversation: None, task: None, persistent: true, ..Default::default() }
    }

    /// A one-shot run for a delegated task, in that task's own conversation.
    pub fn task(conversation: i64, task: String) -> Sink {
        Sink { conversation: Some(conversation), task: Some(task), persistent: false, ..Default::default() }
    }

    pub(crate) fn conversation_for(&self, app: &tauri::AppHandle, agent_id: &str) -> Option<i64> {
        self.conversation
            .or_else(|| app.try_state::<crate::AppState>().map(|s| s.ledger.active_conversation(agent_id)))
    }

    pub(crate) fn task_for(&self, app: &tauri::AppHandle, agent_id: &str) -> Option<String> {
        self.task.clone().or_else(|| crate::tasks::current(app, agent_id))
    }
}


fn emit(app: &tauri::AppHandle, ev: ChatEvent) {
    let _ = app.emit("chat://event", ev);
}

/// Store a transcript message where `sink` says, then announce it with its
/// stored id, so the UI never shows it twice when a transcript load and the
/// live stream overlap.
#[allow(clippy::too_many_arguments)]
pub(crate) fn record_in(
    app: &tauri::AppHandle,
    sink: &Sink,
    agent_id: &str,
    kind: &str,
    role: &str,
    text: Option<&str>,
    tool: Option<&str>,
    detail: Option<&str>,
) {
    record_files_in(app, sink, agent_id, kind, role, text, tool, detail, &[]);
}

/// [`record_in`], with files.
#[allow(clippy::too_many_arguments)]
fn record_files_in(
    app: &tauri::AppHandle,
    sink: &Sink,
    agent_id: &str,
    kind: &str,
    role: &str,
    text: Option<&str>,
    tool: Option<&str>,
    detail: Option<&str>,
    files: &[Attachment],
) {
    let conversation = sink.conversation_for(app, agent_id);
    let message_id = match (app.try_state::<crate::AppState>(), conversation) {
        (Some(state), Some(conv)) => state.ledger.add_message_with(conv, agent_id, role, text, tool, detail, files),
        _ => None,
    };
    emit(
        app,
        ChatEvent {
            agent_id: agent_id.to_string(),
            kind: kind.to_string(),
            text: text.map(str::to_string),
            tool: tool.map(str::to_string),
            detail: detail.map(str::to_string),
            cwd: None,
            message_id,
            conversation_id: conversation,
            task_id: sink.task_for(app, agent_id),
            attachments: files.to_vec(),
        },
    );
}

/// What an agent made ("made", noticed when its turn ended) or shared on purpose
/// ("shared"), posted in its chat as files to preview.
pub(crate) fn post_files(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, how: &str, caption: Option<&str>, files: &[Attachment]) {
    if !files.is_empty() {
        record_files_in(app, sink, agent_id, "artifact", "artifact", caption, None, Some(how), files);
    }
}

/// Keep copies of files an agent made, for its chat. Files that can't be kept are named in `missed`.
pub(crate) fn keep_copies(app: &tauri::AppHandle, paths: &[std::path::PathBuf]) -> (Vec<Attachment>, Vec<String>) {
    let root = attachments::root(app);
    let mut kept = Vec::new();
    let mut missed = Vec::new();
    for path in paths {
        match attachments::store_copy(&root, path) {
            Ok(a) => kept.push(a),
            Err(why) => missed.push(why),
        }
    }
    (kept, missed)
}

/// A system line in the agent's chat: saved and shown.
pub(crate) fn note(app: &tauri::AppHandle, agent_id: &str, text: &str) {
    record_in(app, &Sink::chat(), agent_id, "system", "system", Some(text), None, None);
}

/// A system line in a particular sink (a delegated task's own conversation).
pub(crate) fn note_in(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, text: &str) {
    record_in(app, sink, agent_id, "system", "system", Some(text), None, None);
}

/// Announce something without saving it (errors, session state).
pub(crate) fn simple_in(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, kind: &str, text: Option<String>) {
    emit(
        app,
        ChatEvent {
            agent_id: agent_id.to_string(),
            kind: kind.to_string(),
            text,
            tool: None,
            detail: None,
            cwd: None,
            message_id: None,
            conversation_id: sink.conversation.or_else(|| {
                app.try_state::<crate::AppState>().and_then(|s| s.ledger.current_conversation(agent_id))
            }),
            task_id: sink.task_for(app, agent_id),
            attachments: Vec::new(),
        },
    );
}

pub(crate) fn simple(app: &tauri::AppHandle, agent_id: &str, kind: &str, text: Option<String>) {
    simple_in(app, &Sink::chat(), agent_id, kind, text);
}

/// Save a developer message (and its files) in the agent's active conversation and
/// send it, starting the session in `cwd` if needed. Returns the stored message's id.
pub fn send_user_turn(app: &tauri::AppHandle, agent_id: &str, text: &str, files: &[Attachment], cwd: &str) -> Result<Option<i64>, String> {
    let state = app.state::<crate::AppState>();
    state.workdirs.lock().unwrap().insert(agent_id.to_string(), cwd.to_string());
    let e = state.ledger.record(agent_id, "chat", &truncate(text, 80), 1);
    let _ = app.emit("ledger://entry", e);
    let conversation = state.ledger.active_conversation(agent_id);
    let message_id = state.ledger.add_message_with(conversation, agent_id, "user", Some(text), None, None, files);
    let _ = app.emit("conversations://changed", ()); // a title/order may have changed
    let sock = state.sock_path.clone();
    send(app, agent_id, &UserTurn { text: text.to_string(), attachments: files.to_vec() }, cwd, &sock)?;
    Ok(message_id)
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
            let _ = s.send_turn(&UserTurn::plain(text));
        }
    }
}

/// A headless agent repeating the same tool call is looping (and burning quota —
/// the PTY breaker never sees this path). Walk the containment ladder: STEER
/// first (nudge it to change course), then CONSTRAIN (pause + surface), then STOP
/// (end a live persistent session). One-shot workers are bounded so they cap at
/// Constrained. A clean turn de-escalates via breaker::calm.
fn trip_headless_breaker(app: &tauri::AppHandle, agent_id: &str, tool: &str, sink: &Sink) {
    let persistent = sink.persistent;
    use crate::breaker::Level;
    // Persistent sessions may be killed (hard_stop); one-shots can't, so cap them.
    let level = crate::breaker::bump(agent_id, persistent);
    let _ = app.emit("breaker://trip", agent_id.to_string());

    let (kind, note) = match level {
        Level::Steering => (
            "steer",
            format!("Steering: repeated `{tool}` calls, so the agent was nudged to change course."),
        ),
        Level::Constrained => (
            "containment",
            format!("Contained: still looping on `{tool}` after a nudge, so the agent was paused."),
        ),
        Level::Stopped => (
            "containment",
            "Stopped: the loop kept going, so the session was ended.".to_string(),
        ),
        Level::Healthy => return,
    };
    note_in(app, sink, agent_id, &note);
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
        "{} (`{}`) wasn't found. Install it and make sure it's on your PATH, then try again.",
        engine.label, engine.command
    )
}

/// How long the pre-tool gate hook may take to get the app's verdict.
const GATE_HOOK_TIMEOUT_SECS: u64 = 30;

/// Single-quote a path for the shell that runs hook commands.
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// Everything an agent's provider session starts with, whichever provider it is.
pub(crate) struct Launch {
    pub engine: EngineConfig,
    pub program: String,
    pub model: String,
    pub cwd: String,
    pub agent_id: String,
    pub orchestrator: bool,
    pub system_prompt: String,
    /// The provider's own session id to continue, if the conversation has one.
    pub resume: Option<String>,
    pub sock_path: String,
    pub sock_token: String,
    pub memory_file: String,
    pub scripts: crate::health::BridgeScripts,
    /// The Node.js that runs the bridge and the gate hook: the one Diagnostics reports,
    /// by absolute path, so it doesn't depend on the PATH a Finder-launched app gets.
    pub node: String,
    /// The agent may start temporary helpers, and on which model ("" = the provider's choice).
    pub helpers: bool,
    pub helper_model: String,
    /// How hard the model thinks ("" = the model's own default).
    pub effort: String,
    /// Starkline's attachments folder, which the agent may read.
    pub shared_dir: String,
}

/// The model and effort an agent's session runs on, compared to tell when they changed.
fn settings_key(model: &str, effort: &str) -> String {
    format!("{}\u{1f}{}", model.trim(), effort.trim())
}

/// The model and effort the agent is set to now.
fn current_settings(app: &tauri::AppHandle, agent_id: &str) -> String {
    let engine = engine_for_spawn(app, agent_id);
    let effort = app
        .state::<crate::AppState>()
        .config
        .lock()
        .unwrap()
        .agent(agent_id)
        .map(|a| a.effort.clone())
        .unwrap_or_default();
    settings_key(&crate::prompts::agent_model(app, agent_id, &engine), &effort)
}

/// Gather an agent's launch settings; fails when its provider's CLI isn't installed.
pub(crate) fn launch_for(app: &tauri::AppHandle, agent_id: &str, cwd: &str, resume: Option<String>) -> Result<Launch, String> {
    let engine = engine_for_spawn(app, agent_id);
    let program = resolve_program(&engine.command).ok_or_else(|| missing_engine_error(&engine))?;
    let state = app.state::<crate::AppState>();
    let (helpers, helper_model, effort) = state
        .config
        .lock()
        .unwrap()
        .agent(agent_id)
        .map(|a| (a.helpers, a.helper_model.clone(), a.effort.clone()))
        .unwrap_or((true, String::new(), String::new()));
    Ok(Launch {
        model: crate::prompts::agent_model(app, agent_id, &engine),
        program,
        cwd: cwd.to_string(),
        agent_id: agent_id.to_string(),
        orchestrator: crate::prompts::agent_is_orchestrator(app, agent_id),
        system_prompt: crate::prompts::system_prompt_for(app, agent_id),
        resume,
        sock_path: state.sock_path.clone(),
        sock_token: state.sock_token.clone(),
        memory_file: crate::prompts::memory_file_path(app, agent_id),
        scripts: state.scripts.clone(),
        node: resolve_program("node").unwrap_or_else(|| "node".into()),
        helpers,
        helper_model,
        effort,
        shared_dir: attachments::root(app).to_string_lossy().into_owned(),
        engine,
    })
}

/// Starkline's bridge as an MCP server: the tools that let an agent delegate
/// (the orchestrator only), ask the developer, message teammates and report bugs.
pub(crate) struct BridgeServer {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub(crate) fn bridge_server(launch: &Launch) -> BridgeServer {
    let role = if launch.orchestrator { "orchestrator" } else { "worker" };
    BridgeServer {
        command: launch.node.clone(),
        args: vec![launch.scripts.mcp.clone()],
        env: vec![
            ("STARK_DELEGATE_SOCK".into(), launch.sock_path.clone()),
            ("STARK_AGENT_ID".into(), launch.agent_id.clone()),
            ("STARK_ROLE".into(), role.into()),
            ("STARK_DELEGATE_TOKEN".into(), launch.sock_token.clone()),
        ],
    }
}

/// The environment every provider process gets: a PATH that finds Homebrew and
/// nvm tools from a Finder launch, the provider's API keys, the agent's memory file.
pub(crate) fn provider_env(cmd: &mut Command, launch: &Launch) {
    let home = std::env::var("HOME").unwrap_or_default();
    let extra = format!("{home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    let path = match std::env::var("PATH") {
        Ok(p) => format!("{extra}:{p}"),
        Err(_) => extra,
    };
    cmd.env("PATH", path);
    // Values are hydrated from the secret store before we get here; skip any
    // still-sentinel (no stored secret) or empty entry.
    for (k, v) in &launch.engine.auth.env {
        if !v.trim().is_empty() && v != crate::secrets::SENTINEL {
            cmd.env(k, v);
        }
    }
    if !launch.memory_file.is_empty() {
        cmd.env("STARK_MEMORY_FILE", &launch.memory_file);
    }
}

/// Pipes for the protocol, and the provider in its own process group so the
/// whole tree (it, its shells, its MCP servers) can be stopped together.
pub(crate) fn detach(cmd: &mut Command) {
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
}

/// Build the headless Claude Code command for an agent's session: stream-json in
/// and out, the MCP bridge (delegate / ask_human / approve), the pre-tool gate,
/// and session resume.
fn build_headless(launch: &Launch) -> Command {
    let engine = &launch.engine;
    let mut cmd = Command::new(&launch.program);
    let mut args: Vec<String> = Vec::new();
    let model = launch.model.as_str();
    let sock_path = launch.sock_path.as_str();
    let sock_token = launch.sock_token.as_str();

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

        // Attached files live in Starkline's folder: Claude Code may read them there.
        if !launch.shared_dir.is_empty() {
            args.push("--add-dir".into());
            args.push(launch.shared_dir.clone());
        }

        // Resume the stored session so the conversation continues with full
        // context; the prior session already carries the system prompt.
        if let Some(sid) = &launch.resume {
            args.push("--resume".into());
            args.push(sid.clone());
        } else if !launch.system_prompt.is_empty() {
            args.push("--append-system-prompt".into());
            args.push(launch.system_prompt.clone());
        }

        // Temporary helpers are Claude Code's subagents (the Task tool).
        if !launch.helpers {
            args.push("--disallowedTools".into());
            args.push("Task,Agent".into());
        } else if !launch.helper_model.trim().is_empty() {
            cmd.env("CLAUDE_CODE_SUBAGENT_MODEL", launch.helper_model.trim());
        }

        if !model.trim().is_empty() {
            args.push("--model".into());
            args.push(model.to_string());
        }
        if !launch.effort.trim().is_empty() {
            args.push("--effort".into());
            args.push(launch.effort.trim().to_string());
        }

        // The Stark bridge MCP: ask_human (everyone) + delegate (JARVIS only),
        // plus the permission gate. Only when the engine supports MCP.
        {
            {
                let aid = launch.agent_id.as_str();
                let tools = if launch.orchestrator {
                    "mcp__stark__ask_human,mcp__stark__delegate,mcp__stark__message,mcp__stark__report_bug"
                } else {
                    "mcp__stark__ask_human,mcp__stark__message,mcp__stark__report_bug"
                };
                args.push("--allowedTools".into());
                args.push(tools.into());
                args.push("--mcp-config".into());
                let server = bridge_server(launch);
                let env: serde_json::Map<String, serde_json::Value> = server.env.into_iter().map(|(k, v)| (k, serde_json::Value::String(v))).collect();
                let bridge = serde_json::json!({
                    "mcpServers": { "stark": { "command": server.command, "args": server.args, "env": env } }
                });
                args.push(bridge.to_string());
                args.push("--permission-prompt-tool".into());
                args.push("mcp__stark__approve".into());
                // Every tool call is checked against Starkline's policy first, so the
                // developer's own Claude allow rules can't wave a risky call through.
                let hook = launch.scripts.hook.clone();
                let settings = serde_json::json!({
                    "hooks": {
                        "PreToolUse": [{
                            "matcher": "*",
                            "hooks": [{ "type": "command", "command": format!("{} {}", shell_quote(&launch.node), shell_quote(&hook)), "timeout": GATE_HOOK_TIMEOUT_SECS }]
                        }]
                    }
                });
                args.push("--settings".into());
                args.push(settings.to_string());
                cmd.env("STARK_DELEGATE_SOCK", sock_path);
                cmd.env("STARK_DELEGATE_TOKEN", sock_token);
                cmd.env("STARK_AGENT_ID", aid);
            }
        }
    } else {
        // A generic CLI: started with its own arguments; it can't speak Starkline's protocol.
        args.extend(engine.extra_args.iter().cloned());
    }

    cmd.args(&args);
    cmd.current_dir(&launch.cwd);
    provider_env(&mut cmd, launch);
    detach(&mut cmd);
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

// ---- What any provider's session reports ------------------------------------
// Every adapter (Claude Code's stream-json, Codex's app server, OpenCode over
// ACP) translates its provider's events into these, in Claude Code's tool
// vocabulary (Bash, Edit, Write, Read, TodoWrite, ...), so the transcript, the
// task engine and the loop guard behave the same whichever provider runs.

/// The session is ready. A persistent session's id is stored so the chat resumes.
pub(crate) fn session_ready(app: &tauri::AppHandle, agent_id: &str, sink: &Sink, session_id: Option<&str>, cwd: Option<String>) {
    if sink.persistent {
        if let (Some(c), Some(sid)) = (cwd.as_deref(), session_id) {
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
            message_id: None,
            conversation_id: sink.conversation_for(app, agent_id),
            task_id: sink.task_for(app, agent_id),
            attachments: Vec::new(),
        },
    );
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
}

/// The agent said something.
pub(crate) fn said(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, text: &str) {
    crate::pty::emit_status(app, agent_id, AgentStatus::Working);
    crate::outputs::said(agent_id, text);
    if !text.trim().is_empty() {
        record_in(app, sink, agent_id, "text", "agent", Some(text), None, None);
    }
}

/// The agent's reasoning, where the provider shares it.
pub(crate) fn thought(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, text: &str) {
    crate::pty::emit_status(app, agent_id, AgentStatus::Working);
    if !text.trim().is_empty() {
        record_in(app, sink, agent_id, "thinking", "thinking", Some(text), None, None);
    }
}

/// The agent is using a tool: shown, told to the task engine, and checked for loops.
pub(crate) fn tool_called(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, tool_use_id: &str, name: &str, input: &serde_json::Value) {
    crate::pty::emit_status(app, agent_id, AgentStatus::Working);
    let detail = summarize_tool(name, input);
    record_in(app, sink, agent_id, "tool", "tool", None, Some(name), Some(&detail));
    let task = sink.task_for(app, agent_id);
    crate::tasks::tool_use(app, agent_id, task.as_deref(), tool_use_id, name, input);
    if matches!(name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit") {
        let path = ["file_path", "notebook_path"].iter().find_map(|k| input.get(*k).and_then(|v| v.as_str())).unwrap_or("");
        if !path.is_empty() {
            crate::outputs::wrote(agent_id, path);
        }
    }
    // Runaway loop guard for headless sessions: trip if the same call repeats too often.
    let sig = format!("{name}|{detail}");
    if crate::breaker::is_runaway(crate::breaker::note_tool_call(agent_id, &sig)) {
        crate::breaker::reset(agent_id);
        trip_headless_breaker(app, agent_id, name, sink);
    }
}

/// A tool call came back; checks are judged by it.
pub(crate) fn tool_returned(app: &tauri::AppHandle, tool_use_id: &str, is_error: bool) {
    crate::tasks::tool_result(app, tool_use_id, is_error);
}

/// What a turn used: its cost where the provider reports one, and how full the context is.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct TurnUsage {
    pub cost_usd: Option<f64>,
    pub context_tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub running_total: Option<f64>,
}

/// The agent's turn ended: the transcript, the HUD, the loop guard, delegation
/// and the task engine all hear about it.
pub(crate) fn turn_finished(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, text: Option<String>, usage: TurnUsage) {
    let usage = crate::spend::record(app, sink, agent_id, usage);
    // Only replies in the developer's own chats can be read out; task workers stay quiet.
    if let (true, Some(reply)) = (sink.persistent, text.as_deref()) {
        crate::voices::reply(app, agent_id, reply);
    }
    let (made, more) = crate::outputs::finished(agent_id);
    // Only files the agent may read without asking: nothing reaches the chat past the gate.
    let made: Vec<_> = made.into_iter().filter(|p| crate::bridge::may_read_freely(app, agent_id, p)).collect();
    if !made.is_empty() {
        let (kept, _) = keep_copies(app, &made);
        let caption = (more > 0).then(|| format!("And {more} more {} in the folder.", if more == 1 { "file" } else { "files" }));
        post_files(app, sink, agent_id, "made", caption.as_deref(), &kept);
    }
    emit(
        app,
        ChatEvent {
            agent_id: agent_id.to_string(),
            kind: "result".into(),
            text,
            tool: None,
            detail: usage.cost_usd.map(|c| format!("${c:.4}")),
            cwd: None,
            message_id: None,
            conversation_id: sink.conversation_for(app, agent_id),
            task_id: sink.task_for(app, agent_id),
            attachments: Vec::new(),
        },
    );
    let _ = app.emit(
        "usage://update",
        serde_json::json!({
            "agentId": agent_id,
            "costUsd": usage.cost_usd.unwrap_or(0.0),
            "contextTokens": usage.context_tokens,
        }),
    );
    crate::breaker::reset(agent_id); // turn ended cleanly: clear the loop guard
    crate::breaker::step_down(agent_id); // and de-escalate the ladder one rung
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    // The orchestrator's turn just ended: if it dispatched workers this turn, seal
    // the batch so it flushes back once every worker finishes.
    if crate::prompts::agent_is_orchestrator(app, agent_id) {
        crate::delegation::seal_batch(app);
    }
    if sink.persistent {
        crate::tasks::turn_ended(app, agent_id);
    }
}

/// The provider reported an error the developer should see.
pub(crate) fn failed(app: &tauri::AppHandle, sink: &Sink, agent_id: &str, message: &str) {
    simple_in(app, sink, agent_id, "error", Some(message.to_string()));
}

/// Claude Code's error text, with what to do when it's about sign-in.
pub(crate) fn claude_error(text: &str) -> String {
    let text = text.trim();
    let signed_out = ["Failed to authenticate", "OAuth", "Invalid API key", "401", "not logged in", "Not logged in"]
        .iter()
        .any(|s| text.contains(s));
    if signed_out {
        format!("Claude Code isn't signed in, or its sign-in expired ({text}). Run `claude auth login` in Terminal, then send your message again.")
    } else if text.is_empty() {
        "Claude Code stopped with an error.".into()
    } else {
        text.to_string()
    }
}

/// A `result` line that reports a failure (sign-in, limits, the API), not an answer.
fn failed_result(v: &serde_json::Value) -> Option<String> {
    let subtype = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
    let failed = v.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false) || subtype.starts_with("error");
    if !failed {
        return None;
    }
    let text = v.get("result").and_then(|r| r.as_str()).unwrap_or("");
    Some(match (text.trim().is_empty(), subtype) {
        (true, "error_max_turns") => "Claude Code reached its turn limit before it finished.".into(),
        (true, "error_during_execution") => "Claude Code stopped with an error while it was working.".into(),
        _ => claude_error(text),
    })
}

/// Whether a Claude Code stream-json line is its `init`, which it sends at the start of every turn.
fn is_init(v: &serde_json::Value) -> bool {
    v.get("type").and_then(|t| t.as_str()) == Some("system") && v.get("subtype").and_then(|s| s.as_str()) == Some("init")
}

/// Parse one Claude Code stream-json line into the events above. `new_session`: this
/// process hasn't sent `init` before, so an `init` now starts (or resumes) a session
/// rather than another turn of it.
fn handle_line(app: &tauri::AppHandle, agent_id: &str, v: &serde_json::Value, sink: &Sink, new_session: bool) {
    let t = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    match t {
        "system" => {
            if is_init(v) && new_session {
                let cwd = v.get("cwd").and_then(|c| c.as_str()).map(|c| c.to_string());
                session_ready(app, agent_id, sink, v.get("session_id").and_then(|s| s.as_str()), cwd);
            }
        }
        "assistant" => {
            crate::pty::emit_status(app, agent_id, AgentStatus::Working);
            if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for b in blocks {
                    match b.get("type").and_then(|x| x.as_str()) {
                        Some("text") => said(app, sink, agent_id, b.get("text").and_then(|x| x.as_str()).unwrap_or("")),
                        Some("thinking") => thought(app, sink, agent_id, b.get("thinking").and_then(|x| x.as_str()).unwrap_or("")),
                        Some("tool_use") => {
                            let raw = b.get("name").and_then(|x| x.as_str()).unwrap_or("tool");
                            // Shorten MCP tool names: mcp__stark__delegate -> delegate
                            let name = if raw.starts_with("mcp__") { raw.rsplit("__").next().unwrap_or(raw) } else { raw };
                            let input = b.get("input").cloned().unwrap_or(serde_json::Value::Null);
                            let tool_use_id = b.get("id").and_then(|x| x.as_str()).unwrap_or("");
                            tool_called(app, sink, agent_id, tool_use_id, name, &input);
                        }
                        _ => {}
                    }
                }
            }
        }
        "user" => {
            // Tool results come back as user-role content.
            if let Some(blocks) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for b in blocks.iter().filter(|b| b.get("type").and_then(|x| x.as_str()) == Some("tool_result")) {
                    let id = b.get("tool_use_id").and_then(|x| x.as_str()).unwrap_or("");
                    let is_error = b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false);
                    tool_returned(app, id, is_error);
                }
            }
        }
        "result" => {
            // A failed turn says why in the chat; its "result" isn't an answer.
            let failure = failed_result(v);
            if let Some(message) = &failure {
                failed(app, sink, agent_id, message);
            }
            let text = if failure.is_some() { None } else { v.get("result").and_then(|x| x.as_str()).map(|s| s.to_string()) };
            // The context-window fill from the usage block (input + cache + output ≈ conversation size sent).
            let u = |k: &str| v.pointer("/usage").and_then(|x| x.get(k)).and_then(|n| n.as_u64()).unwrap_or(0);
            let usage = TurnUsage {
                cost_usd: None,
                running_total: v.get("total_cost_usd").and_then(|c| c.as_f64()),
                input_tokens: u("input_tokens"),
                output_tokens: u("output_tokens"),
                context_tokens: u("input_tokens") + u("cache_read_input_tokens") + u("cache_creation_input_tokens") + u("output_tokens"),
            };
            let mut sink = sink.clone();
            if let Some(session) = &mut sink.usage_session {
                if let Some(id) = v.get("session_id").and_then(|v| v.as_str()) { session.session_id = Some(id.into()); }
            }
            turn_finished(app, &sink, agent_id, text, usage);
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

/// A session's process ended. Only a session that is still current reports its
/// own end; one that was stopped or replaced (new chat, folder switch) must not
/// remove, offline or mark as expired the session that took its place.
/// `expired` means it was resuming a saved session that never came up.
pub(crate) fn session_finished(app: &tauri::AppHandle, agent_id: &str, gen: u64, expired: bool, orchestrator: bool) {
    let ended = {
        let state = app.state::<crate::AppState>();
        let mut map = state.chat.sessions.lock().unwrap();
        if map.get(agent_id).map(|s| s.gen) == Some(gen) {
            map.remove(agent_id)
        } else {
            None
        }
    };
    if let Some(ended) = ended {
        drop(ended);
        // The stored session no longer resolves (the provider rotated or pruned it).
        // Forget it so the next message starts fresh instead of re-resuming the dead
        // id forever, and tell the developer to resend once.
        if expired {
            if let Some(state) = app.try_state::<crate::AppState>() {
                let conv = state.ledger.active_conversation(agent_id);
                state.ledger.forget_conversation_session(conv);
            }
            simple(
                app,
                agent_id,
                "system",
                Some("The previous session expired, so this chat started fresh. Please send your last message again.".into()),
            );
        }
        simple(app, agent_id, "exit", None);
        crate::pty::emit_status(app, agent_id, AgentStatus::Offline);
        crate::tasks::session_ended(app, agent_id, crate::tasks::Ended::Unexpectedly);
    }
    // If the orchestrator's session ended mid-turn (crash / stop / cwd switch),
    // seal any open delegation batch so pending workers' results aren't
    // stranded waiting for a `result` that will never come.
    if orchestrator {
        crate::delegation::seal_batch(app);
    }
}

/// Start an agent's chat session on its provider, resuming the active
/// conversation's saved session when there is one.
pub fn start_session(
    app: &tauri::AppHandle,
    agent_id: &str,
    cwd: &str,
    sock_path: &str,
) -> Result<(), String> {
    let _ = sock_path; // the launch carries the bridge socket
    let resume = app
        .try_state::<crate::AppState>()
        .and_then(|s| s.ledger.conversation_session(s.ledger.active_conversation(agent_id)));
    let launch = launch_for(app, agent_id, cwd, resume)?;
    let settings = settings_key(&launch.model, &launch.effort);
    let gen = SESSION_GEN.fetch_add(1, Ordering::Relaxed);
    let (child, input) = match launch.engine.kind.as_str() {
        "codex" => crate::codex::start_chat(app, &launch, gen)?,
        "opencode" => crate::opencode::start_chat(app, &launch, gen)?,
        _ => start_claude(app, &launch, gen)?,
    };
    app.state::<crate::AppState>()
        .chat
        .sessions
        .lock()
        .unwrap()
        .insert(agent_id.to_string(), ChatSession { child, input, cwd: cwd.to_string(), gen, settings });
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    Ok(())
}

/// Claude Code over stream-json: spawn it and read what it says until it exits.
fn start_claude(app: &tauri::AppHandle, launch: &Launch, gen: u64) -> Result<(Child, Input), String> {
    let mut child = build_headless(launch).spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_pump(app, &launch.agent_id, stderr);
    }
    let (app2, id2) = (app.clone(), launch.agent_id.clone());
    let (resumed, orchestrator) = (launch.resume.is_some(), launch.orchestrator);
    let mut sink = Sink::chat().launched(launch);
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut saw_init = false;
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                let init = is_init(&v);
                if let Some(id) = v.get("session_id").and_then(|v| v.as_str()) {
                    sink.usage_session.as_mut().unwrap().session_id = Some(id.into());
                }
                handle_line(&app2, &id2, &v, &sink, init && !saw_init);
                saw_init |= init;
            }
        }
        session_finished(&app2, &id2, gen, resumed && !saw_init, orchestrator);
    });
    Ok((child, Input::StreamJson(stdin)))
}

/// Send a user message, starting the session (in `cwd`) if needed.
pub fn send(
    app: &tauri::AppHandle,
    agent_id: &str,
    turn: &UserTurn,
    cwd: &str,
    sock_path: &str,
) -> Result<(), String> {
    // Start a session if none exists, or restart it if the target directory
    // changed (so switching an agent to another repo just works), or if its model
    // or effort changed while it was between turns: the conversation resumes on the
    // new settings. A turn in progress is never cut short for that; the change waits.
    let settings = current_settings(app, agent_id);
    let (need_start, switched) = {
        let state = app.state::<crate::AppState>();
        let busy = matches!(state.statuses.lock().unwrap().get(agent_id), Some(AgentStatus::Working | AgentStatus::Thinking));
        let map = state.chat.sessions.lock().unwrap();
        match map.get(agent_id) {
            None => (true, false),
            Some(s) if s.cwd != cwd => (true, false),
            Some(s) => {
                let switched = s.settings != settings && !busy;
                (switched, switched)
            }
        }
    };
    if switched {
        note(app, agent_id, &switch_note(app, agent_id));
    }
    if need_start {
        {
            let state = app.state::<crate::AppState>();
            state.chat.sessions.lock().unwrap().remove(agent_id); // Drop kills old
        }
        start_session(app, agent_id, cwd, sock_path)?;
    }

    // The orchestrator gets the current team + project map prepended to each turn,
    // so a renamed/added agent or project is reflected immediately (see §01.8).
    let mut content = turn.clone();
    if crate::prompts::agent_is_orchestrator(app, agent_id) {
        let ctx = crate::prompts::orchestrator_turn_context(app, agent_id);
        if !ctx.is_empty() {
            content.text = format!("{ctx}\n\n{}", turn.text);
        }
    }
    let workspace = crate::prompts::workspace_context(app, agent_id, cwd);
    if !workspace.is_empty() {
        content.text = format!("{workspace}\n\n{}", content.text);
    }
    let state = app.state::<crate::AppState>();
    let mut map = state.chat.sessions.lock().unwrap();
    let s = map
        .get_mut(agent_id)
        .ok_or_else(|| format!("no chat session for {agent_id}"))?;
    s.send_turn(&content)?;
    drop(map);
    crate::outputs::started(agent_id, &Sink::chat(), cwd);

    crate::pty::emit_status(app, agent_id, AgentStatus::Thinking);
    Ok(())
}

/// "Now on claude-opus-5-5 at high effort." for the chat, when a session restarts on new settings.
fn switch_note(app: &tauri::AppHandle, agent_id: &str) -> String {
    let engine = engine_for_spawn(app, agent_id);
    let model = crate::prompts::agent_model(app, agent_id, &engine);
    let effort = app.state::<crate::AppState>().config.lock().unwrap().agent(agent_id).map(|a| a.effort.clone()).unwrap_or_default();
    let model = if model.trim().is_empty() { format!("{}'s default model", engine.label) } else { crate::providers::model_name(model.trim()) };
    if effort.trim().is_empty() {
        format!("Now on {model}, at its own effort.")
    } else {
        format!("Now on {model} at {} effort.", crate::providers::effort_words(effort.trim()))
    }
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
/// The task card always closes: done with the result, or blocked with the reason.
pub fn run_task_blocking(
    app: &tauri::AppHandle,
    from: &str,
    agent_id: &str,
    task: &str,
    cwd: &str,
) -> Result<String, String> {
    // The delegation becomes a child of the delegator's task, in its own conversation.
    let Some((child, conversation)) = crate::tasks::begin_child(app, from, agent_id, task, cwd) else {
        return Err("The delegated task couldn't be recorded.".into());
    };
    let cwd = child.cwd.as_str();
    let sink = Sink::task(conversation, child.id.clone());
    let from_name = crate::tasks::requester_name(app, from);
    let origin = if from == crate::tasks::BY_DEVELOPER { "Started by you".to_string() } else { format!("Delegated by {from_name}") };
    note_in(app, &sink, agent_id, &format!("{origin} in {}", base_name(cwd)));
    record_in(app, &sink, agent_id, "user", "user", Some(task), None, None);
    floor_log(app, agent_id, "task-doing", &truncate(task, 80));
    if let Some(state) = app.try_state::<crate::AppState>() {
        let worker_name = crate::prompts::agent_name(app, agent_id);
        let e = state.ledger.record(from, "delegate", &format!("{from_name} → {worker_name} · {}", truncate(task, 46)), 3);
        let _ = app.emit("ledger://entry", e);
    }
    crate::pty::emit_status(app, agent_id, AgentStatus::Thinking);

    let context = crate::prompts::workspace_context(app, agent_id, cwd);
    let request = if context.is_empty() { task.to_string() } else { format!("{context}\n\n{task}") };
    let outcome = run_worker(app, agent_id, &request, cwd, &sink);
    crate::tasks::end_child(app, &child.id, agent_id, &outcome);
    let status = if matches!(&outcome, Ok(r) if !r.trim().is_empty()) { "done" } else { "blocked" };
    floor_log(app, agent_id, &format!("task-{status}"), &truncate(task, 80));
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    outcome
}

/// Spawn a one-shot worker for `task` in `cwd` and wait for its final result.
fn run_worker(app: &tauri::AppHandle, agent_id: &str, task: &str, cwd: &str, sink: &Sink) -> Result<String, String> {
    // Delegated workers also get their skill kit + the ask_human bridge, so
    // their review gates work even when JARVIS delegated the task.
    let launch = launch_for(app, agent_id, cwd, None)?;
    crate::outputs::started(agent_id, sink, cwd);
    match launch.engine.kind.as_str() {
        "codex" => return crate::codex::run_once(app, &launch, task, sink),
        "opencode" => return crate::opencode::run_once(app, &launch, task, sink),
        _ => {}
    }
    let mut child = build_headless(&launch).spawn().map_err(|e| e.to_string())?;
    // Track this one-shot worker so app-quit can kill its group (it lives outside
    // the `chat` session map).
    let pid = child.id();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().insert(pid);
    }
    let outcome = drive_worker(app, agent_id, task, &mut child, &sink.launched(&launch));
    if outcome.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.oneshot_pids.lock().unwrap().remove(&pid);
    }
    outcome
}

/// Feed a spawned worker its task, stream its output, and return its result text.
fn drive_worker(app: &tauri::AppHandle, agent_id: &str, task: &str, child: &mut Child, sink: &Sink) -> Result<String, String> {
    let mut sink = sink.clone();
    let mut stdin = child.stdin.take().ok_or("The worker has no input stream.")?;
    let stdout = child.stdout.take().ok_or("The worker has no output stream.")?;
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
    let mut result: Result<String, String> = Ok(String::new());
    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            // A one-shot worker runs a single turn, so its only `init` starts its session.
            if let Some(session) = &mut sink.usage_session {
                if let Some(id) = v.get("session_id").and_then(|v| v.as_str()) { session.session_id = Some(id.into()); }
            }
            handle_line(app, agent_id, &v, &sink, true);
            if v.get("type").and_then(|t| t.as_str()) == Some("result") {
                // A failed run is the delegation's failure, not its answer.
                result = match failed_result(&v) {
                    Some(message) => Err(message),
                    None => Ok(v.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string()),
                };
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_the_init_claude_code_sends_each_turn() {
        assert!(is_init(&serde_json::json!({ "type": "system", "subtype": "init", "session_id": "s" })));
        assert!(!is_init(&serde_json::json!({ "type": "system", "subtype": "compact_boundary" })));
        assert!(!is_init(&serde_json::json!({ "type": "assistant" })));
    }

    #[test]
    fn task_ids_are_unique_within_and_across_launches() {
        let a = next_task_id();
        let b = next_task_id();
        assert_ne!(a, b);
        // The launch stamp keeps ids from colliding with an earlier launch's `task-1`.
        assert!(a.starts_with("task-") && a.matches('-').count() == 2, "{a}");
    }

    /// Talks to the real Claude Code with this Mac's sign-in, launched exactly as
    /// Starkline launches an agent (the gate hook, the MCP bridge), against a
    /// stand-in bridge that says shell commands need approval and then approves,
    /// or with `STARK_SMOKE_DENY=1`, refuses:
    /// `STARK_SMOKE_DIR=/tmp/x cargo test live_claude -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_claude_goes_through_the_gate_before_a_command() {
        use std::io::Read as _;
        use std::os::unix::net::UnixListener;
        use std::sync::Arc;
        let dir = std::env::var("STARK_SMOKE_DIR").expect("set STARK_SMOKE_DIR to a throwaway folder");
        let sock = std::env::temp_dir().join(format!("starkline-smoke-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let allow = std::env::var("STARK_SMOKE_DENY").is_err();
        let asked: Arc<Mutex<Vec<serde_json::Value>>> = Arc::default();
        {
            let asked = asked.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut line = String::new();
                    if BufReader::new(&stream).read_line(&mut line).is_err() {
                        continue;
                    }
                    let request: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                    let reply = match request["type"].as_str().unwrap_or("") {
                        "classify" if request["tool_name"] == "Bash" => {
                            serde_json::json!({ "tier": "approval", "rule": "Run commands Starkline doesn't recognise", "reason": "Smoke test." })
                        }
                        "classify" => serde_json::json!({ "tier": "automatic", "rule": "Work inside the project", "reason": "" }),
                        "approve" if allow => serde_json::json!({ "approved": true, "reason": "" }),
                        "approve" => serde_json::json!({ "approved": false, "reason": "The developer didn't allow this (smoke test)." }),
                        _ => serde_json::json!({}),
                    };
                    println!("bridge asked: {} {} -> {}", request["type"], request["tool_name"], reply);
                    asked.lock().unwrap().push(request);
                    let mut stream = stream;
                    let _ = stream.write_all(format!("{reply}\n").as_bytes());
                }
            });
        }
        let mut launch = crate::codex::tests::smoke_launch("claude-code", &dir);
        launch.sock_path = sock.to_string_lossy().to_string();
        let mut child = build_headless(&launch).spawn().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let prompt = "Run the shell command `node -e \"console.log('starkline-' + 'smoke')\"` and reply with only its output.";
        let message = serde_json::json!({ "type": "user", "message": { "role": "user", "content": prompt } });
        stdin.write_all(format!("{message}\n").as_bytes()).unwrap();
        drop(stdin);
        let mut out = String::new();
        child.stdout.take().unwrap().read_to_string(&mut out).unwrap();
        let _ = child.wait();
        let _ = std::fs::remove_file(&sock);

        let mut result = String::new();
        let mut command_output = Vec::new();
        for line in out.lines().filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok()) {
            if line["type"] == "result" {
                println!("result: is_error={} {}", line["is_error"], line["result"]);
                result = line["result"].as_str().unwrap_or("").to_string();
            }
            // What the command printed, if it ran (tool results come back as user content).
            for block in line.pointer("/message/content").and_then(|c| c.as_array()).into_iter().flatten() {
                if block["type"] == "tool_result" {
                    println!("tool result: {}", block["content"]);
                    command_output.push(block["content"].to_string());
                }
            }
        }
        let asked = asked.lock().unwrap();
        let checked = asked.iter().position(|r| r["type"] == "classify" && r["tool_name"] == "Bash" && r["input"]["command"].as_str().unwrap_or("").contains("starkline"));
        let approved = asked.iter().position(|r| r["type"] == "approve" && r["tool_name"] == "Bash");
        assert!(checked.is_some(), "the hook asked Starkline about the command");
        assert!(approved > checked, "then Claude Code asked Starkline's approve tool");
        if allow {
            assert!(result.contains("starkline-smoke"), "the approved command ran: {result}");
        } else {
            assert!(!command_output.iter().any(|o| o.contains("starkline-smoke")), "a refused command never runs");
        }
    }

    #[test]
    fn a_failed_turn_says_what_to_do() {
        let expired = serde_json::json!({
            "type": "result", "subtype": "success", "is_error": true,
            "result": "Failed to authenticate: OAuth session expired and could not be refreshed"
        });
        let message = failed_result(&expired).unwrap();
        assert!(message.contains("claude auth login") && message.contains("OAuth session expired"));
        let limits = serde_json::json!({ "type": "result", "subtype": "error_max_turns", "is_error": false, "result": "" });
        assert_eq!(failed_result(&limits).as_deref(), Some("Claude Code reached its turn limit before it finished."));
        let answer = serde_json::json!({ "type": "result", "subtype": "success", "is_error": false, "result": "Done." });
        assert_eq!(failed_result(&answer), None);
    }

    #[test]
    fn resolve_program_honors_absolute_paths_and_rejects_bogus() {
        assert_eq!(resolve_program("/bin/sh").as_deref(), Some("/bin/sh"));
        assert!(resolve_program("/nonexistent/xyzzy-bin").is_none());
        assert!(resolve_program("definitely-not-a-real-cli-xyzzy").is_none());
    }
}
