//! The delegation bridge: a Unix-socket server the per-agent MCP shim talks to
//! (`delegate` / `ask_human` / `approve` / `roster`). Split out of chat.rs — it
//! drives the session and delegation primitives that still live there.

use crate::agents::{AgentKind, AgentStatus};
use crate::chat::{run_task_blocking, truncate, Sink};
use crate::delegation::{complete_delegation, register_delegation};
use crate::prompts::resolve_worker_id;
use crate::runs::{self, Actor};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager};

static REVIEW_SEQ: AtomicU64 = AtomicU64::new(1);

/// Something an agent is blocked on until the developer decides: a plan, diff,
/// question or choice (`ask_human`), or a command the permission gate routed.
/// Kept in app state while pending, so any screen (or a reloaded window) can
/// list it again.
#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub body: String,
    /// plan | diff | findings | questions | choice | mockup | command | permission
    pub kind: String,
    pub choices: Vec<String>,
    /// For `command`: the exact command line. For `permission`: the file, URL or input involved.
    pub command: Option<String>,
    /// For `command` and `permission`: the folder the agent is working in.
    pub cwd: Option<String>,
    /// For `command` and `permission`: the policy rule that stopped it.
    pub rule: Option<String>,
    /// For `command` and `permission`: "approval" or "never" (never runs on its own).
    pub tier: Option<String>,
    /// The task the agent is working on, if any.
    pub task_id: Option<String>,
    /// The conversation it came from: the task's, else the agent's chat.
    pub conversation_id: Option<i64>,
    /// For `command` and `permission`: what a rule from this request would allow
    /// ("`npm install` commands"); None when no rule can safely cover it.
    pub grant: Option<String>,
    /// For `command` and `permission`: the project a project-wide rule would apply to.
    pub project: Option<String>,
    /// Unix ms when the agent asked.
    pub created: f64,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// Who sent a bridge request: the agent, and which of its chats (the script passes the
/// conversation its provider process runs in; older scripts didn't).
pub(crate) fn actor_of(req: &serde_json::Value) -> Actor {
    let agent = req.get("agentId").and_then(|a| a.as_str()).unwrap_or("");
    let conversation = req.get("conversationId").and_then(|c| c.as_i64().or_else(|| c.as_str().and_then(|s| s.trim().parse().ok())));
    Actor::new(agent, conversation)
}

/// `agent`, in the chat the request came from.
pub(crate) fn actor_for(agent: &str, req: &serde_json::Value) -> Actor {
    Actor::new(agent, actor_of(req).conversation)
}

/// Register a pending review, show it in the UI, and return the channel its
/// decision will arrive on.
fn open_review(app: &tauri::AppHandle, request: ReviewRequest) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let state = app.state::<crate::AppState>();
    state.reviews.lock().unwrap().insert(request.id.clone(), tx);
    state.pending_reviews.lock().unwrap().insert(request.id.clone(), request.clone());
    let _ = app.emit("review://request", &request);
    crate::notify::review_opened(app, &request);
    rx
}

/// Forget a review once it has been decided (or its agent went away), saying how it ended.
fn close_review(app: &tauri::AppHandle, id: &str, outcome: &str) {
    let state = app.state::<crate::AppState>();
    state.reviews.lock().unwrap().remove(id);
    state.pending_reviews.lock().unwrap().remove(id);
    let _ = app.emit("review://resolved", id);
    crate::notify::review_settled(app, id, outcome);
}

/// How a decision reads in the history; an empty one means the agent went away.
fn outcome_of(decision: &str) -> String {
    if decision.trim().is_empty() {
        "No longer needed".into()
    } else {
        crate::chat::truncate(decision, 80)
    }
}

/// Listen on the Unix socket for bridge requests from an agent's MCP server.
pub fn start_delegation_server(app: tauri::AppHandle, sock_path: String) {
    let _ = std::fs::remove_file(&sock_path);
    let listener = match UnixListener::bind(&sock_path) {
        Ok(l) => l,
        Err(e) => {
            // Without the bridge agents can't delegate, ask or request approval;
            // runtime health reports it, with the reason.
            eprintln!("[bridge] couldn't listen on {sock_path}: {e}");
            crate::health::set_bridge_failed(format!("Couldn't listen on {sock_path}: {e}"));
            return;
        }
    };
    crate::health::set_bridge_up(true);
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
        Some("claim_files" | "release_files") => {
            let who = actor_of(&req);
            let paths = req.get("paths").and_then(|v| v.as_array()).map(|p| p.iter().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>()).unwrap_or_default();
            let reason = req.get("reason").and_then(|v| v.as_str()).unwrap_or("");
            let release = req.get("type").and_then(|v| v.as_str()) == Some("release_files");
            let value = match crate::claims::tool(app, &who, &paths, reason, release) { Ok(result) => serde_json::json!({ "result": result }), Err(error) => serde_json::json!({ "error": error }) };
            reply(&mut writer, value);
            return;
        }
        Some("classify") => {
            handle_classify(app, &mut writer, &req);
            return;
        }
        Some("roster") => {
            handle_roster(app, &mut writer, &req);
            return;
        }
        Some("message") => {
            handle_message(app, &mut writer, &req);
            return;
        }
        Some("report_bug") => {
            handle_report_bug(app, &mut writer, &req);
            return;
        }
        Some("share") => {
            handle_share(app, &mut writer, &req);
            return;
        }
        Some("remind") => {
            handle_remind(app, &mut writer, &req);
            return;
        }
        Some("todo") => {
            let value = match crate::todos::tool(app, &actor_of(&req), &req) {
                Ok(result) => serde_json::json!({ "result": result }),
                Err(error) => serde_json::json!({ "error": error }),
            };
            reply(&mut writer, value);
            return;
        }
        Some("dev_server") => {
            let agent = req.get("agentId").and_then(|v| v.as_str()).unwrap_or("");
            let action = req.get("action").and_then(|v| v.as_str()).unwrap_or("");
            reply_with(&mut writer, crate::devserver::act(app, agent, action, &req));
            return;
        }
        Some("browser") => {
            handle_browser(app, &mut writer, &req);
            return;
        }
        Some("simulator") => {
            handle_simulator(app, &mut writer, &req);
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

    // Only the orchestrator has the delegate tool; bridge scripts from before
    // delegations named their sender didn't say who it was.
    let mut by = actor_of(&req);
    if by.agent.is_empty() {
        by.agent = crate::delegation::orchestrator_id(app);
    }
    // Where the delegating chat works, unless it named another project.
    let cwd = dir.unwrap_or_else(|| runs::cwd(app, &by).unwrap_or_else(|| app.state::<crate::AppState>().project.lock().unwrap().clone()));
    // record the worker's dir too
    app.state::<crate::AppState>()
        .workdirs
        .lock()
        .unwrap()
        .insert(agent.clone(), cwd.clone());

    // Non-blocking: register the worker, ack JARVIS immediately so his turn
    // isn't frozen, then run the worker here (this is already a per-connection
    // background thread) and synthesize results back to him when the batch drains.
    register_delegation(app, by.conversation);
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

    let result = run_task_blocking(app, &by, &agent, &task, &cwd)
        .unwrap_or_else(|e| format!("(delegation failed: {e})"));
    complete_delegation(app, by.conversation, &agent, &task, &result);
}

/// An agent uses the built-in browser. Screenshots come back as a JPEG for the
/// bridge script to hand over as an image.
fn handle_browser(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let agent = req.get("agentId").and_then(|s| s.as_str()).unwrap_or("");
    let action = req.get("action").and_then(|s| s.as_str()).unwrap_or("");
    reply_with(writer, crate::browser::act(app, agent, action, req));
}

/// An agent uses the iOS Simulator.
fn handle_simulator(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let action = req.get("action").and_then(|s| s.as_str()).unwrap_or("");
    reply_with(writer, crate::simulator::act(app, action, req));
}

/// A tool's words, or its picture (base64, for the bridge script to hand over as an image).
fn reply_with(writer: &mut UnixStream, outcome: Result<crate::browser::Outcome, String>) {
    use base64::Engine;
    let reply = match outcome {
        Ok(crate::browser::Outcome::Text(text)) => serde_json::json!({ "result": text }),
        Ok(crate::browser::Outcome::Image { jpeg, caption }) => serde_json::json!({
            "result": caption,
            "image": base64::engine::general_purpose::STANDARD.encode(jpeg),
            "mimeType": "image/jpeg",
        }),
        Err(e) => serde_json::json!({ "error": e }),
    };
    let _ = writer.write_all((reply.to_string() + "\n").as_bytes());
}

/// The developer asked an agent to remind them of something: the agent sets the
/// reminder, and reminds them itself when it comes due.
fn handle_remind(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let reply = |w: &mut UnixStream, v: serde_json::Value| {
        let _ = w.write_all((v.to_string() + "\n").as_bytes());
    };
    let agent = req.get("agentId").and_then(|s| s.as_str()).unwrap_or("");
    let text = req.get("text").and_then(|s| s.as_str()).unwrap_or("");
    let at = req.get("at").and_then(|s| s.as_str()).unwrap_or("");
    let in_minutes = req.get("inMinutes").and_then(|m| m.as_i64());
    let repeat = req.get("repeat").and_then(|s| s.as_str()).unwrap_or("");
    let now = chrono::Local::now();
    let set = crate::reminders::parse_when(at, in_minutes, now).and_then(|due| {
        if !repeat.trim().is_empty() && at.trim().is_empty() {
            return Err("A repeating reminder needs `at`, for its time of day.".into());
        }
        let schedule = crate::reminders::repeat_at(repeat, &due)?;
        crate::reminders::set_by_agent(app, agent, text, due, schedule)
    });
    match set {
        Ok(r) => {
            let again = if r.repeat.is_some() { ", and again on that schedule" } else { "" };
            reply(
                writer,
                serde_json::json!({ "result": format!(
                    "Reminder set for {}{again}: \"{}\". You'll remind the developer then; it's also on their Reminders screen.",
                    crate::reminders::when(r.due),
                    r.text
                ) }),
            );
        }
        Err(e) => reply(writer, serde_json::json!({ "error": e })),
    }
}

/// An agent messages a teammate: drop the message into the sender's outbox for
/// the floor router to deliver. `from` is trusted from the socket's agentId and
/// re-forced to the owning dir by the router; `to` must be a known enabled agent.
fn handle_message(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let reply = |w: &mut UnixStream, v: serde_json::Value| {
        let _ = w.write_all((v.to_string() + "\n").as_bytes());
    };
    let from = req.get("agentId").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let to = req.get("to").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();
    let body = req.get("body").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();

    let known = app
        .try_state::<crate::AppState>()
        .map(|s| {
            let cfg = s.config.lock().unwrap();
            cfg.agents.iter().any(|a| a.enabled && a.id == to)
        })
        .unwrap_or(false);
    if from.is_empty() || !known || to == from || body.is_empty() {
        reply(writer, serde_json::json!({"error": "unknown recipient or empty message"}));
        return;
    }

    if let Some(state) = app.try_state::<crate::AppState>() {
        crate::floor::enqueue(&state.floor_dir, &from, &to, "message", &body);
    }
    reply(
        writer,
        serde_json::json!({
            "result": format!("Message queued for {}. They'll receive it when they're free.", to.to_uppercase())
        }),
    );
}

/// An agent reports a bug in the app for the maintenance agent to fix later.
fn handle_report_bug(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let reply = |w: &mut UnixStream, v: serde_json::Value| {
        let _ = w.write_all((v.to_string() + "\n").as_bytes());
    };
    let from = req.get("agentId").and_then(|s| s.as_str()).unwrap_or("unknown");
    let title = req.get("title").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();
    let detail = req.get("detail").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();
    if title.is_empty() {
        reply(writer, serde_json::json!({"error": "a bug needs a title"}));
        return;
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        state.ledger.add_bug(from, &title, &detail);
        let e = state.ledger.record(from, "bug", &truncate(&title, 60), 2);
        let _ = app.emit("ledger://entry", e);
    }
    let _ = app.emit("bugs://changed", ());
    reply(
        writer,
        serde_json::json!({ "result": "Bug filed for the maintenance agent. Thanks, carry on." }),
    );
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
    let mut who = actor_of(req);
    if who.agent.is_empty() {
        who.agent = "jarvis".into();
    }
    let agent_id = who.agent.clone();
    let title = req
        .get("title")
        .and_then(|s| s.as_str())
        .unwrap_or("Review")
        .to_string();

    let choices = req
        .get("choices")
        .and_then(|c| c.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let task = crate::tasks::task_of(app, &who);
    let rx = open_review(
        app,
        ReviewRequest {
            id: id.clone(),
            agent_id: agent_id.clone(),
            title: title.clone(),
            body: req.get("body").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            kind: req.get("kind").and_then(|s| s.as_str()).unwrap_or("choice").to_string(),
            choices,
            command: None,
            cwd: runs::cwd(app, &who),
            rule: None,
            tier: None,
            conversation_id: who.conversation.or_else(|| crate::automode::conversation_for(app, &agent_id, task.as_deref())),
            task_id: task,
            grant: None,
            project: None,
            created: now_ms(),
        },
    );
    let e = app.state::<crate::AppState>().ledger.record(
        &agent_id,
        "review",
        &format!("awaiting your decision · {}", truncate(&title, 46)),
        1,
    );
    let _ = app.emit("ledger://entry", e);
    runs::set(app, &agent_id, who.conversation, AgentStatus::Blocked);

    // Block until review_respond delivers the decision.
    let decision = rx.recv().unwrap_or_default();
    close_review(app, &id, &outcome_of(&decision));
    crate::tasks::decision(app, &who, &title, &decision, None);
    runs::set(app, &agent_id, who.conversation, AgentStatus::Working);

    let _ = writer.write_all(
        (serde_json::json!({ "result": decision }).to_string() + "\n").as_bytes(),
    );
}

/// What a permission request is about, for the approval card: the command, or
/// the file, URL or input of another tool.
fn subject_of(tool: &str, input: &serde_json::Value) -> String {
    let text = |key: &str| input.get(key).and_then(|v| v.as_str()).map(str::to_string);
    match tool {
        "Bash" => text("command").unwrap_or_default(),
        "WebFetch" => text("url").unwrap_or_default(),
        _ => text("file_path")
            .or_else(|| text("notebook_path"))
            .or_else(|| text("path"))
            .unwrap_or_else(|| truncate(&input.to_string(), 400)),
    }
}

/// The tool call an agent's provider is about to make, and the gate's verdict on it
/// in the folder that agent works in.
fn assess_request(app: &tauri::AppHandle, req: &serde_json::Value) -> (String, serde_json::Value, Option<String>, crate::gate::Assessment) {
    // Older bridge scripts sent only `command` for Bash.
    let legacy_command = req.get("command").and_then(|s| s.as_str());
    let tool = req
        .get("tool_name")
        .and_then(|s| s.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| if legacy_command.is_some() { "Bash".into() } else { String::new() });
    let input = req
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "command": legacy_command.unwrap_or("") }));
    let (cwd, assessment) = assess(app, &actor_of(req), &tool, &input);
    (tool, input, cwd, assessment)
}

/// The gate's verdict on a tool call by an agent, in the folder the chat (or delegated task) it acts in works in.
fn assess(app: &tauri::AppHandle, who: &Actor, tool: &str, input: &serde_json::Value) -> (Option<String>, crate::gate::Assessment) {
    let state = app.state::<crate::AppState>();
    let agent_id = who.agent.as_str();
    let cwd = runs::cwd(app, who);
    let project = cwd.clone().unwrap_or_else(|| state.project.lock().unwrap().clone());
    // The bridge scripts (bundled and in the source tree) and the app's own data
    // (policy, keys) are off limits to agents.
    let mut protected = vec![
        std::path::PathBuf::from(&state.scripts.dir),
        std::path::PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/mcp")),
    ];
    protected.extend(app.path().app_data_dir().ok());
    // Each agent keeps its own memory file in there, which it's told to update.
    let memory = Some(crate::prompts::memory_file_path(app, agent_id)).filter(|p| !p.is_empty());
    let context = crate::gate::Context::for_project(&project)
        .protecting(protected)
        .sharing([crate::attachments::root(app)])
        .owning(memory.map(std::path::PathBuf::from));
    (cwd, crate::gate::assess(tool, input, &context))
}

/// Whether the agent may read a file without asking: in its project, a temporary folder,
/// or Starkline's attachments. Only such files are shown in its chat, so sharing can't
/// carry anything past the gate.
pub(crate) fn may_read_freely(app: &tauri::AppHandle, who: &Actor, path: &std::path::Path) -> bool {
    let input = serde_json::json!({ "file_path": path.to_string_lossy() });
    assess(app, who, "Read", &input).1.tier == crate::gate::Tier::Automatic
}

/// An agent shares files it made: Starkline keeps copies and shows them in its chat.
fn handle_share(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let reply = |w: &mut UnixStream, v: serde_json::Value| {
        let _ = w.write_all((v.to_string() + "\n").as_bytes());
    };
    let who = actor_of(req);
    let from = who.agent.as_str();
    let caption = req.get("caption").and_then(|s| s.as_str()).map(str::trim).filter(|c| !c.is_empty());
    let asked: Vec<String> = req
        .get("paths")
        .and_then(|p| p.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    if from.is_empty() || asked.is_empty() {
        reply(writer, serde_json::json!({ "error": "Name at least one file to share." }));
        return;
    }
    let run = who.key();
    let cwd = crate::outputs::cwd_for(&run).or_else(|| runs::cwd(app, &who).map(std::path::PathBuf::from)).unwrap_or_default();
    let mut refused: Vec<String> = Vec::new();
    let paths: Vec<std::path::PathBuf> = asked
        .iter()
        .map(|raw| crate::outputs::resolve(&cwd, raw))
        .filter(|path| {
            let free = may_read_freely(app, &who, path);
            if !free {
                refused.push(format!("{} is outside the project; save it in the project or a temporary folder to share it.", path.display()));
            }
            free
        })
        .collect();
    let (kept, missed) = crate::chat::keep_copies(app, &paths);
    crate::outputs::shared(&run, &paths);
    let sink = crate::outputs::sink_for(&run).unwrap_or_else(|| who.conversation.map(Sink::chat).unwrap_or_else(|| Sink::open(app, from)));
    crate::chat::post_files(app, &sink, from, "shared", caption, &kept);
    let problems: Vec<String> = refused.into_iter().chain(missed).collect();
    if kept.is_empty() {
        reply(writer, serde_json::json!({ "error": problems.join(" ") }));
    } else if problems.is_empty() {
        reply(writer, serde_json::json!({ "result": format!("Shared {} in the chat.", files_word(kept.len())) }));
    } else {
        reply(writer, serde_json::json!({ "result": format!("Shared {}. Not shared: {}", files_word(kept.len()), problems.join(" ")) }));
    }
}

fn files_word(n: usize) -> String {
    if n == 1 {
        "1 file".into()
    } else {
        format!("{n} files")
    }
}

/// The provider's pre-tool hook asks before every call: anything that isn't
/// automatic becomes a permission prompt, which arrives at `handle_approve`.
fn handle_classify(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let (tool, input, _, a) = assess_request(app, req);
    let who = actor_of(req);
    let claim = crate::claims::check(app, &who, &tool, &input).and_then(|_| {
        if a.tier == crate::gate::Tier::Automatic { crate::claims::allowed(app, &who, &tool, &input) } else { Ok(()) }
    });
    let reply = match claim {
        Err(reason) => serde_json::json!({ "tier": "refused", "rule": "File ownership", "reason": reason }),
        Ok(()) => serde_json::json!({ "tier": a.tier.as_str(), "rule": a.rule.label(), "reason": a.reason }),
    };
    let _ = writer.write_all((reply.to_string() + "\n").as_bytes());
}

/// The project folder a request falls in: the longest known project containing `cwd`.
fn project_of(app: &tauri::AppHandle, cwd: &str) -> String {
    let state = app.state::<crate::AppState>();
    let cwd = crate::workspaces::project_for(&state.ledger, cwd);
    let projects = state.projects.lock().unwrap().clone();
    projects
        .into_iter()
        .filter(|p| std::path::Path::new(&cwd).starts_with(p))
        .max_by_key(|p| p.len())
        .unwrap_or_else(|| cwd.to_string())
}

/// What the developer chose for a permission request.
enum Choice {
    Deny,
    Once,
    Grant(crate::policy::Scope),
    /// Auto mode came on while it waited.
    Auto,
}

/// The decision a waiting request gets when auto mode comes on.
const AUTO_MODE: &str = "Allow (auto mode)";

fn choice_of(decision: &str) -> Choice {
    match decision {
        "Allow for task" => Choice::Grant(crate::policy::Scope::Task),
        "Allow in project" => Choice::Grant(crate::policy::Scope::Project),
        "Allow everywhere" => Choice::Grant(crate::policy::Scope::Everywhere),
        AUTO_MODE => Choice::Auto,
        d if d.starts_with("Allow") => Choice::Once,
        _ => Choice::Deny,
    }
}

/// Auto mode came on in these conversations: what's waiting there that it covers goes ahead.
pub fn allow_waiting(app: &tauri::AppHandle, conversations: &[i64]) {
    let state = app.state::<crate::AppState>();
    let covered: Vec<String> = state
        .pending_reviews
        .lock()
        .unwrap()
        .values()
        .filter(|r| r.tier.as_deref() == Some(crate::gate::Tier::Approval.as_str()))
        .filter(|r| r.conversation_id.is_some_and(|c| conversations.contains(&c)))
        .map(|r| r.id.clone())
        .collect();
    for id in covered {
        if let Some(tx) = state.reviews.lock().unwrap().remove(&id) {
            let _ = tx.send(AUTO_MODE.into());
        }
    }
}

/// The bridge script asks for a permission decision on a tool call.
fn handle_approve(app: &tauri::AppHandle, writer: &mut UnixStream, req: &serde_json::Value) {
    let (tool, input, _, _) = assess_request(app, req);
    let verdict = decide(app, &actor_of(req), &tool, &input);
    let reply = serde_json::json!({ "approved": verdict.approved, "reason": verdict.reason });
    let _ = writer.write_all((reply.to_string() + "\n").as_bytes());
}

/// Whether a tool call may go ahead, and if not, what to tell the agent.
pub struct Verdict {
    pub approved: bool,
    pub reason: String,
}

impl Verdict {
    fn allow() -> Verdict {
        Verdict { approved: true, reason: String::new() }
    }
}

/// A tool call needs a permission decision. The gate settles what may run on its
/// own; a rule the developer granted may cover the rest; anything else goes to
/// the developer and BLOCKS until they decide. Every provider comes through here:
/// Claude Code through the bridge script, Codex and OpenCode from their adapters.
pub fn decide(app: &tauri::AppHandle, who: &Actor, tool: &str, input: &serde_json::Value) -> Verdict {
    let agent_id = who.agent.clone();
    let (tool, input) = (tool.to_string(), input.clone());
    let (cwd, assessment) = assess(app, who, &tool, &input);
    let state = app.state::<crate::AppState>();
    if let Err(reason) = crate::claims::check(app, who, &tool, &input) { return Verdict { approved: false, reason }; }
    if assessment.tier == crate::gate::Tier::Automatic {
        return match crate::claims::allowed(app, who, &tool, &input) { Ok(()) => Verdict::allow(), Err(reason) => Verdict { approved: false, reason } };
    }

    let subject = subject_of(&tool, &input);
    let folder = cwd.clone().unwrap_or_else(|| state.project.lock().unwrap().clone());
    let project = project_of(app, &folder);
    let task = crate::tasks::task_of(app, who);
    let risky = if tool == "Bash" {
        crate::gate::risky_commands(&subject, &crate::gate::Context::for_project(&folder))
    } else {
        vec![]
    };
    let key = crate::policy::rule_for(&tool, &input, &risky);

    // A rule the developer granted may already cover this; it never stretches to a stricter tier.
    if let Some(key) = &key {
        let tier = assessment.tier.as_str();
        let granted = state.ledger.rules(false).into_iter().find(|r| {
            let rule_key = crate::policy::RuleKey { tool: r.tool.clone(), pattern: r.pattern.clone(), display: r.display.clone() };
            crate::policy::covers(&rule_key, key)
                && crate::policy::applies(r, task.as_deref(), &project)
                && (r.tier == tier || r.tier == "never")
        });
        if let Some(rule) = granted {
            state.ledger.record_rule_use(rule.id);
            crate::tasks::decision(app, who, &format!("{} (your rule: {})", truncate(&subject, 80), rule.display), "Allow", Some(true));
            crate::notify::rule_used(app, &agent_id, task.as_deref(), &folder, &rule.display, &subject);
            return match crate::claims::allowed(app, who, &tool, &input) { Ok(()) => Verdict::allow(), Err(reason) => Verdict { approved: false, reason } };
        }
    }

    // In auto mode what would ask goes ahead; what never runs on its own still asks.
    let conversation = who.conversation.or_else(|| crate::automode::conversation_for(app, &agent_id, task.as_deref()));
    if crate::automode::allows(app, conversation, assessment.tier) {
        let e = state.ledger.record(&agent_id, "permission", &format!("allowed by auto mode · {}", truncate(&subject, 46)), 1);
        let _ = app.emit("ledger://entry", e);
        crate::tasks::decision(app, who, &format!("{} (auto mode)", truncate(&subject, 80)), "Allow", Some(true));
        crate::notify::auto_mode_used(app, &agent_id, task.as_deref(), &folder, assessment.rule.title(), &subject);
        return match crate::claims::allowed(app, who, &tool, &input) { Ok(()) => Verdict::allow(), Err(reason) => Verdict { approved: false, reason } };
    }

    let id = format!("rv-{}", REVIEW_SEQ.fetch_add(1, Ordering::Relaxed));
    let rx = open_review(
        app,
        ReviewRequest {
            id: id.clone(),
            agent_id: agent_id.clone(),
            title: assessment.rule.title().into(),
            body: assessment.reason.clone(),
            kind: if tool == "Bash" { "command".into() } else { "permission".into() },
            choices: vec!["Allow".into(), "Deny".into()],
            command: Some(subject.clone()),
            cwd,
            rule: Some(assessment.rule.label().into()),
            tier: Some(assessment.tier.as_str().into()),
            task_id: task.clone(),
            conversation_id: conversation,
            grant: key.as_ref().map(|k| k.display.clone()),
            project: Some(project.clone()),
            created: now_ms(),
        },
    );
    let record = |what: &str| {
        let e = state.ledger.record(&agent_id, "permission", &format!("{what} · {}", truncate(&subject, 46)), 1);
        let _ = app.emit("ledger://entry", e);
    };
    record("awaiting approval");
    runs::set(app, &agent_id, who.conversation, AgentStatus::Blocked);

    let decision = rx.recv().unwrap_or_default();
    let choice = choice_of(&decision);
    let approved = !matches!(choice, Choice::Deny);
    let outcome = match &choice {
        Choice::Deny if decision.is_empty() => "No longer needed".to_string(),
        Choice::Deny => "Denied".to_string(),
        Choice::Once => "Allowed once".to_string(),
        Choice::Auto => "Allowed by auto mode".to_string(),
        Choice::Grant(scope) => {
            // The rule comes from this exact request, never from what the UI or agent sent.
            let (task_id, project_root) = match scope {
                crate::policy::Scope::Task => (task.as_deref(), None),
                crate::policy::Scope::Project => (None, Some(project.as_str())),
                crate::policy::Scope::Everywhere => (None, None),
            };
            let saved = match (&key, scope) {
                (Some(_), crate::policy::Scope::Task) if task_id.is_none() => None,
                (Some(k), _) => state.ledger.add_rule(scope.as_str(), task_id, project_root, k, assessment.rule.label(), assessment.tier.as_str()),
                (None, _) => None,
            };
            match (saved, scope) {
                (Some(_), crate::policy::Scope::Task) => "Allowed for this task".into(),
                (Some(_), crate::policy::Scope::Project) => "Always allowed in this project".into(),
                (Some(_), crate::policy::Scope::Everywhere) => "Always allowed everywhere".into(),
                (None, _) => "Allowed once".into(),
            }
        }
    };
    close_review(app, &id, &outcome);
    runs::set(app, &agent_id, who.conversation, AgentStatus::Working);
    if matches!(choice, Choice::Grant(_)) {
        let _ = app.emit("rules://changed", ());
    }

    record(if approved { "allowed" } else { "denied" });
    crate::tasks::decision(app, who, &format!("{} ({})", truncate(&subject, 80), assessment.rule.title()), &outcome, Some(approved));
    let reason = if approved {
        String::new()
    } else {
        format!("The developer didn't allow this ({}). Find another way, or ask them with ask_human.", assessment.rule.label())
    };
    if approved {
        if let Err(reason) = crate::claims::allowed(app, who, &tool, &input) { return Verdict { approved: false, reason }; }
    }
    Verdict { approved, reason }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_decision_reads_as_the_developer_meant_it() {
        assert!(matches!(choice_of("Allow"), Choice::Once));
        assert!(matches!(choice_of("Allow for task"), Choice::Grant(crate::policy::Scope::Task)));
        assert!(matches!(choice_of("Allow in project"), Choice::Grant(crate::policy::Scope::Project)));
        assert!(matches!(choice_of("Allow everywhere"), Choice::Grant(crate::policy::Scope::Everywhere)));
        assert!(matches!(choice_of(AUTO_MODE), Choice::Auto));
        assert!(matches!(choice_of("Deny"), Choice::Deny));
        assert!(matches!(choice_of(""), Choice::Deny), "the agent went away");
    }
}
