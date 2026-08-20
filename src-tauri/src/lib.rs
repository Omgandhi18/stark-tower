mod agents;
mod chat;
mod config;
mod engine;
mod ledger;
mod pty;

use agents::{Agent, AgentKind, AgentStatus};
use config::{AgentConfig, AppConfig, EngineConfig};
use ledger::{Ledger, LedgerEntry, StoredMessage};
use pty::PtyManager;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Shared application state, managed by Tauri.
pub struct AppState {
    pub pty: PtyManager,
    pub chat: chat::ChatManager,
    pub ledger: Ledger,
    pub roster: Mutex<Vec<Agent>>,
    /// The active/default project directory (used when a chat doesn't pick one).
    pub project: Mutex<String>,
    /// The managed set of project directories JARVIS can delegate across.
    pub projects: Mutex<Vec<String>>,
    /// Where the projects list is persisted.
    pub projects_file: String,
    /// Per-agent working directory (an assisting agent inherits the requester's).
    pub workdirs: Mutex<HashMap<String, String>>,
    /// Single source of truth for live agent status (driven by emit_status),
    /// so the periodic roster reconcile doesn't clobber chat/pty state.
    pub statuses: Mutex<HashMap<String, AgentStatus>>,
    /// Unix socket the Stark bridge MCP tools (delegate, ask_human) talk to.
    pub sock_path: String,
    /// Pending human-review requests (id → channel that unblocks the agent).
    pub reviews: Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>,
    /// The current batch of background delegations JARVIS is waiting on, so their
    /// results can be synthesized back to him in one follow-up when all finish.
    pub delegations: Mutex<chat::DelegationState>,
    /// User-editable engines + roster (names, personalities, sprites, models).
    /// The single source of truth; `roster` above is a derived cache.
    pub config: Mutex<AppConfig>,
    /// Where the config is persisted.
    pub config_file: String,
}

impl AppState {
    /// Rebuild the derived roster cache from the config (call after edits).
    fn sync_roster(&self) {
        let roster = self.config.lock().unwrap().roster();
        *self.roster.lock().unwrap() = roster;
    }
    /// Persist the config to disk.
    fn save_config(&self) {
        let cfg = self.config.lock().unwrap();
        config::save(std::path::Path::new(&self.config_file), &cfg);
    }
}

fn default_workdir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| ".".into())
}

/// Default project the tower opens in: ~/Documents (falling back to HOME).
fn default_project() -> String {
    let home = default_workdir();
    let docs = format!("{home}/Documents");
    if std::path::Path::new(&docs).is_dir() {
        docs
    } else {
        home
    }
}

#[derive(serde::Serialize)]
struct ProjectInfo {
    path: String,
    name: String,
}

#[derive(serde::Serialize)]
struct ProjectsState {
    projects: Vec<ProjectInfo>,
    active: String,
}

fn load_projects(file: &str) -> (Vec<String>, String) {
    if let Ok(txt) = std::fs::read_to_string(file) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            let projects: Vec<String> = v["projects"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if !projects.is_empty() {
                let active = v["active"].as_str().unwrap_or("").to_string();
                let active = if projects.contains(&active) {
                    active
                } else {
                    projects[0].clone()
                };
                return (projects, active);
            }
        }
    }
    let d = default_project();
    (vec![d.clone()], d)
}

fn save_projects(file: &str, projects: &[String], active: &str) {
    let v = serde_json::json!({ "projects": projects, "active": active });
    if let Ok(out) = serde_json::to_string_pretty(&v) {
        let tmp = format!("{file}.tmp");
        if std::fs::write(&tmp, out).is_ok() {
            let _ = std::fs::rename(&tmp, file);
        }
    }
}

fn projects_state(state: &AppState) -> ProjectsState {
    let projects = state.projects.lock().unwrap().clone();
    let active = state.project.lock().unwrap().clone();
    ProjectsState {
        projects: projects
            .iter()
            .map(|p| ProjectInfo {
                path: p.clone(),
                name: short_path(p),
            })
            .collect(),
        active,
    }
}

fn persist(state: &AppState) {
    let projects = state.projects.lock().unwrap().clone();
    let active = state.project.lock().unwrap().clone();
    save_projects(&state.projects_file, &projects, &active);
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

fn short_path(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| p.to_string())
}

fn current_project(state: &AppState) -> String {
    state.project.lock().unwrap().clone()
}

/// Mark `workdir` as trusted in ~/.claude.json so the spawned Claude Code skips
/// the interactive workspace-trust dialog (which otherwise blocks — or, in some
/// dirs like $HOME, crashes the CLI on our pty). Equivalent to the user clicking
/// "Yes, I trust this folder". Per-tool permission prompts still apply normally.
/// No-op if already trusted, the file is missing, or anything fails.
fn ensure_trusted(workdir: &str) {
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return,
    };
    let path = std::path::Path::new(&home).join(".claude.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return,
    };
    let mut v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };

    if !v.get("projects").map(|p| p.is_object()).unwrap_or(false) {
        v["projects"] = serde_json::json!({});
    }
    let already = v["projects"]
        .get(workdir)
        .and_then(|e| e.get("hasTrustDialogAccepted"))
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    if already {
        return;
    }
    // Create the project entry as an object only if it isn't one already
    // (preserve any existing fields).
    if !v["projects"]
        .get(workdir)
        .map(|e| e.is_object())
        .unwrap_or(false)
    {
        v["projects"][workdir] = serde_json::json!({});
    }
    v["projects"][workdir]["hasTrustDialogAccepted"] = serde_json::Value::Bool(true);

    // Atomic write: temp file + rename, so a concurrent claude never sees a
    // half-written config.
    if let Ok(out) = serde_json::to_string(&v) {
        let tmp = path.with_extension("json.starktmp");
        if std::fs::write(&tmp, out).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

fn status_map(state: &AppState) -> HashMap<String, AgentStatus> {
    state
        .pty
        .sessions
        .lock()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.status))
        .collect()
}

fn find_agent(state: &AppState, id: &str) -> Option<Agent> {
    state.roster.lock().unwrap().iter().find(|a| a.id == id).cloned()
}

/// Bring an agent online in `workdir` if it isn't already. Returns whether a new
/// session was spawned (so callers can delay prompt delivery until the CLI boots).
fn ensure_spawned(
    app: &tauri::AppHandle,
    state: &AppState,
    agent: &Agent,
    workdir: &str,
    cols: u16,
    rows: u16,
) -> Result<bool, String> {
    if state.pty.sessions.lock().unwrap().contains_key(&agent.id) {
        return Ok(false);
    }
    // Pre-trust the workspace so Claude Code doesn't block on (or crash at) the
    // trust dialog when launching in a not-yet-trusted project directory.
    ensure_trusted(workdir);
    let spec = engine::resolve_engine(&agent.engine);
    let cmd = engine::build_command(&spec, workdir);
    pty::spawn_session(app, &agent.id, cmd, cols.max(40), rows.max(12))?;
    state
        .workdirs
        .lock()
        .unwrap()
        .insert(agent.id.clone(), workdir.to_string());
    let e = state.ledger.record(
        &agent.id,
        "spawn",
        &format!("{} online · {}", agent.name, short_path(workdir)),
        1,
    );
    let _ = app.emit("ledger://entry", e);
    Ok(true)
}

/// Send a line of text to an agent's session, delaying if it was just spawned.
fn deliver(app: &tauri::AppHandle, agent_id: &str, line: String, just_spawned: bool) {
    if just_spawned {
        let app = app.clone();
        let id = agent_id.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(3500));
            let _ = pty::write_bytes(&app, &id, format!("{line}\r").as_bytes());
        });
    } else {
        let _ = pty::write_bytes(app, agent_id, format!("{line}\r").as_bytes());
    }
}

#[tauri::command]
fn list_agents(state: tauri::State<AppState>) -> Vec<Agent> {
    let mut roster = state.roster.lock().unwrap().clone();
    let statuses = state.statuses.lock().unwrap();
    for a in roster.iter_mut() {
        a.status = *statuses.get(&a.id).unwrap_or(&AgentStatus::Offline);
    }
    roster
}

/// Chat with an agent (headless Claude Code). Starts a session in `dir` (or the
/// agent's recorded workdir / current project) on first message.
#[tauri::command]
fn chat_send(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    agent_id: String,
    text: String,
    dir: Option<String>,
) -> Result<(), String> {
    let cwd = dir
        .filter(|d| !d.trim().is_empty())
        .map(|d| shellexpand_home(d.trim()))
        .unwrap_or_else(|| {
            state
                .workdirs
                .lock()
                .unwrap()
                .get(&agent_id)
                .cloned()
                .unwrap_or_else(|| current_project(&state))
        });
    state
        .workdirs
        .lock()
        .unwrap()
        .insert(agent_id.clone(), cwd.clone());

    let e = state
        .ledger
        .record(&agent_id, "chat", &truncate(&text, 80), 1);
    let _ = app.emit("ledger://entry", e);
    // Persist the user turn so the transcript can be rebuilt on reopen.
    state.ledger.add_message(&agent_id, "user", Some(&text), None, None);

    chat::send(&app, &agent_id, &text, &cwd, &state.sock_path)
}

/// The persisted transcript for an agent, oldest first (for rehydrating the UI).
#[tauri::command]
fn get_chat(state: tauri::State<AppState>, agent_id: String, limit: Option<i64>) -> Vec<StoredMessage> {
    state.ledger.messages(&agent_id, limit.unwrap_or(500))
}

#[derive(serde::Serialize)]
struct PathEntry {
    path: String,
    dir: bool,
}

/// List files AND folders under `dir` (relative paths, recursively into every
/// subfolder) for the chat's `@` picker. Respects .gitignore and skips heavy
/// noise dirs, so it mirrors what Claude Code would see.
#[tauri::command]
fn list_files(dir: String, limit: Option<usize>) -> Vec<PathEntry> {
    let root = shellexpand_home(dir.trim());
    if root.is_empty() || !std::path::Path::new(&root).is_dir() {
        return vec![];
    }
    let cap = limit.unwrap_or(50_000);
    let root_path = std::path::Path::new(&root);
    // Heavy/noise dirs to skip even when there's no .gitignore (e.g. ~/Documents).
    const SKIP: &[&str] = &[
        ".git", "node_modules", "target", "dist", "build", ".next", ".nuxt",
        ".svelte-kit", "out", ".turbo", ".cache", "vendor", ".venv", "venv",
        "__pycache__", ".mypy_cache", ".pytest_cache", ".gradle", ".idea",
        "Pods", "DerivedData", ".terraform",
    ];
    let mut out: Vec<PathEntry> = Vec::new();
    for entry in ignore::WalkBuilder::new(&root)
        .hidden(false) // show dotfiles; .gitignore still applies
        .git_ignore(true)
        .git_global(true)
        .filter_entry(|e| {
            e.file_name()
                .to_str()
                .map(|n| !SKIP.contains(&n))
                .unwrap_or(true)
        })
        .build()
        .flatten()
    {
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_dir && !is_file {
            continue; // skip symlinks-to-nowhere etc.
        }
        if let Ok(rel) = entry.path().strip_prefix(root_path) {
            let path = rel.to_string_lossy().to_string();
            if path.is_empty() {
                continue; // the root itself
            }
            out.push(PathEntry { path, dir: is_dir });
            if out.len() >= cap {
                break;
            }
        }
    }
    // Folders first, then files, each alphabetical — a natural tree order.
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.path.cmp(&b.path)));
    out
}

/// Reset button: end the live session AND wipe this agent's saved transcript +
/// resume pointer, so the next message starts a genuinely fresh conversation.
#[tauri::command]
fn chat_stop(app: tauri::AppHandle, state: tauri::State<AppState>, agent_id: String) {
    chat::stop(&app, &agent_id);
    state.ledger.clear_agent(&agent_id);
}

/// Deliver the human's decision back to a blocked `ask_human` review.
#[tauri::command]
fn review_respond(state: tauri::State<AppState>, id: String, decision: String) {
    if let Some(tx) = state.reviews.lock().unwrap().remove(&id) {
        let _ = tx.send(decision);
    }
}

// ---- configuration (engines + roster) --------------------------------------

/// Persist config, refresh the derived roster, and notify the UI.
fn commit_config(app: &tauri::AppHandle, state: &AppState) -> AppConfig {
    state.save_config();
    state.sync_roster();
    let cfg = state.config.lock().unwrap().clone();
    let _ = app.emit("config://changed", cfg.clone());
    cfg
}

#[tauri::command]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

/// Upsert an agent (edit an existing one by id, or add a new one).
#[tauri::command]
fn update_agent(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    agent: AgentConfig,
) -> AppConfig {
    {
        let mut cfg = state.config.lock().unwrap();
        match cfg.agents.iter_mut().find(|a| a.id == agent.id) {
            Some(existing) => *existing = agent,
            None => cfg.agents.push(agent),
        }
    }
    commit_config(&app, &state)
}

#[tauri::command]
fn remove_agent(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> AppConfig {
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.agents.retain(|a| a.id != id);
    }
    commit_config(&app, &state)
}

/// Upsert an engine (edit by id, or add a new backend).
#[tauri::command]
fn update_engine(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    engine: EngineConfig,
) -> AppConfig {
    {
        let mut cfg = state.config.lock().unwrap();
        match cfg.engines.iter_mut().find(|e| e.id == engine.id) {
            Some(existing) => *existing = engine,
            None => cfg.engines.push(engine),
        }
    }
    commit_config(&app, &state)
}

#[tauri::command]
fn remove_engine(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> AppConfig {
    {
        let mut cfg = state.config.lock().unwrap();
        // Never orphan agents: block removing an engine still in use.
        let in_use = cfg.agents.iter().any(|a| a.engine == id);
        if !in_use {
            cfg.engines.retain(|e| e.id != id);
        }
    }
    commit_config(&app, &state)
}

#[tauri::command]
fn set_onboarded(app: tauri::AppHandle, state: tauri::State<AppState>, value: bool) -> AppConfig {
    state.config.lock().unwrap().onboarded = value;
    commit_config(&app, &state)
}

/// Set the floor lighting mode ("auto" | "system" | morning/day/evening/night).
#[tauri::command]
fn set_lighting(app: tauri::AppHandle, state: tauri::State<AppState>, mode: String) -> AppConfig {
    state.config.lock().unwrap().lighting = mode;
    commit_config(&app, &state)
}

/// Restore the built-in engines + roster (wipes customizations).
#[tauri::command]
fn reset_config(app: tauri::AppHandle, state: tauri::State<AppState>) -> AppConfig {
    *state.config.lock().unwrap() = config::default_config();
    commit_config(&app, &state)
}

#[tauri::command]
fn get_ledger(state: tauri::State<AppState>, limit: Option<i64>) -> Vec<LedgerEntry> {
    state.ledger.recent(limit.unwrap_or(60))
}

#[tauri::command]
fn get_project(state: tauri::State<AppState>) -> String {
    current_project(&state)
}

#[tauri::command]
fn list_projects(state: tauri::State<AppState>) -> ProjectsState {
    projects_state(&state)
}

/// Set the active/default project (adds it to the managed list if new).
#[tauri::command]
fn set_project(state: tauri::State<AppState>, path: String) -> Result<ProjectsState, String> {
    let p = if path.trim().is_empty() {
        default_project()
    } else {
        shellexpand_home(path.trim())
    };
    if !std::path::Path::new(&p).is_dir() {
        return Err(format!("Not a directory: {p}"));
    }
    {
        let mut list = state.projects.lock().unwrap();
        if !list.contains(&p) {
            list.push(p.clone());
        }
    }
    *state.project.lock().unwrap() = p.clone();
    persist(&state);
    Ok(projects_state(&state))
}

#[tauri::command]
fn add_project(state: tauri::State<AppState>, path: String) -> Result<ProjectsState, String> {
    let p = shellexpand_home(path.trim());
    if p.is_empty() || !std::path::Path::new(&p).is_dir() {
        return Err(format!("Not a directory: {p}"));
    }
    {
        let mut list = state.projects.lock().unwrap();
        if !list.contains(&p) {
            list.push(p.clone());
        }
    }
    persist(&state);
    Ok(projects_state(&state))
}

#[tauri::command]
fn remove_project(state: tauri::State<AppState>, path: String) -> ProjectsState {
    {
        let mut list = state.projects.lock().unwrap();
        list.retain(|x| x != &path);
        if list.is_empty() {
            list.push(default_project());
        }
        let mut active = state.project.lock().unwrap();
        if !list.contains(&active) {
            *active = list[0].clone();
        }
    }
    persist(&state);
    projects_state(&state)
}

/// Minimal `~` expansion so the project field accepts `~/Documents/foo`.
fn shellexpand_home(p: &str) -> String {
    if let Some(rest) = p.strip_prefix("~/") {
        format!("{}/{}", default_workdir(), rest)
    } else if p == "~" {
        default_workdir()
    } else {
        p.to_string()
    }
}

#[tauri::command]
fn spawn_agent(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    agent_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let agent = find_agent(&state, &agent_id).ok_or_else(|| format!("unknown agent {agent_id}"))?;
    let wd = current_project(&state);
    ensure_spawned(&app, &state, &agent, &wd, cols, rows)?;
    Ok(())
}

#[tauri::command]
fn pty_write(app: tauri::AppHandle, agent_id: String, data: String) -> Result<(), String> {
    pty::write_bytes(&app, &agent_id, data.as_bytes())
}

#[tauri::command]
fn pty_resize(app: tauri::AppHandle, agent_id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&app, &agent_id, cols, rows)
}

#[tauri::command]
fn kill_agent(app: tauri::AppHandle, agent_id: String) -> Result<(), String> {
    pty::kill(&app, &agent_id)
}

#[derive(serde::Serialize)]
pub struct DispatchResult {
    pub agent_id: String,
    pub name: String,
    pub spawned: bool,
}

/// JARVIS routing: pick a free worker for a task, spawning one if needed, and
/// deliver the prompt to its session (in the current project directory).
#[tauri::command]
fn dispatch_task(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    prompt: String,
    cols: u16,
    rows: u16,
) -> Result<DispatchResult, String> {
    if prompt.trim().is_empty() {
        return Err("Empty task — nothing to route.".into());
    }

    let roster = state.roster.lock().unwrap().clone();
    let live = status_map(&state);
    let workers: Vec<&Agent> = roster.iter().filter(|a| a.kind == AgentKind::Worker).collect();

    let mut chosen: Option<Agent> = workers
        .iter()
        .find(|w| matches!(live.get(&w.id), Some(AgentStatus::Idle)))
        .map(|w| (*w).clone());

    if chosen.is_none() {
        chosen = workers
            .iter()
            .find(|w| !live.contains_key(&w.id))
            .map(|w| (*w).clone());
    }

    let agent = chosen.ok_or("All agents are busy — wait for one to free up.")?;

    let route = state.ledger.record(
        "jarvis",
        "route",
        &format!("JARVIS → {} · {}", agent.name, truncate(&prompt, 52)),
        2,
    );
    let _ = app.emit("ledger://entry", route);

    let wd = current_project(&state);
    let spawned = ensure_spawned(&app, &state, &agent, &wd, cols, rows)?;
    deliver(&app, &agent.id, prompt.clone(), spawned);

    pty::emit_status(&app, &agent.id, AgentStatus::Thinking);
    let task = state.ledger.record(&agent.id, "task", &truncate(&prompt, 90), 3);
    let _ = app.emit("ledger://entry", task);

    Ok(DispatchResult {
        agent_id: agent.id,
        name: agent.name,
        spawned,
    })
}

/// Agent-to-agent help: `from` pulls `to` into the same project to assist.
/// The helper spawns in the requester's working directory and receives context.
#[tauri::command]
fn request_assist(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    from: String,
    to: String,
    note: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if from == to {
        return Err("An agent can't assist itself.".into());
    }
    let from_agent = find_agent(&state, &from).ok_or_else(|| format!("unknown agent {from}"))?;
    let to_agent = find_agent(&state, &to).ok_or_else(|| format!("unknown agent {to}"))?;

    // The helper joins the requester's project directory.
    let wd = state
        .workdirs
        .lock()
        .unwrap()
        .get(&from)
        .cloned()
        .unwrap_or_else(|| current_project(&state));

    let spawned = ensure_spawned(&app, &state, &to_agent, &wd, cols, rows)?;

    let note = note.trim();
    let msg = if note.is_empty() {
        format!(
            "[ASSIST] {} needs your help in {}. Please review the project and assist, then report back to {}.",
            from_agent.name, wd, from_agent.name
        )
    } else {
        format!(
            "[ASSIST] {} needs your help in {}. Request: {}. Please assist and report back to {}.",
            from_agent.name, wd, note, from_agent.name
        )
    };
    deliver(&app, &to, msg, spawned);
    pty::emit_status(&app, &to, AgentStatus::Thinking);

    let e = state.ledger.record(
        &from,
        "assist",
        &format!("{} → {} · {}", from_agent.name, to_agent.name, truncate(note, 46)),
        4,
    );
    let _ = app.emit("ledger://entry", e);
    let _ = app.emit(
        "assist://link",
        serde_json::json!({ "from": from, "to": to }),
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            std::fs::create_dir_all(&data_dir).ok();
            let ledger =
                Ledger::open(&data_dir.join("ledger.db")).expect("failed to open ledger db");

            let sock_path = "/tmp/stark-tower-delegate.sock".to_string();
            let projects_file = data_dir.join("projects.json").to_string_lossy().to_string();
            let (projects, active) = load_projects(&projects_file);

            let config_file = data_dir.join("config.json").to_string_lossy().to_string();
            let cfg = config::load(std::path::Path::new(&config_file));
            let roster = cfg.roster();

            app.manage(AppState {
                pty: PtyManager::default(),
                chat: chat::ChatManager::default(),
                ledger,
                roster: Mutex::new(roster),
                project: Mutex::new(active),
                projects: Mutex::new(projects),
                projects_file,
                workdirs: Mutex::new(HashMap::new()),
                statuses: Mutex::new(HashMap::new()),
                sock_path: sock_path.clone(),
                reviews: Mutex::new(HashMap::new()),
                delegations: Mutex::new(chat::DelegationState::default()),
                config: Mutex::new(cfg),
                config_file,
            });

            pty::start_idle_monitor(app.handle().clone());
            chat::start_delegation_server(app.handle().clone(), sock_path);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_agents,
            get_ledger,
            get_project,
            set_project,
            list_projects,
            add_project,
            remove_project,
            spawn_agent,
            pty_write,
            pty_resize,
            kill_agent,
            dispatch_task,
            request_assist,
            chat_send,
            chat_stop,
            get_chat,
            list_files,
            review_respond,
            get_config,
            update_agent,
            remove_agent,
            update_engine,
            remove_engine,
            set_onboarded,
            set_lighting,
            reset_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stark Tower");
}
