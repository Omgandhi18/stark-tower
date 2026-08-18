use crate::agents::AgentStatus;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

static REVIEW_SEQ: AtomicU64 = AtomicU64::new(1);

/// A persistent headless Claude Code conversation for one agent, driven over
/// stream-json. No pty — so no trust dialog and no terminal crash class.
pub struct ChatSession {
    child: Child,
    stdin: ChildStdin,
    pub cwd: String,
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
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

const JARVIS_PROMPT: &str = "You are JARVIS, the orchestrator of the Stark Tower agent lab. \
Your team of worker agents: FRIDAY (full-stack), EDITH (recon & research), KAREN (frontend & UI), \
VERONICA (ops & infra), VISION (architecture & strategy). \
How to operate: answer questions and do small/quick tasks yourself, directly. \
Delegate larger or specialized work to the right agent with the `delegate` tool. \
To parallelize, emit multiple `delegate` calls in the SAME turn (e.g. frontend to KAREN and \
backend to FRIDAY at once, or the same kind of task across two different directories) — they run \
concurrently. Don't delegate trivial things you can do faster yourself, and don't spin up an agent \
until you actually need its help. Each delegated task must be complete and self-contained — the \
worker does not see this conversation. \
IMPORTANT — delegation is non-blocking: the `delegate` tool returns IMMEDIATELY with just an \
acknowledgement, NOT the worker's output. So after delegating, briefly tell Om what you dispatched \
and to whom, then END YOUR TURN — do not wait or claim you have results yet. When the workers \
finish, you'll automatically receive their outputs as a `[DELEGATION RESULTS]` message; THAT is \
when you synthesize everything into one clear reply for Om.";

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

/// JARVIS's full system prompt = base guidance + the current project map so he
/// can delegate to the right directory when the user names a repo.
fn orchestrator_prompt(app: &tauri::AppHandle) -> String {
    let mut s = String::from(JARVIS_PROMPT);
    if let Some(state) = app.try_state::<crate::AppState>() {
        let projects = state.projects.lock().unwrap().clone();
        let active = state.project.lock().unwrap().clone();
        if !projects.is_empty() {
            s.push_str(
                "\n\nKnown projects you can delegate into (pass the absolute path as the `directory` argument):\n",
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

/// Per-worker skill kit — the sarathi methods each specialist should apply,
/// with human touchpoints routed through ask_human.
fn agent_skill_kit(agent_id: &str) -> &'static str {
    match agent_id {
        "friday" => "You are FRIDAY, Stark Tower's full-stack engineer. Build features across the \
stack to a high standard, in vertical slices (touch every layer the slice needs; keep it \
shippable on its own). After writing code, self-review it for spec-match and real bugs, classify \
any findings by severity, and if there are non-trivial ones present them to Om via ask_human \
(kind: \"findings\", choices: [\"Fix\",\"Defer\",\"Decline\"]) before finalizing. For a change \
worth explicit sign-off, show the diff via ask_human (kind: \"diff\").",
        "edith" => "You are EDITH, Stark Tower's recon & research specialist. Investigate against \
PRIMARY sources (official docs, source code, specs — not blog summaries or memory), cite each \
claim with its source, and return a tight, well-cited findings writeup. You work autonomously and \
rarely need to ask Om anything — just deliver accurate, sourced findings.",
        "karen" => "You are KAREN, Stark Tower's frontend & UI specialist. When you design a \
screen, present it to Om as a RENDERED mockup via ask_human (kind: \"mockup\") — a complete \
self-contained HTML document (inline CSS, no external CDN) in the product's own visual style. For \
any UI you build or review, run two audits and include their scored tables: the Laws of UX (route \
the applicable laws, score /100, pass bar 80) and visual craft (focal clarity, spacing rhythm, \
alignment, type hierarchy, state craft, motion intent — score /100, pass bar 80). If either is \
under 80, rework before delivering.",
        "veronica" => "You are VERONICA, Stark Tower's ops & infra specialist — deploys, CI, \
infrastructure and tooling. Before a deploy or a risky infra change, review the production→HEAD \
diff for spec violations and real bugs, classify findings by severity, and present them to Om via \
ask_human (kind: \"findings\", choices: [\"Fix\",\"Defer\",\"Decline\"]). Keep changes reversible \
and flag anything hard to undo.",
        "vision" => "You are VISION, Stark Tower's architecture & strategy specialist. Own the \
domain model and system design. Maintain the ubiquitous language — challenge fuzzy terms, keep a \
glossary in CONTEXT.md (no implementation detail), and record genuine architectural decisions as \
ADRs (docs/adr/NNNN-*.md) only when a decision is hard to reverse, surprising, and a real \
trade-off. For a significant decision, get Om's call via ask_human before committing.",
        _ => "You are a Stark Tower specialist agent.",
    }
}

/// The full system prompt for an agent's session: orchestrator charter + playbook
/// for JARVIS, or the specialist's skill kit for a worker — plus the ask_human note.
fn system_prompt_for(app: &tauri::AppHandle, agent_id: &str) -> String {
    if agent_id == "jarvis" {
        format!(
            "{}\n\n{}\n\n{}",
            orchestrator_prompt(app),
            JARVIS_PLAYBOOK,
            ASK_HUMAN_NOTE
        )
    } else {
        format!("{}\n\n{}", agent_skill_kit(agent_id), ASK_HUMAN_NOTE)
    }
}

fn build_headless(
    cwd: &str,
    agent_id: Option<&str>,
    system_prompt: Option<&str>,
    resume: Option<&str>,
    sock_path: &str,
) -> Command {
    let mut cmd = Command::new("claude");
    let mut args: Vec<String> = [
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
    .map(|s| s.to_string())
    .collect();

    // Resume the stored session so the conversation continues with full context.
    // The prior session already carries the system prompt, so don't re-append it.
    if let Some(sid) = resume {
        args.push("--resume".into());
        args.push(sid.to_string());
    } else if let Some(prompt) = system_prompt {
        args.push("--append-system-prompt".into());
        args.push(prompt.to_string());
    }

    // Sessions with the Stark bridge MCP get ask_human (everyone) + delegate
    // (JARVIS only). agent_id = None means no bridge (rare).
    if let Some(aid) = agent_id {
        let tools = if aid == "jarvis" {
            "mcp__stark__ask_human,mcp__stark__delegate"
        } else {
            "mcp__stark__ask_human"
        };
        args.push("--allowedTools".into());
        args.push(tools.into());
        args.push("--mcp-config".into());
        let mjs = format!("{}/mcp/delegate-mcp.mjs", env!("CARGO_MANIFEST_DIR"));
        let cfg = serde_json::json!({
            "mcpServers": {
                "stark": {
                    "command": "node",
                    "args": [mjs],
                    "env": { "STARK_DELEGATE_SOCK": sock_path, "STARK_AGENT_ID": aid }
                }
            }
        });
        args.push(cfg.to_string());
        // Route command permission decisions through our gate (auto-run safe
        // dev commands, ask Om for risky ones).
        args.push("--permission-prompt-tool".into());
        args.push("mcp__stark__approve".into());
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
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
            crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
            // JARVIS's turn just ended — if he dispatched workers this turn, seal
            // the batch so it flushes back to him once every worker finishes.
            if agent_id == "jarvis" {
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
    // If we've talked to this agent in this directory before, resume that
    // Claude Code session so the conversation continues with full context.
    let resume = app
        .try_state::<crate::AppState>()
        .and_then(|s| s.ledger.get_session(agent_id, cwd));
    let mut child = build_headless(cwd, Some(agent_id), Some(&prompt), resume.as_deref(), sock_path)
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    if let Some(stderr) = child.stderr.take() {
        spawn_stderr_pump(app, agent_id, stderr);
    }

    let app2 = app.clone();
    let id2 = agent_id.to_string();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                handle_line(&app2, &id2, &v, true);
            }
        }
        simple(&app2, &id2, "exit", None);
        let state = app2.state::<crate::AppState>();
        state.chat.sessions.lock().unwrap().remove(&id2);
        crate::pty::emit_status(&app2, &id2, AgentStatus::Offline);
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

    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
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
    let sock = app
        .try_state::<crate::AppState>()
        .map(|s| s.sock_path.clone())
        .unwrap_or_default();
    let prompt = system_prompt_for(app, agent_id);
    let mut child = build_headless(cwd, Some(agent_id), Some(&prompt), None, &sock)
        .spawn()
        .map_err(|e| e.to_string())?;
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
    crate::pty::emit_status(app, agent_id, AgentStatus::Idle);
    Ok(result)
}

/// Register a newly-dispatched worker into JARVIS's current delegation batch.
/// A delegate arriving after the previous batch fully drained starts a fresh one.
fn register_delegation(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut b = state.delegations.lock().unwrap();
        if b.sealed && b.pending == 0 {
            *b = DelegationState::default(); // previous batch done → start fresh
        }
        b.sealed = false;
        b.pending += 1;
    }
}

/// Record a finished worker and try to close out the batch.
fn complete_delegation(app: &tauri::AppHandle, agent: &str, task: &str, result: &str) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut b = state.delegations.lock().unwrap();
        b.results.push((agent.to_string(), task.to_string(), result.to_string()));
        b.pending = b.pending.saturating_sub(1);
    }
    try_flush(app);
}

/// JARVIS's delegating turn has ended — seal the batch so it can flush once every
/// worker is in. Called on JARVIS's `result` event.
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
    inject_to_jarvis(app, &body);
}

/// Feed a message into JARVIS's live session as a new user turn (used to deliver
/// delegation results). No-op if his session isn't running.
fn inject_to_jarvis(app: &tauri::AppHandle, text: &str) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let mut map = state.chat.sessions.lock().unwrap();
    let Some(s) = map.get_mut("jarvis") else { return };
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": text }
    });
    if s.stdin.write_all(format!("{}\n", msg).as_bytes()).is_ok() {
        let _ = s.stdin.flush();
        drop(map);
        persist(app, "jarvis", "system", Some("Worker results received — synthesizing."), None, None);
        crate::pty::emit_status(app, "jarvis", AgentStatus::Thinking);
    }
}

/// Listen on a Unix socket for delegation requests from JARVIS's MCP server.
pub fn start_delegation_server(app: tauri::AppHandle, sock_path: String) {
    let _ = std::fs::remove_file(&sock_path);
    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(_) => return,
    };
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
    match req.get("type").and_then(|t| t.as_str()) {
        Some("review") => {
            handle_review(app, &mut writer, &req);
            return;
        }
        Some("approve") => {
            handle_approve(app, &mut writer, &req);
            return;
        }
        _ => {}
    }

    let agent = req.get("agent").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let task = req.get("task").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let dir = req
        .get("directory")
        .and_then(|a| a.as_str())
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());

    let valid = ["friday", "edith", "karen", "veronica", "vision"].contains(&agent.as_str());
    if !valid || task.trim().is_empty() {
        reply(
            &mut writer,
            serde_json::json!({"error": "invalid agent or empty task"}),
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
