//! To-do lists. You keep named lists, each tied to a project or not; a to-do can be
//! assigned to an agent, and starting it hands it over as an ordinary task in that
//! agent's chat for the project. What assigning does is the list's own setting: wait
//! for Start, start at once, or start when the agent has nothing running. Agents add
//! the follow-ups they find and tick off what they finished, and a to-do with a due
//! time reminds you, through the assigned agent.

use crate::reminders::ReminderInput;
use crate::runs::Actor;
use crate::tasks::{Origin, BY_DEVELOPER};
use crate::todo_store::{Standing, Todo, TodoList};
use serde::Deserialize;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// What assigning an agent does, as a list's `start_mode`.
pub const MANUAL: &str = "manual";
pub const NOW: &str = "now";
pub const WHEN_FREE: &str = "when_free";
const START_MODES: [&str; 3] = [MANUAL, NOW, WHEN_FREE];

/// How often assigned to-dos are looked at, for agents who've come free.
const TICK: Duration = Duration::from_secs(15);
const TITLE_LIMIT: usize = 200;
/// Where an agent's to-do goes when nothing says which list.
const INBOX: &str = "Inbox";

/// A list as you make or change it.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TodoListInput {
    /// None to create one.
    pub id: Option<i64>,
    pub name: String,
    /// A project folder, or "" for none.
    pub project: String,
    pub start_mode: String,
}

/// A to-do as you make or change it.
#[derive(Debug, Clone, Deserialize, specta::Type)]
pub struct TodoInput {
    /// None to create one.
    pub id: Option<i64>,
    pub list_id: i64,
    pub title: String,
    pub notes: String,
    pub agent_id: Option<String>,
    pub due: Option<i64>,
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("todos://changed", ());
}

fn state(app: &tauri::AppHandle) -> Result<tauri::State<'_, crate::AppState>, String> {
    app.try_state::<crate::AppState>().ok_or_else(|| "Starkline isn't ready yet.".into())
}

fn now_ms() -> i64 {
    crate::ledger::now_ms()
}

fn agent_enabled(app: &tauri::AppHandle, agent_id: &str) -> bool {
    app.try_state::<crate::AppState>().is_some_and(|s| s.config.lock().unwrap().agents.iter().any(|a| a.id == agent_id && a.enabled))
}

// ---- Pure rules ----------------------------------------------------------------

/// What's wrong with a list, if anything.
pub fn list_problem(input: &TodoListInput, project_known: bool) -> Option<String> {
    if input.name.trim().is_empty() {
        return Some("Give the list a name.".into());
    }
    if !START_MODES.contains(&input.start_mode.as_str()) {
        return Some("Choose what assigning an agent does.".into());
    }
    if !input.project.is_empty() && !project_known {
        return Some("That project isn't in your list of projects.".into());
    }
    None
}

/// What's wrong with a to-do, if anything.
pub fn todo_problem(input: &TodoInput, agent_known: bool) -> Option<String> {
    if input.title.trim().is_empty() {
        return Some("Say what needs doing.".into());
    }
    if input.title.chars().count() > TITLE_LIMIT {
        return Some(format!("Keep the to-do under {TITLE_LIMIT} characters; put the rest in its notes."));
    }
    if input.agent_id.is_some() && !agent_known {
        return Some("That agent isn't on the roster.".into());
    }
    None
}

/// The short token that goes with a to-do: it can't be reused (a deleted to-do's is gone for good),
/// so it says "this very to-do" even if its number or words later change.
pub fn token(todo: &Todo) -> String {
    format!("T{}", todo.id)
}

/// What an agent is asked when a to-do is handed to it.
pub fn prompt_for(todo: &Todo, list: &TodoList) -> String {
    let mut prompt = todo.title.trim().to_string();
    if !todo.notes.trim().is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(todo.notes.trim());
    }
    prompt.push_str(&format!(
        "\n\n(This is to-do #{n} on the developer's \"{list}\" list, ref {token}. The developer can change their lists while you work, so: \
before you start, check it's still there and open with the `check_todo` tool (number {n}, list \"{list}\"); if it's gone, done or moved, stop and say so instead of doing it. \
When it's done, check it again, then tick it off with the `complete_todo` tool: number {n}, list \"{list}\", ref {token}, title \"{title}\". \
Starkline refuses to tick a to-do that has been deleted, ticked or moved, or isn't the one you worked on; if that happens, don't redo or work around it, tell the developer.)",
        n = todo.number,
        list = list.name,
        token = token(todo),
        title = todo.title.trim().replace('"', "'")
    ));
    prompt
}

/// What an agent is asked when a whole list is handed to it: the open to-dos, in order.
pub fn list_prompt(list: &TodoList, open: &[Todo], name_of: impl Fn(&str) -> String) -> String {
    let mut prompt = format!("Work through my to-do list \"{}\", in order:\n", list.name);
    for t in open {
        prompt.push_str(&format!("\n- #{} {} (ref {})", t.number, t.title.trim(), token(t)));
        if let Some(line) = t.notes.lines().map(str::trim).find(|l| !l.is_empty()) {
            prompt.push_str(&format!(" ({line})"));
        }
        if let Some(agent) = &t.agent_id {
            prompt.push_str(&format!(" [assigned to {}]", name_of(agent)));
        }
    }
    prompt.push_str(&format!(
        "\n\nThis list is a snapshot: I can delete, tick off or move to-dos while you work. So for EACH to-do: \
(1) immediately before you start it, call `check_todo` (number, list \"{list}\"); if it is gone, done or moved, skip it and report that at the end instead of doing it. \
(2) Do it yourself, or delegate it (to whoever it's assigned to, if anyone). \
(3) Immediately before ticking it, call `check_todo` again; only if it's still open and still the same to-do, tick it with `complete_todo` (number, list \"{list}\", and its ref or exact title). \
Starkline refuses a tick for a to-do that has been deleted, ticked or moved, or doesn't match; never work around that, just report it. \
These numbers belong to \"{list}\" only; another list has its own #1, #2… Add follow-ups you find with `add_todo`. Read any to-do's notes with `list_todos`.",
        list = list.name
    ));
    prompt
}

/// Whether a to-do is waiting for its agent to come free: open, assigned, never started, on a list that starts work that way.
pub fn waits_for_agent(todo: &Todo, list: &TodoList) -> bool {
    list.start_mode == WHEN_FREE && todo.done.is_none() && todo.agent_id.is_some() && todo.task_id.is_none()
}

/// The open to-dos to start now, at most one per agent: the first waiting one of each agent that's free.
pub fn pick_up<'a>(lists: &[TodoList], todos: &'a [Todo], free: impl Fn(&str) -> bool) -> Vec<&'a Todo> {
    let mut picked: Vec<&Todo> = Vec::new();
    for list in lists {
        for todo in todos.iter().filter(|t| t.list_id == list.id && waits_for_agent(t, list)) {
            let agent = todo.agent_id.as_deref().unwrap_or("");
            if free(agent) && !picked.iter().any(|p| p.agent_id.as_deref() == Some(agent)) {
                picked.push(todo);
            }
        }
    }
    picked
}

/// The list a project folder belongs to: the one tied to the longest project containing it.
pub fn list_for_folder<'a>(lists: &'a [TodoList], folder: &str) -> Option<&'a TodoList> {
    lists
        .iter()
        .filter(|l| !l.project.is_empty() && std::path::Path::new(folder).starts_with(&l.project))
        .max_by_key(|l| l.project.len())
}

/// How an agent points at a to-do: its number on a list (with the list's name, if it gave one),
/// or, from before numbers were per list, its old global `id`.
#[derive(Debug, Default, PartialEq)]
pub struct TodoRef {
    pub number: Option<i64>,
    pub id: Option<i64>,
    pub list: String,
}

/// Where an agent's pointer leads, before asking whether anything is there.
#[derive(Debug, PartialEq)]
pub enum Target {
    /// A number on a list.
    Numbered { list_id: i64, number: i64 },
    /// An old global id, on the list named if one was.
    Id { id: i64, list_id: Option<i64> },
}

/// The place an agent means, or why that can't be told. A number only ever means a to-do on
/// one list: the list it names, else `handed` (the list it was given), else the only list there is.
/// It's never guessed from the other lists, so a number can't tick the wrong list's to-do.
pub fn locate(lists: &[TodoList], pointer: &TodoRef, handed: Option<i64>) -> Result<Target, String> {
    let named = pointer.list.trim();
    let named_list = || -> Result<Option<i64>, String> {
        if named.is_empty() {
            return Ok(None);
        }
        let found: Vec<&TodoList> = lists.iter().filter(|l| l.name.eq_ignore_ascii_case(named)).collect();
        match found.as_slice() {
            [] => Err(format!("There's no list called \"{named}\".")),
            [one] => Ok(Some(one.id)),
            _ => Err(format!("More than one list is called \"{named}\"; rename one so it can be told apart.")),
        }
    };
    if let Some(number) = pointer.number {
        let list_id = match named_list()? {
            Some(id) => id,
            None => match (handed, lists) {
                (Some(id), _) if lists.iter().any(|l| l.id == id) => id,
                (_, [only]) => only.id,
                _ => {
                    let names: Vec<String> = lists.iter().map(|l| format!("\"{}\"", l.name)).collect();
                    return Err(format!("Numbers are per list, so say which list #{number} is on with `list` (one of {}).", names.join(", ")));
                }
            },
        };
        return Ok(Target::Numbered { list_id, number });
    }
    if let Some(id) = pointer.id {
        return Ok(Target::Id { id, list_id: named_list()? });
    }
    Err("Say which to-do: its `number` on its list, with the list's name in `list`.".into())
}

/// How a to-do and its list are named in what an agent reads.
pub struct Names<'a> {
    pub list: &'a dyn Fn(i64) -> String,
    pub agent: &'a dyn Fn(&str) -> String,
}

fn when(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| t.with_timezone(&chrono::Local).format("%-d %b %H:%M").to_string())
        .unwrap_or_default()
}

fn who(names: &Names, by: &str) -> String {
    if by == BY_DEVELOPER { "the developer".into() } else { (names.agent)(by) }
}

/// What `check_todo` tells an agent about a number on a list: one verdict word first, then what to do.
pub fn check_report(standing: &Standing, list_id: i64, number: i64, names: &Names) -> String {
    let list = (names.list)(list_id);
    match standing {
        Standing::Found(t) if t.done.is_none() => {
            let mut text = format!("OPEN: to-do #{number} on \"{list}\" is \"{}\" (ref {}).", t.title, token(t));
            if let Some(agent) = &t.agent_id {
                text.push_str(&format!(" Assigned to {}.", (names.agent)(agent)));
            }
            if !t.notes.trim().is_empty() {
                text.push_str(&format!("\nNotes: {}", t.notes.trim().replace('\n', "\n  ")));
            }
            text.push_str("\nIt is still open, so it's fine to start it. Check again right before you tick it off.");
            text
        }
        Standing::Found(t) => format!(
            "DONE: to-do #{number} on \"{list}\" (\"{}\", ref {}) was ticked off by {} on {}. Don't start it or tick it again; skip it and say it was already done.",
            t.title,
            token(t),
            who(names, t.done_by.as_deref().unwrap_or(BY_DEVELOPER)),
            when(t.done.unwrap_or(0))
        ),
        Standing::Moved { title, list_id: to_list, number: to_number, .. } => format!(
            "MOVED: to-do #{number} on \"{list}\" (\"{title}\") is no longer there: it was moved to \"{}\", where it's now #{to_number}. \
Don't act on #{number} on \"{list}\". If you were meant to do it, check #{to_number} on \"{}\" first; otherwise skip it and say it moved.",
            (names.list)(*to_list),
            (names.list)(*to_list)
        ),
        Standing::Deleted { title, at, .. } => format!(
            "DELETED: to-do #{number} on \"{list}\" (\"{title}\") was deleted on {}. Don't start it or tick it off; skip it and report that it's gone.",
            when(*at)
        ),
        Standing::Missing => format!(
            "NOT FOUND: there is no to-do #{number} on \"{list}\" (it was deleted, or it never existed). Don't start it or tick it off; skip it and report that it's gone."
        ),
    }
}

/// Whether what an agent is told it can tick is the same to-do it worked on: it must say which by
/// its title (as it read it) or its ref, and whichever it gives has to match.
pub fn identity_problem(todo: &Todo, list_name: &str, title: &str, reference: &str) -> Option<String> {
    let (title, reference) = (title.trim(), reference.trim());
    if title.is_empty() && reference.is_empty() {
        return Some(format!(
            "Not ticked: say which to-do you worked on. Pass its `title` exactly as you read it, or its `ref` ({}), along with the number, so I can tell it's the same one. Run `check_todo` to read them.",
            token(todo)
        ));
    }
    if !reference.is_empty() && !reference.trim_start_matches('#').eq_ignore_ascii_case(&token(todo)) {
        return Some(format!(
            "Not ticked: ref {reference} isn't to-do #{} on \"{list_name}\" (that is {}, \"{}\"). It's a different to-do from the one you worked on, so nothing was ticked. Check it with `check_todo`.",
            todo.number,
            token(todo),
            todo.title
        ));
    }
    if !title.is_empty() && !same_words(title, &todo.title) {
        return Some(format!(
            "Not ticked: to-do #{} on \"{list_name}\" is \"{}\", not \"{title}\". It's a different to-do from the one you worked on (or it was reworded), so nothing was ticked. Check it with `check_todo`.",
            todo.number, todo.title
        ));
    }
    None
}

/// Titles match when they have the same words, ignoring case, spacing and a closing full stop.
fn same_words(a: &str, b: &str) -> bool {
    let plain = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase().trim_end_matches(['.', '!']).to_string();
    plain(a) == plain(b)
}

/// Why `complete_todo` won't tick what the number now points at, or None if it may go ahead. `mine`:
/// the agent was working on it (it was its task's to-do, or on the list it was handed).
pub fn tick_refusal(standing: &Standing, list_id: i64, number: i64, mine: bool, names: &Names) -> Option<String> {
    let list = (names.list)(list_id);
    let gone = |what: &str, title: &str| {
        let working = if mine { " It was removed while you were working on it." } else { "" };
        format!("Not ticked: to-do #{number} on \"{list}\" (\"{title}\") {what}.{working} Stop work on it and tell the developer what you had done; don't redo it or tick another in its place.")
    };
    match standing {
        Standing::Found(t) if t.done.is_some() => Some(format!(
            "Not ticked: to-do #{number} on \"{list}\" (\"{}\") is already done: ticked off by {} on {}. Nothing is left for you to tick.",
            t.title,
            who(names, t.done_by.as_deref().unwrap_or(BY_DEVELOPER)),
            when(t.done.unwrap_or(0))
        )),
        Standing::Found(_) => None,
        Standing::Deleted { title, .. } => Some(gone("was deleted", title)),
        Standing::Moved { title, list_id: to_list, number: to_number, .. } => {
            Some(gone(&format!("was moved to \"{}\", where it's now #{to_number}", (names.list)(*to_list)), title))
        }
        Standing::Missing => Some(format!("Not ticked: there is no to-do #{number} on \"{list}\" (it was deleted, or it never existed). Don't tick another in its place.")),
    }
}

/// Whether a to-do that's gone was the agent's to do: the task it was started for, or the list it was handed.
pub fn was_mine(standing: &Standing, list_id: i64, my_task: Option<&str>, handed: Option<i64>) -> bool {
    let task = match standing {
        Standing::Deleted { task_id, .. } | Standing::Moved { task_id, .. } => task_id.as_deref(),
        _ => None,
    };
    (task.is_some() && task == my_task) || handed == Some(list_id)
}

/// Re-reads a to-do the scheduler picked, right before it is dispatched: it must still be that
/// to-do (same list, number and agent), still open and unstarted, on a list that still starts it this way.
pub fn recheck_before_start(ledger: &crate::ledger::Ledger, picked: &Todo) -> Result<Todo, String> {
    let fresh = ledger.todo(picked.id).ok_or("it was deleted")?;
    if fresh.list_id != picked.list_id || fresh.number != picked.number {
        return Err("it was moved to another list".into());
    }
    if fresh.done.is_some() {
        return Err("it was already ticked off".into());
    }
    if fresh.agent_id != picked.agent_id {
        return Err("it was given to someone else".into());
    }
    let list = ledger.todo_list(fresh.list_id).ok_or("its list was deleted")?;
    if !waits_for_agent(&fresh, &list) {
        return Err("it is no longer waiting for its agent".into());
    }
    Ok(fresh)
}

// ---- Lists -----------------------------------------------------------------------

pub fn lists(app: &tauri::AppHandle) -> Vec<TodoList> {
    state(app).map(|s| s.ledger.todo_lists()).unwrap_or_default()
}

pub fn all(app: &tauri::AppHandle) -> Vec<Todo> {
    state(app).map(|s| s.ledger.todos()).unwrap_or_default()
}

pub fn save_list(app: &tauri::AppHandle, input: TodoListInput) -> Result<TodoList, String> {
    let state = state(app)?;
    let project = input.project.trim().trim_end_matches('/').to_string();
    let known = project.is_empty() || state.projects.lock().unwrap().iter().any(|p| p.trim_end_matches('/') == project);
    let input = TodoListInput { project, ..input };
    if let Some(problem) = list_problem(&input, known) {
        return Err(problem);
    }
    let existing = match input.id {
        Some(id) => Some(state.ledger.todo_list(id).ok_or("That list no longer exists.")?),
        None => None,
    };
    let list = TodoList {
        id: input.id.unwrap_or(0),
        name: input.name.trim().to_string(),
        project: input.project,
        start_mode: input.start_mode,
        position: existing.as_ref().map_or(0, |l| l.position),
        created: 0,
        updated: 0,
    };
    let saved = state.ledger.save_todo_list(&list).ok_or("The list couldn't be saved.")?;
    changed(app);
    Ok(saved)
}

/// A list goes, with its to-dos and their reminders. Work they started stays in history.
pub fn delete_list(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = state(app)?;
    for todo in state.ledger.todos().into_iter().filter(|t| t.list_id == id) {
        if let Some(reminder) = todo.reminder_id {
            let _ = crate::reminders::delete(app, reminder);
        }
    }
    state.ledger.delete_todo_list(id);
    changed(app);
    Ok(())
}

// ---- To-dos -------------------------------------------------------------------------

/// Add a to-do (no id) or change one, as `by` ("you", or an agent). Assigning an agent on a
/// list that starts work at once starts it.
pub fn save(app: &tauri::AppHandle, input: TodoInput, by: &str) -> Result<Todo, String> {
    let state = state(app)?;
    let agent = input.agent_id.clone().filter(|a| !a.trim().is_empty());
    let input = TodoInput { agent_id: agent, ..input };
    if let Some(problem) = todo_problem(&input, input.agent_id.as_deref().is_some_and(|a| agent_enabled(app, a))) {
        return Err(problem);
    }
    let list = state.ledger.todo_list(input.list_id).ok_or("That list no longer exists.")?;
    let existing = match input.id {
        Some(id) => Some(state.ledger.todo(id).ok_or("That to-do no longer exists.")?),
        None => None,
    };
    let moved = existing.as_ref().is_some_and(|t| t.list_id != input.list_id);
    // A to-do moved to another list goes to its end.
    let end_of_list = || state.ledger.todos().iter().filter(|t| t.list_id == input.list_id).map(|t| t.position + 1).max().unwrap_or(0);
    let mut todo = Todo {
        id: input.id.unwrap_or(0),
        list_id: input.list_id,
        title: input.title.trim().to_string(),
        notes: input.notes.trim().to_string(),
        agent_id: input.agent_id.clone(),
        due: input.due,
        added_by: existing.as_ref().map_or_else(|| by.to_string(), |t| t.added_by.clone()),
        position: if moved { end_of_list() } else { existing.as_ref().map_or(0, |t| t.position) },
        ..existing.clone().unwrap_or(Todo {
            id: 0,
            list_id: input.list_id,
            number: 0,
            title: String::new(),
            notes: String::new(),
            agent_id: None,
            task_id: None,
            due: None,
            reminder_id: None,
            done: None,
            done_by: None,
            added_by: by.to_string(),
            position: 0,
            created: 0,
            updated: 0,
        })
    };
    sync_reminder(app, &mut todo);
    let saved = state.ledger.save_todo(&todo).ok_or("The to-do couldn't be saved.")?;
    let newly_assigned = saved.agent_id.is_some() && existing.as_ref().is_none_or(|t| t.agent_id != saved.agent_id);
    changed(app);
    if newly_assigned && list.start_mode == NOW && saved.task_id.is_none() && saved.done.is_none() {
        start(app, saved.id)?;
        return state.ledger.todo(saved.id).ok_or_else(|| "The to-do couldn't be saved.".into());
    }
    Ok(saved)
}

/// Tick a to-do off (or back on), as `by`.
pub fn set_done(app: &tauri::AppHandle, id: i64, done: bool, by: &str) -> Result<Todo, String> {
    let state = state(app)?;
    let mut todo = state.ledger.todo(id).ok_or("That to-do no longer exists.")?;
    if done == todo.done.is_some() {
        return Ok(todo);
    }
    todo.done = done.then(now_ms);
    todo.done_by = done.then(|| by.to_string());
    sync_reminder(app, &mut todo);
    let saved = state.ledger.save_todo(&todo).ok_or("The to-do couldn't be saved.")?;
    changed(app);
    Ok(saved)
}

pub fn delete(app: &tauri::AppHandle, id: i64) -> Result<(), String> {
    let state = state(app)?;
    if let Some(reminder) = state.ledger.todo(id).and_then(|t| t.reminder_id) {
        let _ = crate::reminders::delete(app, reminder);
    }
    state.ledger.delete_todo(id);
    changed(app);
    Ok(())
}

pub fn reorder(app: &tauri::AppHandle, list_id: i64, ids: &[i64]) -> Result<(), String> {
    state(app)?.ledger.reorder_todos(list_id, ids);
    changed(app);
    Ok(())
}

/// Keep a to-do's reminder in step with it: one at its due time while it's open and due ahead,
/// from its agent (or the lead agent, when nobody's assigned); none otherwise.
fn sync_reminder(app: &tauri::AppHandle, todo: &mut Todo) {
    let due = todo.due.filter(|d| todo.done.is_none() && *d > now_ms());
    let Some(due) = due else {
        if let Some(reminder) = todo.reminder_id.take() {
            let _ = crate::reminders::delete(app, reminder);
        }
        return;
    };
    let agent = todo.agent_id.clone().unwrap_or_else(|| crate::delegation::orchestrator_id(app));
    let input = |id: Option<i64>| ReminderInput { id, text: format!("To-do: {}", todo.title), agent_id: agent.clone(), task_id: todo.task_id.clone(), due, repeat: None };
    // A reminder you deleted on Reminders is made again.
    let saved = crate::reminders::save(app, input(todo.reminder_id)).or_else(|_| crate::reminders::save(app, input(None)));
    todo.reminder_id = saved.ok().map(|r| r.id);
}

// ---- Handing work to agents -------------------------------------------------------------

/// Hand a to-do to its agent: an ordinary task in that agent's chat for the list's project.
pub fn start(app: &tauri::AppHandle, id: i64) -> Result<crate::ledger::Task, String> {
    let state = state(app)?;
    let todo = state.ledger.todo(id).ok_or("That to-do no longer exists.")?;
    if todo.done.is_some() {
        return Err("That to-do is already done.".into());
    }
    let agent = todo.agent_id.clone().ok_or("Assign an agent to it first.")?;
    if let Some(task) = todo.task_id.as_deref().and_then(|t| state.ledger.task(t)) {
        if matches!(task.status.as_str(), "doing" | "todo") {
            let name = crate::prompts::agent_name(app, &task.assignee);
            return Err(format!("{name} is already working on it."));
        }
    }
    let list = state.ledger.todo_list(todo.list_id).ok_or("That list no longer exists.")?;
    let dir = (!list.project.is_empty()).then(|| list.project.clone());
    let origin = Origin { requested_by: BY_DEVELOPER, title: Some(&todo.title), note: "Started from your to-do list" };
    let task = crate::tasks::start_for(app, &agent, &prompt_for(&todo, &list), dir, &[], &origin)?;
    state.ledger.save_todo(&Todo { task_id: Some(task.id.clone()), ..todo });
    changed(app);
    Ok(task)
}

/// Hand a whole list to an agent (the lead, usually), who works through its open to-dos in order.
pub fn hand_list(app: &tauri::AppHandle, list_id: i64, agent_id: &str) -> Result<crate::ledger::Task, String> {
    let state = state(app)?;
    if !agent_enabled(app, agent_id) {
        return Err("That agent isn't on the roster.".into());
    }
    let list = state.ledger.todo_list(list_id).ok_or("That list no longer exists.")?;
    let open: Vec<Todo> = state.ledger.todos().into_iter().filter(|t| t.list_id == list_id && t.done.is_none()).collect();
    if open.is_empty() {
        return Err("Everything on this list is done.".into());
    }
    let prompt = list_prompt(&list, &open, |id| crate::prompts::agent_name(app, id));
    let dir = (!list.project.is_empty()).then(|| list.project.clone());
    let title = format!("Work through \"{}\"", list.name);
    let origin = Origin { requested_by: BY_DEVELOPER, title: Some(&title), note: "You handed over your to-do list" };
    let task = crate::tasks::start_for(app, agent_id, &prompt, dir, &[], &origin)?;
    state.ledger.record_list_handoff(&task.id, list.id);
    Ok(task)
}

/// You marked a task reviewed: the to-do it was started for is done.
pub fn task_reviewed(app: &tauri::AppHandle, task_id: &str) {
    let Ok(state) = state(app) else { return };
    if let Some(todo) = state.ledger.todo_for_task(task_id).filter(|t| t.done.is_none()) {
        let _ = set_done(app, todo.id, true, BY_DEVELOPER);
    }
}

/// Whether an agent has nothing running: no task of theirs in progress, and no chat busy.
fn free(app: &tauri::AppHandle, agent_id: &str) -> bool {
    let Ok(state) = state(app) else { return false };
    if !agent_enabled(app, agent_id) {
        return false;
    }
    let working = state.ledger.tasks(200).iter().any(|t| t.assignee == agent_id && matches!(t.status.as_str(), "doing" | "todo"));
    !working && !crate::runs::of_agent(app, agent_id).iter().any(|(_, s)| crate::runs::is_busy(*s))
}

/// Start what's waiting for agents who've come free.
fn tick(app: &tauri::AppHandle) {
    let Ok(state) = state(app) else { return };
    let (lists, todos) = (state.ledger.todo_lists(), state.ledger.todos());
    for picked in pick_up(&lists, &todos, |agent| free(app, agent)) {
        // The developer may have deleted, ticked or moved it since the list was read.
        match recheck_before_start(&state.ledger, picked) {
            Ok(todo) => {
                if let Err(e) = start(app, todo.id) {
                    eprintln!("[todos] couldn't start to-do {}: {e}", todo.id);
                }
            }
            Err(why) => eprintln!("[todos] not starting to-do {}: {why}", picked.id),
        }
    }
}

/// Look for agents who've come free, now and then.
pub fn start_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(TICK);
        tick(&app);
    });
}

// ---- What agents can do -------------------------------------------------------------------

/// The list an agent's to-do goes on: the one it names (made if it's new), else the list of the
/// to-do the agent is working on, else the one for its project, else the Inbox.
fn list_for_agent(app: &tauri::AppHandle, who: &Actor, named: &str) -> Result<TodoList, String> {
    let state = state(app)?;
    let lists = state.ledger.todo_lists();
    let named = named.trim();
    if !named.is_empty() {
        if let Some(list) = lists.iter().find(|l| l.name.eq_ignore_ascii_case(named)) {
            return Ok(list.clone());
        }
        return save_list(app, TodoListInput { id: None, name: named.to_string(), project: String::new(), start_mode: MANUAL.into() });
    }
    let working_on = crate::tasks::task_of(app, who).and_then(|t| state.ledger.todo_for_task(&t)).and_then(|t| state.ledger.todo_list(t.list_id));
    if let Some(list) = working_on {
        return Ok(list);
    }
    if let Some(list) = crate::runs::cwd(app, who).and_then(|folder| list_for_folder(&lists, &folder).cloned()) {
        return Ok(list);
    }
    match lists.into_iter().find(|l| l.name == INBOX) {
        Some(inbox) => Ok(inbox),
        None => save_list(app, TodoListInput { id: None, name: INBOX.into(), project: String::new(), start_mode: MANUAL.into() }),
    }
}

/// The to-dos a list holds, as an agent reads them.
fn describe(app: &tauri::AppHandle, list: &TodoList, todos: &[Todo]) -> String {
    let open: Vec<&Todo> = todos.iter().filter(|t| t.list_id == list.id && t.done.is_none()).collect();
    if open.is_empty() {
        return format!("\"{}\" has nothing left to do.", list.name);
    }
    let mut text = format!("\"{}\":", list.name);
    for t in open {
        let who = t.agent_id.as_deref().map(|a| format!(" [assigned to {}]", crate::prompts::agent_name(app, a))).unwrap_or_default();
        text.push_str(&format!("\n- #{} {} (ref {}){who}", t.number, t.title, token(t)));
        if !t.notes.is_empty() {
            text.push_str(&format!("\n  {}", t.notes.replace('\n', "\n  ")));
        }
    }
    text
}

fn pointer_of(req: &serde_json::Value, list: String) -> TodoRef {
    TodoRef { number: req.get("number").and_then(|v| v.as_i64()), id: req.get("id").and_then(|v| v.as_i64()), list }
}

/// The list this agent's work is about: the one its task's to-do is on, else the one it was handed whole.
fn handed_list(app: &tauri::AppHandle, who: &Actor) -> Option<i64> {
    let state = state(app).ok()?;
    let task = crate::tasks::task_of(app, who)?;
    state.ledger.todo_for_task(&task).map(|t| t.list_id).or_else(|| state.ledger.list_handed_for_task(&task))
}

/// What an agent that pointed at a to-do by its old global id is told when it's no longer there.
fn gone_by_id(standing: &Standing, id: i64) -> String {
    let verdict = if matches!(standing, Standing::Missing) { "NOT FOUND" } else { "DELETED" };
    format!("{verdict}: no to-do with the old id {id} exists any more. Skip it and report that it's gone; use `number` and `list` from now on.")
}

/// The developer hears when a to-do an agent was working on is gone from under it.
fn removed_while_working(app: &tauri::AppHandle, who: &Actor, task: Option<&str>, standing: &Standing, list_id: i64, number: i64, list: &str) {
    static TOLD: std::sync::Mutex<Vec<(String, i64, i64)>> = std::sync::Mutex::new(Vec::new());
    let Ok(state) = state(app) else { return };
    let key = (who.agent.clone(), list_id, number);
    {
        let mut told = TOLD.lock().unwrap();
        if told.contains(&key) {
            return;
        }
        told.push(key);
    }
    let (title, what) = match standing {
        Standing::Deleted { title, .. } => (title.as_str(), "had been deleted".to_string()),
        Standing::Moved { title, list_id, number, .. } => {
            let to = state.ledger.todo_list(*list_id).map(|l| l.name).unwrap_or_default();
            (title.as_str(), format!("had been moved to \"{to}\" (#{number})"))
        }
        _ => return,
    };
    let name = crate::prompts::agent_name(app, &who.agent);
    let cwd = state.ledger.todo_list(list_id).map(|l| l.project).unwrap_or_default();
    if let Some(stored) = state.ledger.add_notification(&crate::ledger::NewNotification {
        kind: "todo_removed",
        urgency: "update",
        agent_id: &who.agent,
        task_id: task,
        cwd: &cwd,
        title: &format!("To-do #{number} \"{title}\" was removed while {name} was working on it"),
        body: &format!("{name} tried to tick it off on \"{list}\", but it {what}. Nothing was ticked."),
        ..Default::default()
    }) {
        crate::system_notifications::deliver(app, &stored, "");
        let _ = app.emit("notifications://changed", ());
    }
}

/// An agent adds a to-do, ticks one off, checks one, or reads a list (`action`: add | done | check | list).
pub fn tool(app: &tauri::AppHandle, who: &Actor, req: &serde_json::Value) -> Result<String, String> {
    let text = |key: &str| req.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match text("action").as_str() {
        "add" => {
            let list = list_for_agent(app, who, &text("list"))?;
            let input = TodoInput { id: None, list_id: list.id, title: text("title"), notes: text("notes"), agent_id: None, due: None };
            let todo = save(app, input, &who.agent)?;
            Ok(format!("Added to-do #{} to \"{}\". The developer sees you added it.", todo.number, list.name))
        }
        "check" => {
            let state = state(app)?;
            let (lists, handed) = (state.ledger.todo_lists(), handed_list(app, who));
            let target = locate(&lists, &pointer_of(req, text("list")), handed)?;
            let (list_id, number, standing) = match target {
                Target::Numbered { list_id, number } => (list_id, number, state.ledger.standing(list_id, number)),
                Target::Id { id, .. } => match state.ledger.standing_by_id(id) {
                    Standing::Found(t) => (t.list_id, t.number, Standing::Found(t)),
                    gone => return Ok(gone_by_id(&gone, id)),
                },
            };
            let (list_name, agent_name) = (|id: i64| state.ledger.todo_list(id).map(|l| l.name).unwrap_or_default(), |id: &str| crate::prompts::agent_name(app, id));
            Ok(check_report(&standing, list_id, number, &Names { list: &list_name, agent: &agent_name }))
        }
        "done" => {
            let state = state(app)?;
            let handed = handed_list(app, who);
            let my_task = crate::tasks::task_of(app, who);
            let target = locate(&state.ledger.todo_lists(), &pointer_of(req, text("list")), handed)?;
            let (list_id, number, standing) = match target {
                Target::Numbered { list_id, number } => (list_id, number, state.ledger.standing(list_id, number)),
                Target::Id { id, list_id: on } => match state.ledger.standing_by_id(id) {
                    Standing::Found(t) if on.is_some_and(|named| named != t.list_id) => {
                        return Err(format!("To-do id {id} isn't on \"{}\". Use its number on that list instead.", text("list").trim()));
                    }
                    Standing::Found(t) => (t.list_id, t.number, Standing::Found(t)),
                    gone => return Err(format!("Not ticked: {}", gone_by_id(&gone, id))),
                },
            };
            let (list_name, agent_name) = (|id: i64| state.ledger.todo_list(id).map(|l| l.name).unwrap_or_default(), |id: &str| crate::prompts::agent_name(app, id));
            let names = Names { list: &list_name, agent: &agent_name };
            let mine = was_mine(&standing, list_id, my_task.as_deref(), handed);
            if let Some(why) = tick_refusal(&standing, list_id, number, mine, &names) {
                if mine && !matches!(standing, Standing::Found(_)) {
                    removed_while_working(app, who, my_task.as_deref(), &standing, list_id, number, &(names.list)(list_id));
                }
                return Err(why);
            }
            let Standing::Found(seen) = standing else { unreachable!("only a found to-do passes the refusal") };
            if let Some(problem) = identity_problem(&seen, &(names.list)(list_id), &text("title"), &text("ref")) {
                return Err(problem);
            }
            // The last look and the tick are one statement: it only ticks if nothing changed since.
            if !state.ledger.tick_if_unchanged(&seen, &who.agent) {
                let now = state.ledger.standing_by_id(seen.id);
                let why = tick_refusal(&now, list_id, number, true, &names)
                    .unwrap_or_else(|| format!("Not ticked: to-do #{number} on \"{}\" changed while you were ticking it. Check it with `check_todo` and try again.", (names.list)(list_id)));
                if !matches!(now, Standing::Found(_)) {
                    removed_while_working(app, who, my_task.as_deref(), &now, list_id, number, &(names.list)(list_id));
                }
                return Err(why);
            }
            // Its reminder goes with it being done.
            if let Some(mut done) = state.ledger.todo(seen.id) {
                sync_reminder(app, &mut done);
                state.ledger.save_todo(&done);
            }
            changed(app);
            Ok(format!("Ticked off to-do #{} \"{}\" on \"{}\".", seen.number, seen.title, (names.list)(list_id)))
        }
        "list" => {
            let state = state(app)?;
            let (lists, todos) = (state.ledger.todo_lists(), state.ledger.todos());
            let named = text("list");
            let shown: Vec<&TodoList> = lists.iter().filter(|l| named.trim().is_empty() || l.name.eq_ignore_ascii_case(named.trim())).collect();
            if shown.is_empty() {
                return Err(format!("There's no list called \"{named}\"."));
            }
            Ok(shown.into_iter().map(|l| describe(app, l, &todos)).collect::<Vec<_>>().join("\n\n"))
        }
        other => Err(format!("Unknown to-do action \"{other}\".")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(id: i64, project: &str, mode: &str) -> TodoList {
        TodoList { id, name: format!("List {id}"), project: project.into(), start_mode: mode.into(), position: id, created: 0, updated: 0 }
    }

    fn todo(id: i64, list_id: i64, agent: Option<&str>) -> Todo {
        Todo {
            id,
            list_id,
            number: id,
            title: format!("Thing {id}"),
            notes: String::new(),
            agent_id: agent.map(str::to_string),
            task_id: None,
            due: None,
            reminder_id: None,
            done: None,
            done_by: None,
            added_by: "you".into(),
            position: id,
            created: 0,
            updated: 0,
        }
    }

    #[test]
    fn a_list_and_a_todo_say_what_they_need() {
        let good = TodoListInput { id: None, name: "Release".into(), project: String::new(), start_mode: NOW.into() };
        assert_eq!(list_problem(&good, true), None);
        assert!(list_problem(&TodoListInput { name: " ".into(), ..good.clone() }, true).is_some());
        assert!(list_problem(&TodoListInput { start_mode: "later".into(), ..good.clone() }, true).is_some());
        assert!(list_problem(&TodoListInput { project: "/nope".into(), ..good }, false).is_some());

        let item = TodoInput { id: None, list_id: 1, title: "Build the APK".into(), notes: String::new(), agent_id: Some("jarvis".into()), due: None };
        assert_eq!(todo_problem(&item, true), None);
        assert!(todo_problem(&item, false).is_some(), "an unknown agent");
        assert!(todo_problem(&TodoInput { title: "x".repeat(TITLE_LIMIT + 1), ..item }, true).is_some());
    }

    #[test]
    fn an_agent_is_told_which_todo_it_is_and_how_to_tick_it_off() {
        // The 12th to-do made overall is only the 3rd on its list: the agent is told "#3", never "#12".
        let mut t = Todo { number: 3, ..todo(12, 1, Some("karen")) };
        t.title = "Fix the splash".into();
        t.notes = "Use the new logo.".into();
        let prompt = prompt_for(&t, &list(1, "", MANUAL));
        assert!(prompt.starts_with("Fix the splash\n\nUse the new logo."));
        assert!(prompt.contains("to-do #3 on the developer's \"List 1\" list") && prompt.contains("complete_todo"));
        assert!(prompt.contains("number 3, list \"List 1\""), "it says how to point at it");
        assert!(!prompt.contains("#12"));
        // It must check before starting and again before ticking, and says what to do when it is gone.
        assert!(prompt.contains("before you start, check it's still there and open with the `check_todo` tool (number 3"));
        assert!(prompt.contains("check it again, then tick it off") && prompt.contains("ref T12") && prompt.contains("title \"Fix the splash\""));
        assert!(prompt.contains("gone, done or moved, stop and say so"));

        let handed = list_prompt(&list(1, "", MANUAL), &[t, Todo { number: 4, ..todo(13, 1, None) }], |id| id.to_uppercase());
        assert!(handed.contains("- #3 Fix the splash (ref T12) (Use the new logo.) [assigned to KAREN]"));
        assert!(handed.contains("- #4 Thing 13 (ref T13)\n"), "one with nothing more is just its title");
        assert!(handed.contains("immediately before you start it, call `check_todo`") && handed.contains("Immediately before ticking it, call `check_todo` again"));
        assert!(handed.contains("skip it and report that at the end") && handed.contains("gone, done or moved"));
        assert!(handed.contains("belong to \"List 1\" only") && !handed.contains("#12") && !handed.contains("#13 "));
    }

    fn pointer(number: Option<i64>, id: Option<i64>, list: &str) -> TodoRef {
        TodoRef { number, id, list: list.into() }
    }

    fn at(list_id: i64, number: i64) -> Target {
        Target::Numbered { list_id, number }
    }

    fn two_lists() -> Vec<TodoList> {
        vec![list(1, "", MANUAL), list(2, "", MANUAL)]
    }

    #[test]
    fn a_number_means_a_place_on_one_list_only() {
        let lists = two_lists();
        // The list it names wins, even over the one the agent was handed.
        assert_eq!(locate(&lists, &pointer(Some(2), None, "list 2"), Some(1)), Ok(at(2, 2)), "names are matched without case");
        // With no list named it is the one the agent was handed.
        assert_eq!(locate(&lists, &pointer(Some(2), None, ""), Some(1)), Ok(at(1, 2)));
        assert_eq!(locate(&lists, &pointer(Some(2), None, ""), Some(2)), Ok(at(2, 2)));
    }

    #[test]
    fn a_number_with_no_list_to_go_by_is_never_guessed() {
        let lists = two_lists();
        let err = locate(&lists, &pointer(Some(1), None, ""), None).unwrap_err();
        assert!(err.contains("which list") && err.contains("List 1") && err.contains("List 2"), "{err}");
        // A handed list that has since been deleted isn't used.
        assert!(locate(&lists, &pointer(Some(1), None, ""), Some(99)).is_err());
        // With a single list there's nothing to mix up.
        assert_eq!(locate(&lists[..1], &pointer(Some(2), None, ""), None), Ok(at(1, 2)));
        assert!(locate(&lists, &pointer(Some(1), None, "Nope"), Some(1)).unwrap_err().contains("no list called"));
        let twins = vec![list(1, "", MANUAL), TodoList { id: 2, name: "list 1".into(), ..list(2, "", MANUAL) }];
        assert!(locate(&twins, &pointer(Some(1), None, "List 1"), None).unwrap_err().contains("More than one"));
    }

    #[test]
    fn an_old_global_id_still_points_somewhere_and_a_number_wins() {
        let lists = two_lists();
        assert_eq!(locate(&lists, &pointer(None, Some(21), ""), None), Ok(Target::Id { id: 21, list_id: None }));
        assert_eq!(locate(&lists, &pointer(None, Some(21), "List 2"), Some(1)), Ok(Target::Id { id: 21, list_id: Some(2) }));
        assert_eq!(locate(&lists, &pointer(Some(1), Some(21), "List 1"), None), Ok(at(1, 1)));
        assert!(locate(&lists, &pointer(None, None, ""), Some(1)).unwrap_err().contains("Say which"));
    }

    fn names<'a>(list: &'a dyn Fn(i64) -> String, agent: &'a dyn Fn(&str) -> String) -> Names<'a> {
        Names { list, agent }
    }

    fn found(id: i64, number: i64, title: &str) -> Todo {
        Todo { number, title: title.into(), ..todo(id, 1, None) }
    }

    #[test]
    fn check_reports_open_done_moved_deleted_and_unknown() {
        let (list, agent) = (|id: i64| format!("List {id}"), |id: &str| id.to_uppercase());
        let n = names(&list, &agent);
        let open = Todo { notes: "Use the new logo.".into(), agent_id: Some("karen".into()), ..found(12, 3, "Fix the splash") };
        let said = check_report(&Standing::Found(open.clone()), 1, 3, &n);
        assert!(said.starts_with("OPEN:") && said.contains("\"Fix the splash\"") && said.contains("ref T12"), "{said}");
        assert!(said.contains("Assigned to KAREN") && said.contains("Use the new logo."), "{said}");

        let ticked = Todo { done: Some(1_700_000_000_000), done_by: Some("friday".into()), ..open };
        let said = check_report(&Standing::Found(ticked), 1, 3, &n);
        assert!(said.starts_with("DONE:") && said.contains("ticked off by FRIDAY") && said.contains("skip it"), "{said}");

        let said = check_report(&Standing::Moved { title: "Fix the splash".into(), task_id: None, list_id: 2, number: 7 }, 1, 3, &n);
        assert!(said.starts_with("MOVED:") && said.contains("\"List 2\"") && said.contains("#7"), "{said}");

        let said = check_report(&Standing::Deleted { title: "Fix the splash".into(), task_id: None, at: 1_700_000_000_000 }, 1, 3, &n);
        assert!(said.starts_with("DELETED:") && said.contains("skip it"), "{said}");

        let said = check_report(&Standing::Missing, 1, 9, &n);
        assert!(said.starts_with("NOT FOUND:") && said.contains("#9"), "{said}");
    }

    #[test]
    fn a_tick_is_refused_for_each_way_the_todo_can_be_gone() {
        let (list, agent) = (|id: i64| format!("List {id}"), |id: &str| id.to_uppercase());
        let n = names(&list, &agent);
        let open = found(12, 3, "Fix the splash");
        assert_eq!(tick_refusal(&Standing::Found(open.clone()), 1, 3, true, &n), None, "an open one may be ticked");

        let ticked = Todo { done: Some(5), done_by: Some(BY_DEVELOPER.into()), ..open };
        let why = tick_refusal(&Standing::Found(ticked), 1, 3, true, &n).unwrap();
        assert!(why.starts_with("Not ticked") && why.contains("already done") && why.contains("the developer"), "{why}");

        let deleted = Standing::Deleted { title: "Fix the splash".into(), task_id: Some("task-1".into()), at: 5 };
        let why = tick_refusal(&deleted, 1, 3, true, &n).unwrap();
        assert!(why.contains("was deleted") && why.contains("removed while you were working on it"), "{why}");
        let why = tick_refusal(&deleted, 1, 3, false, &n).unwrap();
        assert!(why.contains("was deleted") && !why.contains("while you were working"), "an agent that wasn't on it is not told that: {why}");

        let moved = Standing::Moved { title: "Fix the splash".into(), task_id: None, list_id: 2, number: 7 };
        let why = tick_refusal(&moved, 1, 3, true, &n).unwrap();
        assert!(why.contains("moved to \"List 2\"") && why.contains("#7") && why.contains("removed while you were working"), "{why}");

        let why = tick_refusal(&Standing::Missing, 1, 9, true, &n).unwrap();
        assert!(why.starts_with("Not ticked") && why.contains("no to-do #9"), "{why}");
    }

    #[test]
    fn a_gone_todo_was_the_agents_when_its_task_or_handed_list_says_so() {
        let deleted = Standing::Deleted { title: "x".into(), task_id: Some("task-1".into()), at: 0 };
        assert!(was_mine(&deleted, 1, Some("task-1"), None), "the task it was started for");
        assert!(was_mine(&deleted, 1, Some("task-9"), Some(1)), "the list the agent was handed whole");
        assert!(!was_mine(&deleted, 1, Some("task-9"), Some(2)));
        assert!(!was_mine(&deleted, 1, None, None));
        assert!(!was_mine(&Standing::Missing, 1, Some("task-1"), None));
    }

    #[test]
    fn a_tick_must_name_the_same_todo_by_title_or_ref_and_never_falls_back() {
        let t = found(12, 3, "Fix the splash");
        assert!(identity_problem(&t, "List 1", "Fix the splash", "").is_none());
        assert!(identity_problem(&t, "List 1", "  fix  the SPLASH. ", "").is_none(), "case, spacing and a full stop don't matter");
        assert!(identity_problem(&t, "List 1", "", "T12").is_none());
        assert!(identity_problem(&t, "List 1", "", "#t12").is_none());
        assert!(identity_problem(&t, "List 1", "Fix the splash", "T12").is_none());
        let why = identity_problem(&t, "List 1", "Update the icons", "").unwrap();
        assert!(why.starts_with("Not ticked") && why.contains("different to-do") && why.contains("Fix the splash"), "{why}");
        assert!(identity_problem(&t, "List 1", "", "T99").unwrap().contains("different to-do"));
        assert!(identity_problem(&t, "List 1", "Fix the splash", "T99").is_some(), "both must match");
        assert!(identity_problem(&t, "List 1", "Update the icons", "T12").is_some(), "both must match");
        let none = identity_problem(&t, "List 1", " ", "").unwrap();
        assert!(none.contains("say which to-do") || none.contains("Say") || none.contains("which to-do"), "{none}");
    }

    #[test]
    fn the_scheduler_skips_a_todo_that_changed_before_it_was_dispatched() {
        use crate::ledger::Ledger;
        let dir = std::env::temp_dir().join(format!("stark-todos-sched-{}-{}", std::process::id(), crate::ledger::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let l = Ledger::open(&dir.join("ledger.db")).unwrap();
        let waiting = l.save_todo_list(&TodoList { id: 0, name: "W".into(), project: String::new(), start_mode: WHEN_FREE.into(), position: 0, created: 0, updated: 0 }).unwrap();
        let other = l.save_todo_list(&TodoList { id: 0, name: "O".into(), project: String::new(), start_mode: WHEN_FREE.into(), position: 0, created: 0, updated: 0 }).unwrap();
        let add = |title: &str| l.save_todo(&Todo { list_id: waiting.id, title: title.into(), agent_id: Some("karen".into()), ..todo(0, waiting.id, None) }).unwrap();

        let still_there = add("still there");
        assert_eq!(recheck_before_start(&l, &still_there).map(|t| t.id), Ok(still_there.id));

        let deleted = add("deleted meanwhile");
        l.delete_todo(deleted.id);
        assert!(recheck_before_start(&l, &deleted).unwrap_err().contains("deleted"));

        let ticked = add("ticked meanwhile");
        assert!(l.tick_if_unchanged(&ticked, BY_DEVELOPER));
        assert!(recheck_before_start(&l, &ticked).unwrap_err().contains("ticked"));

        let moved = add("moved meanwhile");
        l.save_todo(&Todo { list_id: other.id, ..l.todo(moved.id).unwrap() }).unwrap();
        assert!(recheck_before_start(&l, &moved).unwrap_err().contains("moved"));

        let reassigned = add("reassigned meanwhile");
        l.save_todo(&Todo { agent_id: Some("friday".into()), ..l.todo(reassigned.id).unwrap() }).unwrap();
        assert!(recheck_before_start(&l, &reassigned).unwrap_err().contains("someone else"));

        let started = add("started meanwhile");
        l.save_todo(&Todo { task_id: Some("t".into()), ..l.todo(started.id).unwrap() }).unwrap();
        assert!(recheck_before_start(&l, &started).is_err());
    }

    #[test]
    fn free_agents_pick_up_one_waiting_todo_each_in_list_order() {
        let lists = [list(1, "", WHEN_FREE), list(2, "", MANUAL), list(3, "", WHEN_FREE)];
        let mut started = todo(4, 1, Some("karen"));
        started.task_id = Some("task-4".into());
        let todos = [
            started,
            todo(5, 1, Some("karen")),
            todo(6, 1, Some("karen")),
            todo(7, 2, Some("friday")),
            todo(8, 3, Some("friday")),
            todo(9, 3, Some("edith")),
            todo(10, 3, None),
        ];
        let picked: Vec<i64> = pick_up(&lists, &todos, |agent| agent != "edith").into_iter().map(|t| t.id).collect();
        // KAREN gets her first unstarted one; FRIDAY's on a manual list waits for Start; EDITH is busy.
        assert_eq!(picked, [5, 8]);
    }

    #[test]
    fn an_agents_folder_finds_the_list_for_its_project() {
        let lists = [list(1, "/w", MANUAL), list(2, "/w/app", MANUAL), list(3, "", MANUAL)];
        assert_eq!(list_for_folder(&lists, "/w/app/src").map(|l| l.id), Some(2), "the most specific project");
        assert_eq!(list_for_folder(&lists, "/w/api").map(|l| l.id), Some(1));
        assert_eq!(list_for_folder(&lists, "/elsewhere"), None);
    }
}
