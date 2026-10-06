//! Auto mode: in a conversation that has it on, what would otherwise ask the
//! developer first goes ahead on its own. It stops where the policy says an action
//! never runs on its own: committing, pushing or publishing, deleting branches,
//! discarding changes, acting on other machines, destructive commands and changes
//! to Starkline's safeguards still ask. A task works in its conversation, and work
//! delegated from it follows that conversation's setting.

use std::collections::HashSet;
use tauri::{Emitter, Manager};

/// A conversation went into auto mode or came out of it.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoModeChange {
    pub conversation_id: i64,
    pub on: bool,
}

/// The conversation an agent's request comes from: its task's, else the chat it's in.
pub fn conversation_for(app: &tauri::AppHandle, agent_id: &str, task: Option<&str>) -> Option<i64> {
    let state = app.try_state::<crate::AppState>()?;
    match task {
        Some(id) => state.ledger.task(id).and_then(|t| t.conversation_id),
        None => state.ledger.current_conversation(agent_id),
    }
}

/// What auto mode lets go ahead: what would ask, never what never runs on its own.
fn covers(tier: crate::gate::Tier) -> bool {
    tier == crate::gate::Tier::Approval
}

/// Whether auto mode lets a request at this tier, in this conversation, go ahead without asking.
pub fn allows(app: &tauri::AppHandle, conversation: Option<i64>, tier: crate::gate::Tier) -> bool {
    covers(tier) && conversation.is_some_and(|c| app.try_state::<crate::AppState>().is_some_and(|s| s.ledger.auto_mode(c)))
}

/// The conversations of everything delegated from `task`, and from what that delegated.
fn delegated_from(ledger: &crate::ledger::Ledger, task: &str) -> Vec<i64> {
    let mut conversations = Vec::new();
    let mut seen = HashSet::new();
    let mut next = vec![task.to_string()];
    while let Some(id) = next.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        for child in ledger.child_tasks(&id) {
            conversations.extend(child.conversation_id);
            next.push(child.id);
        }
    }
    conversations
}

/// Turn auto mode on or off for a conversation and the work delegated from its task.
/// Turning it on lets what's already waiting there, and that it covers, go ahead.
pub fn set(app: &tauri::AppHandle, conversation: i64, on: bool) -> Result<(), String> {
    let state = app.try_state::<crate::AppState>().ok_or("Starkline isn't ready yet.")?;
    if !state.ledger.set_auto_mode(conversation, on) {
        return Err("That conversation isn't here any more.".into());
    }
    let mut changed = vec![conversation];
    if let Some(task) = state.ledger.task_for_conversation(conversation) {
        changed.extend(delegated_from(&state.ledger, &task.id).into_iter().filter(|c| state.ledger.set_auto_mode(*c, on)));
    }
    for id in &changed {
        let _ = app.emit("automode://changed", AutoModeChange { conversation_id: *id, on });
    }
    if on {
        crate::bridge::allow_waiting(app, &changed);
    }
    Ok(())
}

/// A delegation starts in its own conversation: it's in auto mode when the work it came from is.
pub fn inherit(app: &tauri::AppHandle, from: &str, source_task: Option<&str>, conversation: i64) {
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    if conversation_for(app, from, source_task).is_some_and(|c| state.ledger.auto_mode(c)) {
        state.ledger.set_auto_mode(conversation, true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{Ledger, NewTask};

    fn ledger() -> Ledger {
        Ledger::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn task(ledger: &Ledger, id: &str, parent: Option<&str>, agent: &str) -> i64 {
        ledger
            .create_task(&NewTask { id, title: id, assignee: agent, status: "doing", cwd: "/w", parent_id: parent, requested_by: "you", prompt: id })
            .unwrap();
        let conversation = ledger.create_conversation(agent, "/w", id);
        ledger.begin_task(id, Some(conversation), "");
        conversation
    }

    #[test]
    fn auto_mode_stops_at_what_never_runs_on_its_own() {
        let ctx = crate::gate::Context::for_project("/Users/dev/app")
            .protecting([std::path::PathBuf::from("/Users/dev/Library/Application Support/starkline")]);
        let tier = |cmd: &str| crate::gate::assess("Bash", &serde_json::json!({ "command": cmd }), &ctx).tier;
        for cmd in ["npm install left-pad", "git checkout -b fix", "curl https://example.com/data.json"] {
            assert!(covers(tier(cmd)), "auto mode lets `{cmd}` go ahead");
        }
        for cmd in ["git commit -am fix", "git push", "npm publish", "git branch -D old", "git reset --hard", "rm -rf ~/projects"] {
            assert!(!covers(tier(cmd)), "`{cmd}` still asks in auto mode");
        }
        let edit = |path: &str| crate::gate::assess("Write", &serde_json::json!({ "file_path": path }), &ctx).tier;
        assert!(covers(edit("/Users/dev/notes/todo.md")), "a file outside the project");
        assert!(!covers(edit("/Users/dev/Library/Application Support/starkline/config.json")), "Starkline's safeguards");
    }

    #[test]
    fn a_conversation_remembers_its_auto_mode() {
        let ledger = ledger();
        let chat = ledger.new_conversation("friday", "/w");
        assert!(!ledger.auto_mode(chat), "a new conversation asks first");
        assert!(ledger.set_auto_mode(chat, true));
        assert!(ledger.auto_mode(chat));
        assert!(ledger.set_auto_mode(chat, false));
        assert!(!ledger.auto_mode(chat));
        assert!(!ledger.set_auto_mode(chat + 1000, true), "no such conversation");
        assert!(!ledger.auto_mode(chat + 1000));
    }

    #[test]
    fn everything_delegated_from_a_task_follows_it() {
        let ledger = ledger();
        task(&ledger, "root", None, "jarvis");
        let child = task(&ledger, "child", Some("root"), "friday");
        let grandchild = task(&ledger, "grandchild", Some("child"), "karen");
        let other = task(&ledger, "other", None, "vision");
        let mut found = delegated_from(&ledger, "root");
        found.sort();
        assert_eq!(found, vec![child, grandchild]);
        assert_eq!(delegated_from(&ledger, "child"), vec![grandchild]);
        assert!(delegated_from(&ledger, "grandchild").is_empty());
        assert!(!found.contains(&other));
    }
}
