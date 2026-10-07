//! The task engine. Work the developer hands over starts in the agent's chat in that
//! project, or in a chat of its own while that one is busy: an agent can work in
//! several chats at once. The engine follows each task through its chat's session
//! (files changed, commands run, the owner's own plan, checks that passed or failed)
//! and marks it ready for review when the owner's turn ends with nothing delegated
//! still running.

use crate::ledger::{NewTask, StoredMessage, Task, TaskEvent};
use crate::runs::Actor;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Component, Path};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Who asked for work the developer started.
pub const BY_DEVELOPER: &str = "you";
const TITLE_LIMIT: usize = 80;
const EVENT_LIMIT: i64 = 400;
const MESSAGE_LIMIT: i64 = 500;
const GIT_TIMEOUT: Duration = Duration::from_secs(5);

/// A check the owner ran (tests, type check, lint, build), waiting for its result.
struct PendingCheck {
    task_id: String,
    agent_id: String,
    command: String,
    kind: CheckKind,
    started: Instant,
}

#[derive(Default)]
pub struct TaskEngine {
    /// The task each chat is working on, by conversation.
    current: Mutex<HashMap<i64, String>>,
    /// Checks in flight, by the provider's tool-use id.
    checks: Mutex<HashMap<String, PendingCheck>>,
    /// Each running task's latest round of work, to tell when it ends whether it changed anything.
    rounds: Mutex<HashMap<String, Round>>,
    /// Delegated tasks running on a one-shot worker, and the worker's process: how one is stopped.
    workers: Mutex<HashMap<String, u32>>,
    /// Tasks you stopped whose worker hasn't reported back yet: its end reads as your stop.
    stopped: Mutex<HashSet<String>>,
}

/// A round of work on a task: from the request (or follow-up) to the end of the agent's turn.
struct Round {
    started: i64,
    /// What the task's folder looked like to git when it began; taken in the background.
    before: Arc<OnceLock<Option<String>>>,
    /// The task already had changes waiting for review when this round began.
    ready: bool,
}

// ---- Pure helpers ------------------------------------------------------------

/// A task's title: the first line of what was asked, kept short.
/// Labels a request may open with, alone on a line or before the words ("Task: …").
const TITLE_LABELS: [&str; 8] = ["objective", "task", "goal", "context", "request", "summary", "title", "todo"];

/// What a line of a request says, without a heading's marks or a leading label;
/// empty when it's only a heading ("OBJECTIVE", "## Goal").
fn title_words(line: &str) -> &str {
    let line = line.trim().trim_start_matches('#').trim();
    if let Some((label, rest)) = line.split_once(':') {
        if TITLE_LABELS.contains(&label.trim().to_lowercase().as_str()) {
            return rest.trim();
        }
    }
    let letters = line.chars().filter(|c| c.is_alphabetic());
    let shouted = letters.clone().count() > 0 && letters.clone().all(char::is_uppercase) && line.split_whitespace().count() <= 2;
    if shouted || TITLE_LABELS.contains(&line.to_lowercase().as_str()) {
        ""
    } else {
        line
    }
}

/// A task's title: the first line of its request that says something.
pub fn title_from(prompt: &str) -> String {
    let first = prompt.lines().map(str::trim).find(|l| !l.is_empty());
    let line = prompt.lines().map(title_words).find(|l| !l.is_empty()).or(first).unwrap_or("Untitled task");
    if line.chars().count() <= TITLE_LIMIT {
        line.to_string()
    } else {
        let cut: String = line.chars().take(TITLE_LIMIT - 1).collect();
        format!("{}…", cut.trim_end())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckKind {
    Tests,
    TypeCheck,
    Lint,
    Build,
    EndToEnd,
}

impl CheckKind {
    pub fn label(self) -> &'static str {
        match self {
            CheckKind::Tests => "Tests",
            CheckKind::TypeCheck => "Type check",
            CheckKind::Lint => "Lint",
            CheckKind::Build => "Build",
            CheckKind::EndToEnd => "End-to-end tests",
        }
    }
}

fn has_word(text: &str, word: &str) -> bool {
    text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == ':' || c == '_'))
        .any(|w| w == word || w.split(':').any(|part| part == word))
}

/// Whether a shell command is a verification step, and which kind.
pub fn check_kind(command: &str) -> Option<CheckKind> {
    let c = command.to_lowercase();
    let any = |words: &[&str]| words.iter().any(|w| has_word(&c, w));
    if any(&["playwright", "cypress", "e2e", "detox", "maestro"]) {
        return Some(CheckKind::EndToEnd);
    }
    if any(&["tsc", "typecheck", "type-check", "mypy", "pyright", "vue-tsc", "svelte-check"]) || c.contains("cargo check") {
        return Some(CheckKind::TypeCheck);
    }
    if any(&["lint", "eslint", "clippy", "ruff", "biome", "stylelint", "golangci-lint", "rubocop", "swiftlint", "ktlint", "shellcheck"]) {
        return Some(CheckKind::Lint);
    }
    if any(&["test", "tests", "pytest", "vitest", "jest", "mocha", "rspec", "phpunit", "ava"]) {
        return Some(CheckKind::Tests);
    }
    if any(&["build", "xcodebuild"]) {
        return Some(CheckKind::Build);
    }
    None
}

/// One step of the owner's own plan (its to-do list).
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct PlanItem {
    pub content: String,
    /// pending | in_progress | completed
    pub status: String,
    /// How the step reads while it's being done ("Running the tests").
    pub active: Option<String>,
}

/// The plan in a TodoWrite call's input.
pub fn plan_from(input: &serde_json::Value) -> Option<Vec<PlanItem>> {
    let todos = input.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|t| {
                Some(PlanItem {
                    content: t.get("content")?.as_str()?.to_string(),
                    status: t.get("status").and_then(|s| s.as_str()).unwrap_or("pending").to_string(),
                    active: t.get("activeForm").and_then(|s| s.as_str()).map(str::to_string),
                })
            })
            .collect(),
    )
}

/// A file with uncommitted changes in the task's folder.
#[derive(Debug, Clone, Serialize, specta::Type, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// added | modified | deleted | renamed | untracked
    pub status: String,
    pub added: Option<i64>,
    pub removed: Option<i64>,
}

/// `git status --porcelain=v1 -z` → changed files (without line counts).
pub fn parse_porcelain(output: &str) -> Vec<FileChange> {
    let mut changes = Vec::new();
    let mut entries = output.split('\0').filter(|e| !e.is_empty());
    while let Some(entry) = entries.next() {
        if entry.len() < 4 {
            continue;
        }
        let (code, path) = entry.split_at(3);
        let code = code.trim();
        let status = match code {
            "??" => "untracked",
            c if c.contains('R') => {
                entries.next(); // the original path follows a rename
                "renamed"
            }
            c if c.contains('A') => "added",
            c if c.contains('D') => "deleted",
            _ => "modified",
        };
        changes.push(FileChange { path: path.to_string(), status: status.into(), added: None, removed: None });
    }
    changes
}

/// `git diff --numstat HEAD` → lines added and removed per path ("-" for binary files).
pub fn parse_numstat(output: &str) -> HashMap<String, (Option<i64>, Option<i64>)> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, '\t');
            let added = parts.next()?.parse().ok();
            let removed = parts.next()?.parse().ok();
            let path = parts.next()?.to_string();
            // Renames print "old => new"; the board shows the new path.
            let path = match path.split_once(" => ") {
                Some((_, new)) => new.trim_matches(['{', '}']).to_string(),
                None => path,
            };
            Some((path, (added, removed)))
        })
        .collect()
}

/// A path relative to the task's folder, for display.
fn relative(path: &str, cwd: &str) -> String {
    Path::new(path).strip_prefix(cwd).map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| path.to_string())
}

/// Only plain paths inside the folder may be diffed (no `..`, no absolute paths).
pub(crate) fn safe_relative(path: &str) -> bool {
    let p = Path::new(path);
    !path.is_empty() && p.components().all(|c| matches!(c, Component::Normal(_)))
}

// ---- Git ---------------------------------------------------------------------

/// Run git in `cwd`, giving up after a few seconds. None when it fails.
fn git(cwd: &str, args: &[&str]) -> Option<String> {
    if cwd.is_empty() || !Path::new(cwd).is_dir() {
        return None;
    }
    let mut command = Command::new("git");
    command.arg("--literal-pathspecs").arg("-C").arg(cwd).args(args).stdin(Stdio::null()).env("GIT_TERMINAL_PROMPT", "0");
    crate::hosting::run(command, GIT_TIMEOUT, None).ok()
}

/// What a folder's work looks like to git: its commit, its status (untracked files
/// included) and the content of its uncommitted changes. None outside a repository.
fn snapshot(cwd: &str) -> Option<String> {
    use std::hash::{Hash, Hasher};
    let status = git(cwd, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
    let head = git(cwd, &["rev-parse", "HEAD"]).unwrap_or_default();
    let diff = git(cwd, &["diff", "--no-color", "--no-ext-diff", "HEAD"]).unwrap_or_default();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    diff.hash(&mut hasher);
    Some(format!("{}\n{status}\n{:x}", head.trim(), hasher.finish()))
}

pub fn current_branch(cwd: &str) -> Option<String> {
    git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).map(|b| b.trim().to_string()).filter(|b| !b.is_empty())
}

/// Uncommitted changes in a folder, with line counts where git has them.
pub fn changes(cwd: &str) -> Vec<FileChange> {
    let Some(status) = git(cwd, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]) else {
        return vec![];
    };
    let counts = git(cwd, &["diff", "--numstat", "HEAD"]).map(|o| parse_numstat(&o)).unwrap_or_default();
    parse_porcelain(&status)
        .into_iter()
        .map(|mut change| {
            if let Some((added, removed)) = counts.get(&change.path) {
                change.added = *added;
                change.removed = *removed;
            }
            change
        })
        .collect()
}

/// The readable diff of one changed file (an untracked file shows as all added).
pub fn file_diff(cwd: &str, path: &str) -> Result<String, String> {
    if !safe_relative(path) {
        return Err("That file isn't inside the task's folder.".into());
    }
    if let Some(diff) = git(cwd, &["diff", "--no-color", "HEAD", "--", path]).filter(|d| !d.trim().is_empty()) {
        return Ok(diff);
    }
    git(cwd, &["diff", "--no-color", "--no-index", "--", "/dev/null", path])
        .or_else(|| {
            // `--no-index` exits 1 when files differ, which `git` treats as failure.
            let file = Path::new(cwd).join(path);
            let text = if file.is_symlink() { std::fs::read_link(&file).map(|target| target.to_string_lossy().into_owned()) } else { std::fs::read_to_string(&file) };
            text.ok()
                .map(|text| text.lines().map(|l| format!("+{l}")).collect::<Vec<_>>().join("\n"))
        })
        .ok_or_else(|| "There is no change to show for that file.".into())
}

// ---- Engine ------------------------------------------------------------------

fn emit_changed(app: &tauri::AppHandle) {
    let _ = app.emit("tasks://changed", ());
}

fn event(app: &tauri::AppHandle, task_id: &str, agent_id: &str, kind: &str, summary: &str, data: &str) -> Option<TaskEvent> {
    let state = app.try_state::<crate::AppState>()?;
    let e = state.ledger.add_task_event(task_id, agent_id, kind, summary, data);
    let _ = app.emit("tasks://event", &e);
    Some(e)
}

fn engine(app: &tauri::AppHandle) -> Option<tauri::State<'_, crate::AppState>> {
    app.try_state::<crate::AppState>()
}

// ---- Rounds of work: what needs a review ------------------------------------------

/// A task starts a round of work: note when, and what its folder looks like.
fn start_round(app: &tauri::AppHandle, task_id: &str, cwd: &str, ready: bool) {
    let Some(state) = engine(app) else { return };
    let before = Arc::new(OnceLock::new());
    let round = Round { started: crate::ledger::now_ms(), before: before.clone(), ready };
    state.tasks.rounds.lock().unwrap().insert(task_id.to_string(), round);
    let cwd = cwd.to_string();
    std::thread::spawn(move || {
        let _ = before.set(snapshot(&cwd));
    });
}

/// Whether a file event was for a file in the task's folder (its path is shown relative to it).
fn in_task_folder(data: &str) -> bool {
    let path = serde_json::from_str::<serde_json::Value>(data).ok().and_then(|v| v.get("path").and_then(|p| p.as_str()).map(str::to_string)).unwrap_or_default();
    !path.is_empty() && !path.starts_with('/') && !path.starts_with('~')
}

/// What a round changed that's worth a look: files the agent wrote in the task's folder,
/// the folder's commit or uncommitted changes, or work it delegated that changed something.
fn round_outcome(wrote: bool, delegated: bool, before: Option<&Option<String>>, after: Option<String>) -> bool {
    let moved = matches!((before, after), (Some(Some(before)), Some(after)) if *before != after);
    wrote || delegated || moved
}

/// Whether a task's round, now over, left anything to review. Talking alone doesn't.
fn round_changed(app: &tauri::AppHandle, task: &Task) -> bool {
    let Some(state) = engine(app) else { return true };
    let Some(round) = state.tasks.rounds.lock().unwrap().remove(&task.id) else {
        // Without a record of the round (Starkline restarted while it ran), assume there's something to see.
        return true;
    };
    if round.ready {
        return true;
    }
    let wrote = state.ledger.task_events(&task.id, 1000).iter().any(|e| e.ts >= round.started && e.kind == "file" && in_task_folder(&e.data));
    let delegated = state.ledger.child_tasks(&task.id).iter().any(|c| c.status == "done" && c.updated >= round.started);
    round_outcome(wrote, delegated, round.before.get(), snapshot(&task.cwd))
}

/// A task's round ended: changes wait for review; a round that only talked leaves it idle.
fn finish_round(app: &tauri::AppHandle, task: &Task, agent_id: &str) {
    let Some(state) = engine(app) else { return };
    if round_changed(app, task) {
        state.ledger.set_task_status(&task.id, "done", None);
        event(app, &task.id, agent_id, "status", "Ready for review", "");
        crate::notify::task_ready(app, task);
    } else {
        // What it answered, for the board to show.
        let answer = last_reply(app, task).map(|reply| crate::chat::truncate(&reply, 200));
        state.ledger.set_task_status(&task.id, "idle", answer.as_deref());
        event(app, &task.id, agent_id, "status", "Finished, with nothing to review", "");
    }
    settled(app, &task.id);
    emit_changed(app);
}

/// Who asked, as the UI names them: "You" for the developer, the automation's
/// name for a scheduled run, else the agent's name.
pub fn requester_name(app: &tauri::AppHandle, from: &str) -> String {
    if from == BY_DEVELOPER {
        return "You".into();
    }
    crate::automations::name_of(app, from).unwrap_or_else(|| crate::prompts::agent_name(app, from))
}

/// A task stopped for good (finished, blocked or closed): an automation's run gets its result.
fn settled(app: &tauri::AppHandle, task_id: &str) {
    crate::claims::end_task_tree(app, task_id);
    crate::automations::task_settled(app, task_id);
}

/// The task a chat is working on, if any.
pub fn current_in(app: &tauri::AppHandle, conversation: i64) -> Option<String> {
    engine(app)?.tasks.current.lock().unwrap().get(&conversation).cloned()
}

/// Whether a chat is busy: its session working (or waiting on you), or its task still running.
pub(crate) fn is_busy_in(app: &tauri::AppHandle, conversation: i64) -> bool {
    let Some(state) = engine(app) else { return false };
    let on_task = current_in(app, conversation).and_then(|id| state.ledger.task(&id)).is_some_and(|t| t.status == "doing");
    crate::runs::busy_in(app, conversation) || on_task
}

/// The task someone is acting for: their chat's, a delegated task's own conversation's, else
/// whatever the agent is on (for a bridge script that didn't say which chat it was).
pub fn task_of(app: &tauri::AppHandle, who: &Actor) -> Option<String> {
    let state = engine(app)?;
    if let Some(c) = who.conversation {
        if let Some(id) = current_in(app, c) {
            return Some(id);
        }
        if let Some(task) = state.ledger.task_for_conversation(c).filter(|t| t.status == "doing") {
            return Some(task.id);
        }
    }
    active_task_for(app, &who.agent)
}

/// After a quit or crash: work that was running stopped with Starkline, and work
/// that was still waiting to start (from before agents could work in several chats) starts now.
pub fn recover(app: &tauri::AppHandle) {
    let Some(state) = engine(app) else { return };
    let mut tasks = state.ledger.tasks(i64::from(u16::MAX));
    tasks.sort_by_key(|t| t.ts);
    let interrupted = "Starkline closed while this was running.";
    let mut waiting: Vec<Task> = Vec::new();
    for task in tasks {
        match task.status.as_str() {
            "doing" => {
                state.ledger.set_task_status(&task.id, "blocked", Some(interrupted));
                event(app, &task.id, &task.assignee, "status", interrupted, "");
                crate::notify::task_blocked(app, &task, interrupted);
                settled(app, &task.id);
            }
            "todo" => waiting.push(task),
            _ => {}
        }
    }
    emit_changed(app);
    for task in waiting {
        let _ = begin(app, &task);
    }
}

/// Pick an interrupted task back up in its own conversation, where it left off.
pub fn resume(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = engine(app).ok_or("Starkline isn't ready yet.")?;
    let task = state.ledger.task(id).ok_or("That task doesn't exist.")?;
    if !Path::new(&task.cwd).is_dir() { return Err("The task's workspace is no longer here. Restore the folder before continuing this task.".into()); }
    let conversation = task.conversation_id.ok_or("This task has no conversation to continue.")?;
    if task.parent_id.is_some() {
        return Err("A delegated task continues through the agent that delegated it.".into());
    }
    if is_busy_in(app, conversation) {
        let name = crate::prompts::agent_name(app, &task.assignee);
        return Err(format!("{name} is busy in this chat right now. Try again when they finish."));
    }
    let request = "Please continue the task where you left off.";
    developer_message(app, &task.assignee, conversation, request, &task.cwd);
    crate::chat::send_user_turn(app, &task.assignee, conversation, request, &[], &task.cwd)?;
    Ok(())
}

/// Who asked for a task, and what it's called.
pub struct Origin<'a> {
    /// "you", or an automation (see `automations::requester`).
    pub requested_by: &'a str,
    /// The task's title; by default the first line of the request.
    pub title: Option<&'a str>,
    /// The first line of its history ("You asked for this").
    pub note: &'a str,
}

/// The developer hands work to an agent, with any files they attached. It starts now: in the
/// agent's chat in that project, or in a new chat beside it while that one is busy.
pub fn start(app: &tauri::AppHandle, agent_id: &str, prompt: &str, dir: Option<String>, files: &[crate::attachments::Attachment]) -> Result<Task, String> {
    start_for(app, agent_id, prompt, dir, files, &Origin { requested_by: BY_DEVELOPER, title: None, note: "You asked for this" })
}

/// Work for an agent, asked for by the developer (with any files they attached) or one of their automations.
pub fn start_for(
    app: &tauri::AppHandle,
    agent_id: &str,
    prompt: &str,
    dir: Option<String>,
    files: &[crate::attachments::Attachment],
    origin: &Origin,
) -> Result<Task, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Say what you'd like done.".into());
    }
    let state = engine(app).ok_or("Starkline isn't ready yet.")?;
    let known = state.config.lock().unwrap().agents.iter().any(|a| a.id == agent_id && a.enabled);
    if !known {
        return Err("That agent isn't on the roster.".into());
    }
    let cwd = dir
        .filter(|d| !d.trim().is_empty())
        .or_else(|| state.workdirs.lock().unwrap().get(agent_id).cloned())
        .unwrap_or_else(|| state.project.lock().unwrap().clone());
    let id = crate::chat::next_task_id();
    let title = origin.title.map(title_from).unwrap_or_else(|| title_from(prompt));
    let task = state
        .ledger
        .create_task(&NewTask {
            id: &id,
            title: &title,
            assignee: agent_id,
            status: "todo",
            cwd: &cwd,
            parent_id: None,
            requested_by: origin.requested_by,
            prompt,
        })
        .ok_or("The task couldn't be saved.")?;
    // Kept with the task, so it starts with them even if it waits its turn.
    if !files.is_empty() {
        state.ledger.set_task_attachments(&id, files);
    }
    event(app, &id, agent_id, "created", origin.note, "");
    begin(app, &task)?;
    Ok(state.ledger.task(&id).unwrap_or(task))
}

/// Start a task in the developer's chat with the agent in that project, so a chat keeps
/// its session until the developer starts a new one. While that chat is busy (or there's
/// none yet) the task opens a chat of its own, so the agent works on both at once.
fn begin(app: &tauri::AppHandle, task: &Task) -> Result<(), String> {
    let state = engine(app).ok_or("Starkline isn't ready yet.")?;
    let prepared = crate::workspaces::prepare(app, task)?;
    let task = &prepared;
    let agent = task.assignee.as_str();
    let conversation = match state.ledger.chat_in(agent, &task.cwd).filter(|chat| !is_busy_in(app, *chat)) {
        Some(chat) => chat,
        None => state.ledger.new_titled_conversation(agent, &task.cwd, &task.title),
    };
    // "Talk to" the agent goes to the chat with its latest work.
    state.ledger.open_conversation(conversation);
    let branch = current_branch(&task.cwd).unwrap_or_default();
    state.ledger.begin_task(&task.id, Some(conversation), &branch);
    start_round(app, &task.id, &task.cwd, false);
    state.tasks.current.lock().unwrap().insert(conversation, task.id.clone());
    event(app, &task.id, agent, "started", "Started", "");
    let _ = app.emit("chat://switched", serde_json::json!({ "agentId": agent, "conversationId": conversation }));
    let _ = app.emit("conversations://changed", ());
    emit_changed(app);
    let files = state.ledger.task_attachments(&task.id);
    if let Err(e) = crate::chat::send_user_turn(app, agent, conversation, &task.prompt, &files, &task.cwd) {
        state.ledger.set_task_status(&task.id, "blocked", Some(&e));
        state.tasks.current.lock().unwrap().remove(&conversation);
        event(app, &task.id, agent, "status", &format!("Couldn't start: {e}"), "");
        crate::notify::task_blocked(app, task, &e);
        settled(app, &task.id);
        emit_changed(app);
        return Err(e);
    }
    Ok(())
}

/// The developer wrote in one of an agent's chats. If it has open work, that continues; otherwise
/// what they asked becomes a task, so every chat can be followed, reviewed and continued.
pub fn developer_message(app: &tauri::AppHandle, agent_id: &str, conversation: i64, text: &str, cwd: &str) {
    let Some(state) = engine(app) else { return };
    let Some(task) = state.ledger.task_for_conversation(conversation).or_else(|| chat_task(app, agent_id, conversation, text, "doing", cwd)) else {
        state.tasks.current.lock().unwrap().remove(&conversation);
        return;
    };
    state.tasks.current.lock().unwrap().insert(conversation, task.id.clone());
    if task.status != "doing" {
        // A chat's task made before anything was asked takes its title from the first request.
        if task.prompt.trim().is_empty() && !text.trim().is_empty() {
            state.ledger.set_task_request(&task.id, &title_from(text), text.trim());
        }
        state.ledger.set_task_status(&task.id, "doing", None);
        start_round(app, &task.id, &task.cwd, task.status == "done");
        let summary = if task.status == "idle" { "You asked for more, so it continues" } else { "You followed up, so it continues" };
        event(app, &task.id, agent_id, "status", summary, "");
        crate::notify::task_settled(app, &task.id, "You followed up");
        emit_changed(app);
    }
}

/// A task for a chat, in the chat's own folder (it doesn't move to a new worktree): running
/// what was just asked, or idle for a chat that hasn't asked for anything yet.
fn chat_task(app: &tauri::AppHandle, agent_id: &str, conversation: i64, text: &str, status: &str, cwd: &str) -> Option<Task> {
    let state = engine(app)?;
    let mut chat = state.ledger.conversation(conversation).filter(|c| !c.delegated)?;
    // Chats from before folders were recorded work where the message was sent from.
    if chat.cwd.is_empty() {
        chat.cwd = cwd.to_string();
        chat.project_folder = cwd.to_string();
    }
    let prompt = text.trim();
    let title = if prompt.is_empty() { chat.title.clone() } else { title_from(prompt) };
    let id = crate::chat::next_task_id();
    state.ledger.create_task(&NewTask { id: &id, title: &title, assignee: agent_id, status, cwd: &chat.cwd, parent_id: None, requested_by: BY_DEVELOPER, prompt })?;
    let kind = if chat.project_folder != chat.cwd { "worktree" } else { "checkout" };
    let _ = state.ledger.set_task_workspace(&id, &chat.cwd, kind, &chat.project_folder);
    let branch = current_branch(&chat.cwd).unwrap_or_default();
    if status == "doing" {
        state.ledger.begin_task(&id, Some(conversation), &branch);
        start_round(app, &id, &chat.cwd, false);
        event(app, &id, agent_id, "created", "You asked in a chat", "");
    } else {
        state.ledger.set_task_conversation(&id, conversation, &branch);
        event(app, &id, agent_id, "created", "Started as a chat", "");
    }
    emit_changed(app);
    state.ledger.task(&id)
}

/// The task a chat shows as: its latest work, or one made now for a chat that hasn't had any.
pub fn for_chat(app: &tauri::AppHandle, conversation: i64) -> Result<Task, String> {
    let state = engine(app).ok_or("Starkline isn't ready yet.")?;
    if let Some(task) = state.ledger.latest_task_in(conversation) {
        return Ok(task);
    }
    let chat = state.ledger.conversation(conversation).ok_or("That chat isn't here any more.")?;
    let folder = state.project.lock().unwrap().clone();
    chat_task(app, &chat.agent_id, conversation, "", "idle", &folder).ok_or_else(|| "The chat couldn't be opened as a task.".into())
}

/// The owner's turn in a chat ended. Its task is ready for review unless delegated work is still running.
pub fn turn_ended(app: &tauri::AppHandle, agent_id: &str, conversation: i64) {
    let Some(state) = engine(app) else { return };
    if let Some(task) = current_in(app, conversation).and_then(|id| state.ledger.task(&id)) {
        if task.status == "doing" {
            let waiting = state.ledger.child_tasks(&task.id).iter().filter(|c| matches!(c.status.as_str(), "doing" | "todo")).count();
            if waiting == 0 {
                finish_round(app, &task, agent_id);
            }
        }
    }
}

/// Why an agent's session stopped mid-task.
pub enum Ended {
    /// The developer stopped it, started a new chat or opened another.
    ByYou,
    /// It exited on its own (crash, expired session, provider error).
    Unexpectedly,
}

/// A chat's session went away. A task still running there is blocked, with the reason.
pub fn session_ended(app: &tauri::AppHandle, agent_id: &str, conversation: i64, why: Ended) {
    let Some(state) = engine(app) else { return };
    let current = state.tasks.current.lock().unwrap().remove(&conversation);
    // Its claims go with its task; the agent's own (taken outside any task) once nothing else of theirs runs.
    crate::claims::ended(app, agent_id, current.as_deref());
    if crate::runs::of_agent(app, agent_id).iter().all(|(c, _)| *c == conversation) {
        crate::claims::ended(app, agent_id, None);
    }
    if let Some(task) = current.and_then(|id| state.ledger.task(&id)) {
        if task.status == "doing" {
            let reason = match why {
                Ended::ByYou => "You stopped the session before the task finished.",
                Ended::Unexpectedly => "The session ended before the task finished.",
            };
            state.ledger.set_task_status(&task.id, "blocked", Some(reason));
            event(app, &task.id, agent_id, "status", reason, "");
            if matches!(why, Ended::Unexpectedly) {
                crate::notify::task_blocked(app, &task, reason);
            }
            settled(app, &task.id);
            emit_changed(app);
        }
    }
}

/// The developer reviewed a finished task: it leaves the board and stays in history as reviewed.
pub fn review(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = engine(app).ok_or("Starkline isn't ready yet.")?;
    let task = state.ledger.task(id).ok_or("That task doesn't exist.")?;
    if task.status != "done" {
        return Err("Only a task that's ready for review can be marked reviewed.".into());
    }
    state.ledger.set_task_status(id, "reviewed", None);
    event(app, id, &task.assignee, "status", "Reviewed by you", "");
    crate::notify::task_settled(app, id, "Reviewed");
    settled(app, id);
    emit_changed(app);
    Ok(())
}

/// The developer closes a task: it leaves the board and stays in history.
pub fn close(app: &tauri::AppHandle, id: &str) {
    let Some(state) = engine(app) else { return };
    let Some(task) = state.ledger.task(id) else { return };
    state.ledger.set_task_status(id, "closed", None);
    state.tasks.current.lock().unwrap().retain(|_, t| t != id);
    event(app, id, &task.assignee, "status", "Closed by you", "");
    crate::notify::task_settled(app, id, "Closed");
    settled(app, id);
    emit_changed(app);
}

/// A task ran past its time limit: its owner's session stops, and the task is
/// blocked with the reason.
pub fn time_out(app: &tauri::AppHandle, id: &str, minutes: i64) {
    let Some(state) = engine(app) else { return };
    let Some(task) = state.ledger.task(id).filter(|t| t.status == "doing") else { return };
    let reason = format!("It ran past its {minutes}-minute limit, so Starkline stopped it.");
    state.ledger.set_task_status(id, "blocked", Some(&reason));
    let running_in = task.conversation_id.filter(|c| {
        let mut current = state.tasks.current.lock().unwrap();
        let mine = current.get(c).is_some_and(|t| t == id);
        if mine {
            current.remove(c);
        }
        mine
    });
    if let Some(c) = running_in {
        crate::chat::stop(app, c);
    }
    event(app, id, &task.assignee, "status", &reason, "");
    crate::notify::task_blocked(app, &task, &reason);
    settled(app, id);
    emit_changed(app);
}

/// A delegation becomes a child of the delegating chat's task, with its own conversation.
pub fn begin_child(app: &tauri::AppHandle, by: &Actor, worker: &str, prompt: &str, cwd: &str) -> Option<(Task, i64)> {
    let state = engine(app)?;
    let from = by.agent.as_str();
    let parent = match by.conversation {
        Some(c) => current_in(app, c),
        None => active_task_for(app, from),
    };
    // The work this comes from, for its auto mode: the parent task, else whatever the delegating agent is on.
    let source = parent.clone().or_else(|| task_of(app, by));
    let inherited = parent.as_deref().and_then(|id| state.ledger.task(id)).map(|t| t.cwd);
    let cwd = inherited.as_deref().unwrap_or(cwd);
    let id = crate::chat::next_task_id();
    let title = title_from(prompt);
    state.ledger.create_task(&NewTask {
        id: &id,
        title: &title,
        assignee: worker,
        status: "doing",
        cwd,
        parent_id: parent.as_deref(),
        requested_by: from,
        prompt,
    })?;
    let prepared = crate::workspaces::for_child(app, &id, parent.as_deref())?;
    let cwd = prepared.cwd.as_str();
    state.workdirs.lock().unwrap().insert(worker.into(), cwd.into());
    let conversation = state.ledger.create_conversation(worker, cwd, &title);
    crate::automode::inherit(app, from, source.as_deref(), conversation);
    state.ledger.begin_task(&id, Some(conversation), &current_branch(cwd).unwrap_or_default());
    start_round(app, &id, cwd, false);
    let worker_name = crate::prompts::agent_name(app, worker);
    let origin = if from == BY_DEVELOPER { "You asked for this".to_string() } else { format!("{} delegated this", requester_name(app, from)) };
    event(app, &id, from, "created", &origin, "");
    if let Some(parent) = &parent {
        event(app, parent, from, "delegated", &format!("Delegated \"{title}\" to {worker_name}"), &serde_json::json!({ "taskId": id }).to_string());
    }
    emit_changed(app);
    Some((state.ledger.task(&id)?, conversation))
}

/// A delegated task finished: done with its result, or blocked with the reason.
/// A delegated task's worker came back with `outcome`. Returns whether you'd stopped it, in which
/// case the task reads as stopped by you, whatever the worker managed before it ended.
pub fn end_child(app: &tauri::AppHandle, id: &str, worker: &str, outcome: &Result<String, String>) -> bool {
    let Some(state) = engine(app) else { return false };
    let stopped = state.tasks.stopped.lock().unwrap().remove(id);
    let changed = state.ledger.task(id).is_some_and(|task| round_changed(app, &task));
    let (status, detail, summary) = match outcome {
        _ if stopped => ("blocked", STOPPED_BY_YOU.to_string(), "Stopped by you".to_string()),
        Ok(result) if !result.trim().is_empty() && changed => ("done", crate::chat::truncate(result, 200), "Finished".to_string()),
        Ok(result) if !result.trim().is_empty() => ("idle", crate::chat::truncate(result, 200), "Finished, with nothing to review".to_string()),
        Ok(_) => ("blocked", "The agent finished without a result.".to_string(), "Stopped without a result".to_string()),
        Err(e) => ("blocked", crate::chat::truncate(e, 200), format!("Couldn't finish: {}", crate::chat::truncate(e, 80))),
    };
    state.ledger.set_task_status(id, status, Some(&detail));
    crate::claims::ended(app, worker, Some(id));
    event(app, id, worker, "status", &summary, "");
    emit_changed(app);
    stopped
}

// ---- Stopping a task --------------------------------------------------------------

/// Why a task you stopped is blocked, and what the agent that delegated it hears.
pub const STOPPED_BY_YOU: &str = "You stopped the task before it finished.";

/// A delegated task's one-shot worker is running, so stopping the task ends its process.
pub fn worker_started(app: &tauri::AppHandle, task: &str, pid: u32) {
    if let Some(state) = engine(app) {
        state.tasks.workers.lock().unwrap().insert(task.into(), pid);
    }
}

pub fn worker_finished(app: &tauri::AppHandle, task: &str) {
    if let Some(state) = engine(app) {
        state.tasks.workers.lock().unwrap().remove(task);
    }
}

/// One running part of a task being stopped, and how it's stopped.
#[derive(Debug, PartialEq, Eq)]
enum Halt {
    /// Delegated work on a one-shot worker: its process ends.
    Worker { task: String, pid: u32 },
    /// Its chat's session is on it: the session ends, and the task is blocked.
    Session { agent: String, conversation: i64 },
    /// Marked running with nothing running it (Starkline restarted, say): only the record changes.
    Mark { task: String },
}

/// What stopping `tree` (a task and everything delegated beneath it) takes: only parts still running count.
fn halts(tree: &[Task], worker_of: impl Fn(&str) -> Option<u32>, session_task_of: impl Fn(i64) -> Option<String>) -> Vec<Halt> {
    tree.iter()
        .filter(|t| t.status == "doing")
        .map(|t| {
            let chat = t.conversation_id.filter(|c| session_task_of(*c).as_deref() == Some(t.id.as_str()));
            if let Some(pid) = worker_of(&t.id) {
                Halt::Worker { task: t.id.clone(), pid }
            } else if let Some(conversation) = chat {
                Halt::Session { agent: t.assignee.clone(), conversation }
            } else {
                Halt::Mark { task: t.id.clone() }
            }
        })
        .collect()
}

/// Stop a task and everything still running beneath it: the owner's session if it's on the task,
/// and the workers doing the work it delegated. Each part that stops is blocked, saying you stopped it.
pub fn stop(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    let state = engine(app).ok_or("Starkline isn't ready yet.")?;
    let root = state.ledger.task(id).ok_or("That task doesn't exist.")?;
    let mut tree = Vec::new();
    let mut pending = vec![root];
    while let Some(task) = pending.pop() {
        pending.extend(state.ledger.child_tasks(&task.id));
        tree.push(task);
    }
    let workers = state.tasks.workers.lock().unwrap().clone();
    let plan = halts(&tree, |task| workers.get(task).copied(), |c| current_in(app, c));
    if plan.is_empty() {
        return Err("Nothing in this task is running.".into());
    }
    for halt in plan {
        match halt {
            Halt::Worker { task, pid } => {
                // Only while that worker still runs it. It reports back once its process ends, and its end reads as your stop.
                let workers = state.tasks.workers.lock().unwrap();
                if workers.get(&task) == Some(&pid) {
                    state.tasks.stopped.lock().unwrap().insert(task);
                    crate::proc::kill_tree(pid);
                }
            }
            Halt::Session { agent, conversation } => {
                session_ended(app, &agent, conversation, Ended::ByYou);
                crate::chat::stop(app, conversation);
            }
            Halt::Mark { task } => {
                state.ledger.set_task_status(&task, "blocked", Some(STOPPED_BY_YOU));
                if let Some(t) = state.ledger.task(&task) {
                    event(app, &task, &t.assignee, "status", "Stopped by you", "");
                }
                settled(app, &task);
            }
        }
    }
    emit_changed(app);
    Ok(())
}

/// Something the owner's provider is about to do, as it bears on the task.
pub fn tool_use(app: &tauri::AppHandle, who: &Actor, task_id: Option<&str>, tool_use_id: &str, name: &str, input: &serde_json::Value) {
    let agent_id = who.agent.as_str();
    let Some(task_id) = task_id else { return };
    let Some(state) = engine(app) else { return };
    let cwd = state.ledger.task(task_id).map(|t| t.cwd).unwrap_or_default();
    let text = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            let path = [text("file_path"), text("notebook_path")].into_iter().find(|p| !p.is_empty()).unwrap_or_default();
            if crate::prompts::is_memory_file(app, Path::new(&path)) {
                return;
            }
            if crate::prompts::agent_engine(app, agent_id).kind == "codex" { crate::claims::after_edit(app, who, name, input); }
            let shown = relative(&path, &cwd);
            let verb = if name == "Write" { "Wrote" } else { "Edited" };
            event(app, task_id, agent_id, "file", &format!("{verb} {shown}"), &serde_json::json!({ "path": shown, "action": verb.to_lowercase() }).to_string());
        }
        "Bash" => {
            let command = text("command");
            event(app, task_id, agent_id, "command", &format!("Ran {}", crate::chat::truncate(&command, 120)), &serde_json::json!({ "command": command }).to_string());
            if let Some(kind) = check_kind(&command) {
                state.tasks.checks.lock().unwrap().insert(
                    tool_use_id.to_string(),
                    PendingCheck { task_id: task_id.into(), agent_id: agent_id.into(), command, kind, started: Instant::now() },
                );
            }
        }
        "TodoWrite" => {
            if let Some(plan) = plan_from(input) {
                let done = plan.iter().filter(|p| p.status == "completed").count();
                state.ledger.set_task_plan(task_id, done as i64, plan.len() as i64);
                let data = serde_json::to_string(&plan).unwrap_or_default();
                event(app, task_id, agent_id, "plan", &format!("Plan: {done} of {} steps done", plan.len()), &data);
                emit_changed(app);
            }
        }
        "Task" | "Agent" => {
            let description = text("description");
            let kind = text("subagent_type");
            event(app, task_id, agent_id, "helper", &format!("Started a helper: {description}"), &serde_json::json!({ "description": description, "type": kind }).to_string());
        }
        _ => {}
    }
}

/// The task an agent is working on right now, when which chat isn't known: the one it's open
/// in, else one of its chats' running tasks, else a delegated task it is running.
pub fn active_task_for(app: &tauri::AppHandle, agent_id: &str) -> Option<String> {
    let state = engine(app)?;
    let running = |id: &String| state.ledger.task(id).is_some_and(|t| t.status == "doing");
    if let Some(id) = state.ledger.current_conversation(agent_id).and_then(|c| current_in(app, c)).filter(running) {
        return Some(id);
    }
    let mine: Vec<i64> = crate::runs::of_agent(app, agent_id).into_iter().map(|(c, _)| c).collect();
    if let Some(id) = mine.into_iter().filter_map(|c| current_in(app, c)).find(running) {
        return Some(id);
    }
    state
        .ledger
        .tasks(EVENT_LIMIT)
        .into_iter()
        .find(|t| t.assignee == agent_id && t.status == "doing")
        .map(|t| t.id)
}

/// The developer was asked something (an approval, a question, a review) and
/// answered: both go into the task's history.
pub fn decision(app: &tauri::AppHandle, who: &Actor, asked: &str, answer: &str, approved: Option<bool>) {
    let agent_id = who.agent.as_str();
    let Some(task_id) = task_of(app, who) else { return };
    let summary = match approved {
        Some(true) => format!("You allowed: {asked}"),
        Some(false) => format!("You denied: {asked}"),
        None => format!("You answered \"{}\": {}", crate::chat::truncate(asked, 60), crate::chat::truncate(answer, 80)),
    };
    let data = serde_json::json!({ "asked": asked, "answer": answer, "approved": approved }).to_string();
    event(app, &task_id, agent_id, "approval", &summary, &data);
}

/// A tool call came back. A check's result becomes part of the task's verification.
pub fn tool_result(app: &tauri::AppHandle, tool_use_id: &str, is_error: bool) {
    let Some(state) = engine(app) else { return };
    let Some(check) = state.tasks.checks.lock().unwrap().remove(tool_use_id) else { return };
    let outcome = if is_error { "failed" } else { "passed" };
    let duration = check.started.elapsed().as_millis() as i64;
    if is_error {
        if let Some(task) = state.ledger.task(&check.task_id) {
            crate::notify::check_failed(app, &check.agent_id, &task, check.kind.label(), &check.command);
        }
    }
    event(
        app,
        &check.task_id,
        &check.agent_id,
        "verification",
        &format!("{} {outcome}", check.kind.label()),
        &serde_json::json!({ "kind": check.kind.label(), "command": check.command, "passed": !is_error, "durationMs": duration }).to_string(),
    );
}

// ---- Reading a task ----------------------------------------------------------

/// What the owner last said in a task's conversation, as plain text.
pub fn last_reply(app: &tauri::AppHandle, task: &Task) -> Option<String> {
    let state = engine(app)?;
    let conversation = task.conversation_id?;
    state
        .ledger
        .conversation_messages(conversation, MESSAGE_LIMIT)
        .into_iter()
        .rev()
        .find(|m| m.role == "agent" && m.text.as_deref().is_some_and(|t| !t.trim().is_empty()))
        .and_then(|m| m.text)
        .map(|text| crate::notify::plain(&text))
}

/// The latest result of each distinct check.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct CheckRun {
    pub kind: String,
    pub command: String,
    pub passed: bool,
    pub at: i64,
    pub duration_ms: Option<i64>,
    pub agent_id: String,
}

/// Everything the task screen shows.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TaskDetail {
    pub task: Task,
    /// The task this was delegated from, so a delegated task's page leads back to it.
    pub parent: Option<Task>,
    /// The other tasks delegated from the same parent, oldest first (none for a task nobody delegated).
    pub siblings: Vec<Task>,
    pub children: Vec<Task>,
    pub events: Vec<TaskEvent>,
    pub plan: Vec<PlanItem>,
    pub checks: Vec<CheckRun>,
    /// Uncommitted changes in the task's folder right now.
    pub changes: Vec<FileChange>,
    /// The branch checked out in the task's folder right now.
    pub branch: Option<String>,
    /// The task's part of its owner's chat.
    pub messages: Vec<StoredMessage>,
    pub workspace: crate::workspaces::WorkspaceInfo,
    pub claims: Vec<crate::claims::FileClaim>,
}

fn latest_checks(events: &[TaskEvent]) -> Vec<CheckRun> {
    let mut by_command: Vec<CheckRun> = Vec::new();
    for e in events.iter().filter(|e| e.kind == "verification") {
        let Ok(data) = serde_json::from_str::<serde_json::Value>(&e.data) else { continue };
        let run = CheckRun {
            kind: data.get("kind").and_then(|v| v.as_str()).unwrap_or("Check").into(),
            command: data.get("command").and_then(|v| v.as_str()).unwrap_or("").into(),
            passed: data.get("passed").and_then(|v| v.as_bool()).unwrap_or(false),
            at: e.ts,
            duration_ms: data.get("durationMs").and_then(|v| v.as_i64()),
            agent_id: e.agent_id.clone(),
        };
        by_command.retain(|r| r.command != run.command);
        by_command.push(run);
    }
    by_command
}

pub fn detail(app: &tauri::AppHandle, id: &str) -> Option<TaskDetail> {
    let state = engine(app)?;
    let task = state.ledger.task(id)?;
    let children = state.ledger.child_tasks(id);
    let mut events = state.ledger.task_events(id, EVENT_LIMIT);
    for child in &children {
        events.extend(state.ledger.task_events(&child.id, EVENT_LIMIT).into_iter().filter(|e| matches!(e.kind.as_str(), "claim_refused" | "claim_overlap")));
    }
    events.sort_by_key(|e| e.ts);
    let plan = events
        .iter()
        .rev()
        .find(|e| e.kind == "plan")
        .and_then(|e| serde_json::from_str::<Vec<PlanItem>>(&e.data).ok())
        .unwrap_or_default();
    let checks = latest_checks(&events);
    let messages = state.ledger.task_messages(&task, MESSAGE_LIMIT);
    let claims = state.claims.lock().unwrap().list(&task.cwd);
    let parent = task.parent_id.as_deref().and_then(|id| state.ledger.task(id));
    let siblings = parent
        .as_ref()
        .map(|p| state.ledger.child_tasks(&p.id).into_iter().filter(|t| t.id != task.id).collect())
        .unwrap_or_default();
    Some(TaskDetail {
        workspace: crate::workspaces::info(&state.ledger, &task),
        claims,
        changes: changes(&task.cwd),
        branch: current_branch(&task.cwd),
        task,
        parent,
        siblings,
        children,
        events,
        plan,
        checks,
        messages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(id: &str, assignee: &str, status: &str) -> Task {
        Task {
            id: id.into(),
            ts: 0,
            updated: 0,
            title: id.into(),
            assignee: assignee.into(),
            status: status.into(),
            detail: None,
            cwd: "/work".into(),
            conversation_id: None,
            parent_id: None,
            requested_by: "you".into(),
            prompt: String::new(),
            branch: String::new(),
            request_url: None,
            request_host: None,
            request_number: None,
            started: None,
            finished: None,
            plan_done: None,
            plan_total: None,
            workspace_kind: "checkout".into(),
            project_folder: "/work".into(),
        }
    }

    fn in_chat(mut t: Task, conversation: i64) -> Task {
        t.conversation_id = Some(conversation);
        t
    }

    #[test]
    fn stopping_ends_each_running_part_its_own_way() {
        let tree = [in_chat(task("owner", "jarvis", "doing"), 7), task("worker", "friday", "doing"), task("finished", "karen", "done"), task("stale", "vision", "doing")];
        let workers = |id: &str| (id == "worker").then_some(42);
        let sessions = |conversation: i64| (conversation == 7).then(|| "owner".to_string());
        assert_eq!(
            halts(&tree, workers, sessions),
            [Halt::Session { agent: "jarvis".into(), conversation: 7 }, Halt::Worker { task: "worker".into(), pid: 42 }, Halt::Mark { task: "stale".into() }]
        );
    }

    #[test]
    fn stopping_leaves_an_agent_alone_once_they_have_moved_on() {
        // That chat's session is on newer work now: stopping the old task mustn't end it.
        assert_eq!(halts(&[in_chat(task("old", "jarvis", "doing"), 7)], |_| None, |_| Some("newer".into())), [Halt::Mark { task: "old".into() }]);
        assert!(halts(&[in_chat(task("over", "jarvis", "done"), 7)], |_| None, |_| Some("over".into())).is_empty());
    }

    #[test]
    fn stopping_one_chat_leaves_the_agents_other_chats_running() {
        // JARVIS works in chats 7 and 9 at once; stopping the task in 9 ends only that session.
        let sessions = |conversation: i64| match conversation {
            7 => Some("bi".to_string()),
            9 => Some("sfa".to_string()),
            _ => None,
        };
        assert_eq!(halts(&[in_chat(task("sfa", "jarvis", "doing"), 9)], |_| None, sessions), [Halt::Session { agent: "jarvis".into(), conversation: 9 }]);
    }

    #[test]
    fn only_a_round_that_changed_something_needs_a_review() {
        let repo = Some(Some("abc\n\n1".to_string()));
        let same = Some("abc\n\n1".to_string());
        let moved = Some("def\n\n1".to_string());
        assert!(!round_outcome(false, false, repo.as_ref(), same.clone()), "it only talked");
        assert!(round_outcome(false, false, repo.as_ref(), moved), "a commit or an edit by a command");
        assert!(round_outcome(true, false, repo.as_ref(), same.clone()), "it wrote a file");
        assert!(round_outcome(false, true, repo.as_ref(), same), "work it delegated changed something");
        assert!(!round_outcome(false, false, Some(&None), None), "outside a repository, only its own edits count");
        assert!(round_outcome(true, false, Some(&None), None));
        assert!(!round_outcome(false, false, None, Some("x".into())), "the snapshot wasn't taken in time");
    }

    #[test]
    fn edits_count_inside_the_task_folder_only() {
        assert!(in_task_folder(r#"{"path":"src/App.tsx","action":"edited"}"#));
        assert!(!in_task_folder(r#"{"path":"/tmp/scratch.md","action":"wrote"}"#));
        assert!(!in_task_folder(r#"{"path":"~/notes.md","action":"wrote"}"#));
        assert!(!in_task_folder(""));
    }

    #[test]
    fn a_snapshot_sees_edits_new_files_and_commits() {
        let dir = std::env::temp_dir().join(format!("starkline-round-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        let run = |args: &[&str]| {
            let ok = Command::new("git").arg("-C").arg(&dir).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status().unwrap().success();
            assert!(ok, "git {args:?}");
        };
        assert_eq!(snapshot(&cwd), None, "not a repository yet");
        run(&["init", "-q"]);
        run(&["config", "user.email", "dev@example.com"]);
        run(&["config", "user.name", "Dev"]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "first"]);
        let clean = snapshot(&cwd).expect("a repository");
        assert_eq!(snapshot(&cwd).as_ref(), Some(&clean), "nothing changed");

        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        let edited = snapshot(&cwd).unwrap();
        assert_ne!(edited, clean);
        std::fs::write(dir.join("a.txt"), "three\n").unwrap();
        assert_ne!(snapshot(&cwd).unwrap(), edited, "a file that was already changed changes again");
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        assert_eq!(snapshot(&cwd).unwrap(), clean, "put back as it was");

        std::fs::write(dir.join("b.txt"), "new\n").unwrap();
        assert_ne!(snapshot(&cwd).unwrap(), clean, "a new file");
        run(&["add", "."]);
        run(&["commit", "-qm", "second"]);
        let committed = snapshot(&cwd).unwrap();
        assert_ne!(committed, clean, "a commit");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn titles_come_from_the_first_line() {
        assert_eq!(title_from("\n  Fix the login bug\nIt fails on Safari"), "Fix the login bug");
        assert_eq!(title_from("   "), "Untitled task");
        assert_eq!(title_from("OBJECTIVE\nMerge production into the Expo branch."), "Merge production into the Expo branch.");
        assert_eq!(title_from("## Goal\n\nShip the refunds feature"), "Ship the refunds feature");
        assert_eq!(title_from("Task: Fix the login page"), "Fix the login page");
        assert_eq!(title_from("CONTEXT:\nThe app crashes on launch"), "The app crashes on launch");
        assert_eq!(title_from("Standup at 10:30, then https://example.com"), "Standup at 10:30, then https://example.com");
        assert_eq!(title_from("Fix: the button overlaps"), "Fix: the button overlaps", "only known labels are dropped");
        assert_eq!(title_from("LGTM"), "LGTM", "a request that's only a heading keeps it");
        let long = "a".repeat(200);
        let title = title_from(&long);
        assert_eq!(title.chars().count(), TITLE_LIMIT);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn recognises_verification_commands() {
        let cases = [
            ("npm test", Some(CheckKind::Tests)),
            ("cargo test --manifest-path src-tauri/Cargo.toml", Some(CheckKind::Tests)),
            ("pnpm vitest run", Some(CheckKind::Tests)),
            ("pytest -q tests/", Some(CheckKind::Tests)),
            ("npx tsc --noEmit", Some(CheckKind::TypeCheck)),
            ("npm run typecheck", Some(CheckKind::TypeCheck)),
            ("cargo check", Some(CheckKind::TypeCheck)),
            ("npm run lint -- --max-warnings 0", Some(CheckKind::Lint)),
            ("cargo clippy", Some(CheckKind::Lint)),
            ("npm run build", Some(CheckKind::Build)),
            ("xcodebuild -scheme App", Some(CheckKind::Build)),
            ("npx playwright test", Some(CheckKind::EndToEnd)),
            ("npm run test:e2e", Some(CheckKind::EndToEnd)),
            ("git status", None),
            ("cat latest-tests.md", None),
            ("ls src/testing", None),
        ];
        for (command, expected) in cases {
            assert_eq!(check_kind(command), expected, "{command}");
        }
    }

    #[test]
    fn reads_the_owners_plan() {
        let input = serde_json::json!({ "todos": [
            { "content": "Read the code", "status": "completed", "activeForm": "Reading the code" },
            { "content": "Write tests", "status": "in_progress", "activeForm": "Writing tests" },
            { "content": "Ship", "status": "pending" },
        ]});
        let plan = plan_from(&input).unwrap();
        assert_eq!(plan.len(), 3);
        assert_eq!(plan[1], PlanItem { content: "Write tests".into(), status: "in_progress".into(), active: Some("Writing tests".into()) });
        assert!(plan_from(&serde_json::json!({})).is_none());
    }

    #[test]
    fn parses_git_status_and_line_counts() {
        let porcelain = " M src/App.tsx\0A  src/new.ts\0R  src/renamed.ts\0src/old.ts\0?? notes.md\0 D gone.txt\0";
        let changes = parse_porcelain(porcelain);
        let summary: Vec<(&str, &str)> = changes.iter().map(|c| (c.path.as_str(), c.status.as_str())).collect();
        assert_eq!(
            summary,
            vec![("src/App.tsx", "modified"), ("src/new.ts", "added"), ("src/renamed.ts", "renamed"), ("notes.md", "untracked"), ("gone.txt", "deleted")]
        );
        let counts = parse_numstat("12\t3\tsrc/App.tsx\n-\t-\tlogo.png\n4\t0\tsrc/{old.ts => renamed.ts}\n");
        assert_eq!(counts["src/App.tsx"], (Some(12), Some(3)));
        assert_eq!(counts["logo.png"], (None, None));
        assert!(counts.contains_key("renamed.ts") || counts.contains_key("src/renamed.ts"));
    }

    #[test]
    fn diffs_only_plain_paths_inside_the_folder() {
        assert!(safe_relative("src/App.tsx"));
        assert!(!safe_relative("../secrets.env"));
        assert!(!safe_relative("/etc/hosts"));
        assert!(!safe_relative(""));
        assert_eq!(relative("/w/app/src/a.ts", "/w/app"), "src/a.ts");
        assert_eq!(relative("/elsewhere/a.ts", "/w/app"), "/elsewhere/a.ts");
    }

    #[test]
    fn keeps_the_latest_run_of_each_check() {
        let event = |id: i64, command: &str, passed: bool| TaskEvent {
            id,
            task_id: "t".into(),
            ts: id,
            agent_id: "friday".into(),
            kind: "verification".into(),
            summary: String::new(),
            data: serde_json::json!({ "kind": "Tests", "command": command, "passed": passed }).to_string(),
        };
        let runs = latest_checks(&[event(1, "npm test", false), event(2, "npx tsc", true), event(3, "npm test", true)]);
        assert_eq!(runs.iter().map(|r| (r.command.as_str(), r.passed)).collect::<Vec<_>>(), vec![("npx tsc", true), ("npm test", true)]);
    }
}
