//! The delegation batch state machine: registers the workers an orchestrator
//! dispatches in a turn, seals the batch when his turn ends (or his session
//! exits), and once every worker is in, synthesizes their results back to him —
//! or dead-letters them if he's gone. Also the standup mission injector. Split
//! out of chat.rs; the worker runner (run_task_blocking) stays there.

use crate::agents::AgentKind;
use crate::chat::Sink;
use tauri::{Emitter, Manager};

/// Each of the orchestrator's chats keeps its own batch; 0 holds work from a bridge script that didn't say which.
fn batch_key(conversation: Option<i64>) -> i64 {
    conversation.unwrap_or(0)
}

/// Register a newly-dispatched worker into the delegating chat's current batch.
/// A delegate arriving after that chat's previous batch fully drained starts a fresh one.
pub(crate) fn register_delegation(app: &tauri::AppHandle, conversation: Option<i64>) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut all = state.delegations.lock().unwrap();
        let b = all.entry(batch_key(conversation)).or_default();
        if b.sealed && b.pending == 0 {
            let g = b.gen.wrapping_add(1);
            *b = crate::chat::DelegationState::default(); // previous batch done → start fresh
            b.gen = g;
        }
        b.sealed = false;
        b.pending += 1;
    }
}

/// Record a finished worker and try to close out its chat's batch.
pub(crate) fn complete_delegation(app: &tauri::AppHandle, conversation: Option<i64>, agent: &str, task: &str, result: &str) {
    let key = batch_key(conversation);
    let mut arm_watchdog = None;
    if let Some(state) = app.try_state::<crate::AppState>() {
        let mut all = state.delegations.lock().unwrap();
        let b = all.entry(key).or_default();
        b.results.push((agent.to_string(), task.to_string(), result.to_string()));
        b.pending = b.pending.saturating_sub(1);
        // Every worker is in but the orchestrator hasn't ended its turn yet. Arm a
        // watchdog so the results can't be stranded if it errors out or hangs and
        // never emits a `result` (which is what normally seals the batch).
        if b.pending == 0 && !b.sealed {
            arm_watchdog = Some(b.gen);
        }
    }
    try_flush(app, conversation);
    if let Some(gen) = arm_watchdog {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(12));
            let stale = app
                .try_state::<crate::AppState>()
                .map(|s| {
                    let mut all = s.delegations.lock().unwrap();
                    match all.get_mut(&key) {
                        Some(b) if b.gen == gen && !b.sealed && b.pending == 0 && !b.results.is_empty() => {
                            b.sealed = true; // force the seal so try_flush can drain it
                            true
                        }
                        _ => false,
                    }
                })
                .unwrap_or(false);
            if stale {
                eprintln!("[delegation] watchdog sealed a batch the orchestrator never closed");
                try_flush(&app, conversation);
            }
        });
    }
}

/// The orchestrator's delegating turn in this chat has ended — seal its batch so it can
/// flush once every worker is in. Called on the orchestrator's `result` (or on its
/// session exiting mid-turn, so a crash can't strand the workers' output).
pub(crate) fn seal_batch(app: &tauri::AppHandle, conversation: Option<i64>) {
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Some(b) = state.delegations.lock().unwrap().get_mut(&batch_key(conversation)) {
            b.sealed = true;
        }
    }
    try_flush(app, conversation);
}

/// If the chat's batch is sealed and drained, hand the collected results back to the
/// orchestrator in that chat as one follow-up message so it can synthesize a single reply.
fn try_flush(app: &tauri::AppHandle, conversation: Option<i64>) {
    let batch = {
        let Some(state) = app.try_state::<crate::AppState>() else { return };
        let mut all = state.delegations.lock().unwrap();
        match all.get(&batch_key(conversation)) {
            Some(b) if b.sealed && b.pending == 0 && !b.results.is_empty() => all.remove(&batch_key(conversation)).unwrap_or_default(),
            _ => return,
        }
    };

    let mut body = String::from(
        "[DELEGATION RESULTS] The worker(s) you dispatched have finished. Synthesize these into \
ONE clear reply for the user, and call out anything that needs their decision. Don't re-delegate unless \
something is genuinely incomplete.\n\n",
    );
    for (agent, task, result) in &batch.results {
        body.push_str(&format!(
            "## {}: {}\n{}\n\n---\n\n",
            agent.to_uppercase(),
            crate::chat::truncate(task, 80),
            result
        ));
    }
    // If the orchestrator's chat isn't live to synthesize, don't lose the work — post
    // it in that chat and log it instead of dropping it silently.
    if !inject_to_orchestrator(app, conversation, &body) {
        dead_letter(app, conversation, &batch);
    }
}

/// The current orchestrator's agent id (falls back to "jarvis").
pub(crate) fn orchestrator_id(app: &tauri::AppHandle) -> String {
    if let Some(state) = app.try_state::<crate::AppState>() {
        let cfg = state.config.lock().unwrap();
        if let Some(a) = cfg.agents.iter().find(|a| a.kind == AgentKind::Orchestrator) {
            return a.id.clone();
        }
    }
    "jarvis".to_string()
}

/// Deliver a routed inbox message into a recipient's live chat as a user turn and show it
/// there. Returns false if the recipient has no live chat.
pub(crate) fn deliver_message(app: &tauri::AppHandle, agent_id: &str, from: &str, body: &str) -> bool {
    let text = format!("[MESSAGE from {}] {}", from.to_uppercase(), body);
    let Some(conversation) = crate::chat::live_chat(app, agent_id) else { return false };
    if crate::chat::inject(app, agent_id, conversation, &text) {
        crate::chat::note_in(app, &Sink::chat(conversation), agent_id, &text);
        true
    } else {
        false
    }
}

/// Feed delegation results into the orchestrator's chat they were delegated from (or, when
/// that isn't known, its live chat). Returns false if that chat's session isn't running.
fn inject_to_orchestrator(app: &tauri::AppHandle, conversation: Option<i64>, text: &str) -> bool {
    let oid = orchestrator_id(app);
    let Some(chat) = conversation.or_else(|| crate::chat::live_chat(app, &oid)) else { return false };
    if crate::chat::inject(app, &oid, chat, text) {
        crate::chat::note_in(app, &Sink::chat(chat), &oid, "Worker results received. Summarizing them now.");
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
accurate. If everything in-flight is on track and nothing needs the user, say so briefly. Do NOT \
start new work the user didn't ask for.";
    let Some(chat) = crate::chat::live_chat(app, &oid) else { return };
    if crate::chat::inject(app, &oid, chat, msg) {
        crate::chat::note_in(app, &Sink::chat(chat), &oid, "Standup: reviewing the board.");
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
fn dead_letter(app: &tauri::AppHandle, conversation: Option<i64>, batch: &crate::chat::DelegationState) {
    let oid = orchestrator_id(app);
    let sink = conversation.map(Sink::chat).unwrap_or_else(|| Sink::open(app, &oid));
    eprintln!(
        "[delegation] orchestrator offline at flush — dead-lettering {} result(s)",
        batch.results.len()
    );
    let note = "Delegation results arrived while the orchestrator was offline, so they are delivered here instead. Reopen the chat to have them summarized.";
    crate::chat::note_in(app, &sink, &oid, note);
    for (agent, task, result) in &batch.results {
        let text = format!("## {}: {}\n{}", agent.to_uppercase(), crate::chat::truncate(task, 80), result);
        crate::chat::record_in(app, &sink, &oid, "text", "agent", Some(&text), None, None);
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
