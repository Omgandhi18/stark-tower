//! To-do lists. You keep named lists, each tied to a project or not; a to-do can be
//! assigned to an agent, and starting it hands it over as an ordinary task in that
//! agent's chat for the project. What assigning does is the list's own setting: wait
//! for Start, start at once, or start when the agent has nothing running. Agents add
//! the follow-ups they find and tick off what they finished, and a to-do with a due
//! time reminds you, through the assigned agent.

use crate::reminders::ReminderInput;
use crate::runs::Actor;
use crate::tasks::{Origin, BY_DEVELOPER};
use crate::todo_store::{Todo, TodoList};
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

/// What an agent is asked when a to-do is handed to it.
pub fn prompt_for(todo: &Todo, list: &TodoList) -> String {
    let mut prompt = todo.title.trim().to_string();
    if !todo.notes.trim().is_empty() {
        prompt.push_str("\n\n");
        prompt.push_str(todo.notes.trim());
    }
    prompt.push_str(&format!(
        "\n\n(This is to-do #{} on the developer's \"{}\" list. When it's done, tick it off with the `complete_todo` tool.)",
        todo.id, list.name
    ));
    prompt
}

/// What an agent is asked when a whole list is handed to it: the open to-dos, in order.
pub fn list_prompt(list: &TodoList, open: &[Todo], name_of: impl Fn(&str) -> String) -> String {
    let mut prompt = format!("Work through my to-do list \"{}\", in order:\n", list.name);
    for t in open {
        prompt.push_str(&format!("\n- #{} {}", t.id, t.title.trim()));
        if let Some(line) = t.notes.lines().map(str::trim).find(|l| !l.is_empty()) {
            prompt.push_str(&format!(" ({line})"));
        }
        if let Some(agent) = &t.agent_id {
            prompt.push_str(&format!(" [assigned to {}]", name_of(agent)));
        }
    }
    prompt.push_str(
        "\n\nDo each yourself, or delegate it (to whoever it's assigned to, if anyone). Tick each off with \
`complete_todo` as it's done, and add follow-ups you find with `add_todo`. Read any to-do's notes with `list_todos`.",
    );
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
    crate::tasks::start_for(app, agent_id, &prompt, dir, &[], &origin)
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
    for todo in pick_up(&lists, &todos, |agent| free(app, agent)) {
        if let Err(e) = start(app, todo.id) {
            eprintln!("[todos] couldn't start to-do {}: {e}", todo.id);
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
        text.push_str(&format!("\n- #{} {}{who}", t.id, t.title));
        if !t.notes.is_empty() {
            text.push_str(&format!("\n  {}", t.notes.replace('\n', "\n  ")));
        }
    }
    text
}

/// An agent adds a to-do, ticks one off, or reads a list (`action`: add | done | list).
pub fn tool(app: &tauri::AppHandle, who: &Actor, req: &serde_json::Value) -> Result<String, String> {
    let text = |key: &str| req.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match text("action").as_str() {
        "add" => {
            let list = list_for_agent(app, who, &text("list"))?;
            let input = TodoInput { id: None, list_id: list.id, title: text("title"), notes: text("notes"), agent_id: None, due: None };
            let todo = save(app, input, &who.agent)?;
            Ok(format!("Added to-do #{} to \"{}\". The developer sees you added it.", todo.id, list.name))
        }
        "done" => {
            let id = req.get("id").and_then(|v| v.as_i64()).ok_or("Say which to-do, by its number.")?;
            let todo = set_done(app, id, true, &who.agent)?;
            Ok(format!("Ticked off to-do #{} \"{}\".", todo.id, todo.title))
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
        let mut t = todo(12, 1, Some("karen"));
        t.title = "Fix the splash".into();
        t.notes = "Use the new logo.".into();
        let prompt = prompt_for(&t, &list(1, "", MANUAL));
        assert!(prompt.starts_with("Fix the splash\n\nUse the new logo."));
        assert!(prompt.contains("to-do #12 on the developer's \"List 1\" list") && prompt.contains("complete_todo"));

        let handed = list_prompt(&list(1, "", MANUAL), &[t, todo(13, 1, None)], |id| id.to_uppercase());
        assert!(handed.contains("- #12 Fix the splash (Use the new logo.) [assigned to KAREN]"));
        assert!(handed.contains("- #13 Thing 13\n"), "one with nothing more is just its title");
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
