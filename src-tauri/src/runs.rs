//! Runs: what each conversation's provider process is doing. An agent can work in
//! several chats at once (and on delegated tasks beside them), each its own run in
//! its own folder; the agent's own status is the busiest of its runs.

use crate::agents::AgentStatus;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// One conversation's provider process: a chat session, or a one-shot worker on a delegated task.
#[derive(Clone, Debug)]
pub struct Run {
    pub agent_id: String,
    pub status: AgentStatus,
    /// The folder it works in.
    pub cwd: String,
}

#[derive(Default)]
pub struct Runs {
    runs: Mutex<HashMap<i64, Run>>,
}

/// Who is acting: an agent, and the conversation its provider process runs in, when that's known
/// (bridge scripts from before conversations were passed along didn't say).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Actor {
    pub agent: String,
    pub conversation: Option<i64>,
}

impl Actor {
    pub fn new(agent: &str, conversation: Option<i64>) -> Actor {
        Actor { agent: agent.to_string(), conversation }
    }

    /// The key for state kept per run (a turn's outputs, the loop guard).
    pub fn key(&self) -> String {
        run_key(&self.agent, self.conversation)
    }
}

/// The key for state kept per run: the agent alone when the conversation isn't known.
pub fn run_key(agent_id: &str, conversation: Option<i64>) -> String {
    match conversation {
        Some(c) => format!("{agent_id}#{c}"),
        None => agent_id.to_string(),
    }
}

/// How strongly a run's state shows on its agent: what needs you, then work, then waiting.
fn weight(status: AgentStatus) -> u8 {
    match status {
        AgentStatus::Blocked => 4,
        AgentStatus::Working => 3,
        AgentStatus::Thinking => 2,
        AgentStatus::Idle => 1,
        AgentStatus::Offline => 0,
    }
}

/// An agent's status across its runs: the busiest of them, or offline with none.
pub fn overall(statuses: impl IntoIterator<Item = AgentStatus>) -> AgentStatus {
    statuses.into_iter().max_by_key(|s| weight(*s)).unwrap_or(AgentStatus::Offline)
}

pub fn is_busy(status: AgentStatus) -> bool {
    matches!(status, AgentStatus::Working | AgentStatus::Thinking | AgentStatus::Blocked)
}

fn table(app: &tauri::AppHandle) -> Option<tauri::State<'_, crate::AppState>> {
    app.try_state::<crate::AppState>()
}

/// A run began in `cwd` (a chat session started, or a worker took a delegated task).
pub fn started(app: &tauri::AppHandle, agent_id: &str, conversation: i64, cwd: &str, status: AgentStatus) {
    if let Some(state) = table(app) {
        state.runs.runs.lock().unwrap().insert(conversation, Run { agent_id: agent_id.to_string(), status, cwd: cwd.to_string() });
    }
    publish(app, agent_id, Some(conversation), status);
}

/// A run changed state. Without a conversation (an agent's terminal session, say) the agent's
/// status is set as it is.
pub fn set(app: &tauri::AppHandle, agent_id: &str, conversation: Option<i64>, status: AgentStatus) {
    if let (Some(state), Some(c)) = (table(app), conversation) {
        let mut runs = state.runs.runs.lock().unwrap();
        match runs.get_mut(&c) {
            Some(run) => run.status = status,
            None => {
                runs.insert(c, Run { agent_id: agent_id.to_string(), status, cwd: String::new() });
            }
        }
    }
    publish(app, agent_id, conversation, status);
}

/// A run ended: its session went away, or its worker finished.
pub fn ended(app: &tauri::AppHandle, conversation: i64) {
    let Some(state) = table(app) else { return };
    let Some(run) = state.runs.runs.lock().unwrap().remove(&conversation) else { return };
    publish(app, &run.agent_id, Some(conversation), AgentStatus::Offline);
}

/// Tell the UI how this conversation's run is doing, and set the agent's own status from all of its runs.
fn publish(app: &tauri::AppHandle, agent_id: &str, conversation: Option<i64>, status: AgentStatus) {
    let Some(c) = conversation else {
        crate::pty::emit_status(app, agent_id, status);
        return;
    };
    let _ = app.emit("chat://status", serde_json::json!({ "agentId": agent_id, "conversationId": c, "status": status }));
    let all = table(app).map(|s| {
        let runs = s.runs.runs.lock().unwrap();
        overall(runs.values().filter(|r| r.agent_id == agent_id).map(|r| r.status))
    });
    crate::pty::emit_status(app, agent_id, all.unwrap_or(status));
}

/// How a conversation's run is doing; None when nothing runs there.
pub fn status_of(app: &tauri::AppHandle, conversation: i64) -> Option<AgentStatus> {
    table(app)?.runs.runs.lock().unwrap().get(&conversation).map(|r| r.status)
}

/// Whether something is working in this conversation right now (or waiting on you there).
pub fn busy_in(app: &tauri::AppHandle, conversation: i64) -> bool {
    status_of(app, conversation).is_some_and(is_busy)
}

/// The folder an actor works in: its run's, else the folder the agent last worked in.
pub fn cwd(app: &tauri::AppHandle, who: &Actor) -> Option<String> {
    let state = table(app)?;
    let run = who.conversation.and_then(|c| state.runs.runs.lock().unwrap().get(&c).map(|r| r.cwd.clone())).filter(|c| !c.is_empty());
    run.or_else(|| state.workdirs.lock().unwrap().get(&who.agent).cloned())
}

/// The conversations an agent has running, with how each is doing.
pub fn of_agent(app: &tauri::AppHandle, agent_id: &str) -> Vec<(i64, AgentStatus)> {
    let Some(state) = table(app) else { return Vec::new() };
    let runs = state.runs.runs.lock().unwrap();
    runs.iter().filter(|(_, r)| r.agent_id == agent_id).map(|(c, r)| (*c, r.status)).collect()
}

/// Every agent busy in `folder`, for telling who shares it.
pub fn busy_in_folder(app: &tauri::AppHandle, folder: &str) -> Vec<String> {
    let Some(state) = table(app) else { return Vec::new() };
    let runs = state.runs.runs.lock().unwrap();
    runs.values().filter(|r| r.cwd == folder && is_busy(r.status)).map(|r| r.agent_id.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_shows_its_busiest_run() {
        use AgentStatus::*;
        assert_eq!(overall([]), Offline, "nothing running");
        assert_eq!(overall([Idle, Idle]), Idle);
        assert_eq!(overall([Idle, Thinking]), Thinking);
        assert_eq!(overall([Thinking, Working, Idle]), Working);
        assert_eq!(overall([Working, Blocked]), Blocked, "waiting on you shows above work elsewhere");
    }

    #[test]
    fn per_run_state_is_kept_apart_by_conversation() {
        assert_eq!(run_key("jarvis", Some(4)), "jarvis#4");
        assert_eq!(run_key("jarvis", None), "jarvis");
        assert_ne!(Actor::new("jarvis", Some(4)).key(), Actor::new("jarvis", Some(5)).key());
    }
}
