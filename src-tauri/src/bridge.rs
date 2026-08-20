//! The delegation bridge: a Unix-socket server the per-agent MCP shim talks to
//! (`delegate` / `ask_human` / `approve` / `roster`). Split out of chat.rs — it
//! drives the session and delegation primitives that still live there.

use crate::agents::{AgentKind, AgentStatus};
use crate::chat::{complete_delegation, register_delegation, resolve_worker_id, run_task_blocking, truncate};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{Emitter, Manager};

static REVIEW_SEQ: AtomicU64 = AtomicU64::new(1);

/// Listen on the Unix socket for bridge requests from an agent's MCP server.
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
