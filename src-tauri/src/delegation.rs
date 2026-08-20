//! The delegation batch state machine: registers the workers an orchestrator
//! dispatches in a turn, seals the batch when his turn ends (or his session
//! exits), and once every worker is in, synthesizes their results back to him —
//! or dead-letters them if he's gone. Also the standup mission injector. Split
//! out of chat.rs; the worker runner (run_task_blocking) stays there.

use crate::agents::{AgentKind, AgentStatus};
use std::io::Write;
use tauri::{Emitter, Manager};

/// Register a newly-dispatched worker into JARVIS's current delegation batch.
/// A delegate arriving after the previous batch fully drained starts a fresh one.
pub(crate) fn register_delegation(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut b = state.delegations.lock().unwrap();
        if b.sealed && b.pending == 0 {
            let g = b.gen.wrapping_add(1);
            *b = crate::chat::DelegationState::default(); // previous batch done → start fresh
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
pub(crate) fn seal_batch(app: &tauri::AppHandle) {
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
            crate::chat::truncate(task, 80),
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

/// Deliver a routed inbox message into a recipient's live session as a user turn
/// and surface it on their tab. Returns false if the recipient has no session.
pub(crate) fn deliver_message(app: &tauri::AppHandle, agent_id: &str, from: &str, body: &str) -> bool {
    let text = format!("[MESSAGE from {}] {}", from.to_uppercase(), body);
    if inject_user_turn(app, agent_id, &text) {
        crate::chat::simple(app, agent_id, "system", Some(text.clone()));
        crate::chat::persist(app, agent_id, "system", Some(&text), None, None);
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
        crate::chat::persist(app, &oid, "system", Some("Worker results received — synthesizing."), None, None);
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
        crate::chat::persist(app, &oid, "system", Some("Standup — reviewing the floor."), None, None);
        if let Some(state) = app.try_state::<crate::AppState>() {
            let e = state.ledger.record(&oid, "standup", "floor check", 1);
            let _ = app.emit("ledger://entry", e);
        }
        crate::chat::floor_log(app, &oid, "standup", "floor check");
    }
}

/// Last-resort delivery when the orchestrator's session is gone at flush time:
/// post the collected results to its tab and the ledger so they're recoverable
/// rather than silently dropped.
fn dead_letter(app: &tauri::AppHandle, batch: &crate::chat::DelegationState) {
    let oid = orchestrator_id(app);
    eprintln!(
        "[delegation] orchestrator offline at flush — dead-lettering {} result(s)",
        batch.results.len()
    );
    let note = "Delegation results arrived while the orchestrator was offline — delivered here so they aren't lost. Reopen the chat to have them synthesized.";
    crate::chat::simple(app, &oid, "system", Some(note.to_string()));
    crate::chat::persist(app, &oid, "system", Some(note), None, None);
    for (agent, task, result) in &batch.results {
        let text = format!("## {} — {}\n{}", agent.to_uppercase(), crate::chat::truncate(task, 80), result);
        crate::chat::simple(app, &oid, "text", Some(text.clone()));
        crate::chat::persist(app, &oid, "agent", Some(&text), None, None);
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
