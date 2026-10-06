mod agents;
mod attachments;
mod automations;
mod breaker;
mod bridge;
mod chat;
mod codex;
mod config;
mod delegation;
mod engine;
mod floor;
mod gate;
mod health;
mod ledger;
mod lifecycle;
mod notify;
mod opencode;
mod outputs;
mod proc;
mod prompts;
mod power;
mod providers;
mod policy;
mod pty;
mod reminders;
mod rpc;
mod schedule;
mod secrets;
mod tasks;
mod tone;
mod update;

use agents::{Agent, AgentKind, AgentStatus};
use config::{AgentConfig, AppConfig, EngineConfig};
use ledger::{Ledger, LedgerEntry, StoredMessage};
use pty::PtyManager;
use std::collections::{HashMap, HashSet};
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
    /// Lives in the app data dir (0700), with a per-launch random name so two
    /// instances don't collide.
    pub sock_path: String,
    /// Per-launch secret every bridge request must carry, so a stray local
    /// process can't dispatch work or answer approvals over the socket.
    pub sock_token: String,
    /// Pending human-review requests (id → channel that unblocks the agent).
    pub reviews: Mutex<HashMap<String, std::sync::mpsc::Sender<String>>>,
    /// What each pending review is about, so the UI can list them again.
    pub pending_reviews: Mutex<HashMap<String, bridge::ReviewRequest>>,
    /// The current batch of background delegations JARVIS is waiting on, so their
    /// results can be synthesized back to him in one follow-up when all finish.
    pub delegations: Mutex<chat::DelegationState>,
    /// User-editable engines + roster (names, personalities, sprites, models).
    /// The single source of truth; `roster` above is a derived cache.
    pub config: Mutex<AppConfig>,
    /// Where the config is persisted.
    pub config_file: String,
    /// PIDs of in-flight one-shot delegation workers, so app-quit can kill their
    /// process groups instead of orphaning them (they live outside `chat`).
    pub oneshot_pids: Mutex<HashSet<u32>>,
    /// Directory holding each agent's durable `<id>.md` memory file.
    pub memory_dir: String,
    /// Which task each agent is on, and the work waiting for busy agents.
    pub tasks: tasks::TaskEngine,
    /// The bridge and gate scripts agents' providers run.
    pub scripts: health::BridgeScripts,
    /// The git-versioned floor: an append-only event log + per-agent mailboxes,
    /// making the run observable and recoverable.
    pub floor_dir: String,
    /// Engine secrets (api-key-env values), kept out of config.json and off IPC.
    pub secrets: Mutex<secrets::SecretStore>,
    /// Where the secret store is persisted (0600).
    pub secrets_file: String,
    /// Keep-awake power assertion.
    pub power: power::PowerManager,
    /// Provider CLI versions, probed once per launch.
    pub probes: health::Probes,
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

/// A per-launch secret for the delegation socket. 16 bytes from the OS CSPRNG,
/// hex-encoded; falls back to a time+pid mix if /dev/urandom is unavailable.
/// macOS keeps a socket's path under 104 bytes, the terminating NUL included.
const MAX_SOCKET_PATH: usize = 103;
const BRIDGE_SOCKET_PREFIX: &str = "starkline-bridge-";
/// Enough random characters that the name can't be guessed, short enough to fit.
const SOCKET_NAME_RANDOM: usize = 8;

/// Where the bridge listens: a short random name in the app data folder (user-only),
/// or, when that path would be too long for a socket, in this user's private temp folder.
fn bridge_socket_path(data_dir: &std::path::Path, private_tmp: &std::path::Path, random: &str) -> std::path::PathBuf {
    let tail: String = random.chars().take(SOCKET_NAME_RANDOM).collect();
    let name = format!("{BRIDGE_SOCKET_PREFIX}{tail}.sock");
    let preferred = data_dir.join(&name);
    if preferred.as_os_str().len() <= MAX_SOCKET_PATH {
        preferred
    } else {
        private_tmp.join(name)
    }
}

fn gen_token() -> String {
    let mut buf = [0u8; 16];
    let ok = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            f.read_exact(&mut buf)
        })
        .is_ok();
    if !ok {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mix = nanos ^ ((std::process::id() as u128) << 64);
        buf.copy_from_slice(&mix.to_le_bytes());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// How long a copy attached to a message that was never sent is kept.
const UNSENT_ATTACHMENT_AGE: Duration = Duration::from_secs(24 * 60 * 60);

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

#[derive(serde::Serialize, specta::Type)]
struct ProjectInfo {
    path: String,
    name: String,
}

#[derive(serde::Serialize, specta::Type)]
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
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    floor::log_event(&state.floor_dir, ts, &agent.id, "spawn", &short_path(workdir));
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
#[specta::specta]
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
#[specta::specta]
fn chat_send(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    agent_id: String,
    text: String,
    dir: Option<String>,
    attachments: Vec<attachments::Attachment>,
) -> Result<Option<i64>, String> {
    let files = attachments::checked(&attachments::root(&app), &attachments)?;
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
    // A follow-up in a task's conversation picks that task back up.
    tasks::developer_message(&app, &agent_id);
    // The stored id goes back to the UI, which already shows the message, to avoid a repeat.
    chat::send_user_turn(&app, &agent_id, &text, &files, &cwd)
}

/// Keep copies of files the developer picked or dropped, to send with a message.
#[tauri::command]
#[specta::specta]
fn attach_files(app: tauri::AppHandle, paths: Vec<String>) -> Result<Vec<attachments::Attachment>, String> {
    let root = attachments::root(&app);
    paths.iter().map(|p| attachments::store_copy(&root, std::path::Path::new(&shellexpand_home(p.trim())))).collect()
}

/// Keep a file the developer pasted (a screenshot, say), sent as base64.
#[tauri::command]
#[specta::specta]
fn attach_data(app: tauri::AppHandle, name: String, data: String) -> Result<attachments::Attachment, String> {
    attachments::store_data(&attachments::root(&app), &name, &data)
}

/// Forget files attached to a message that was never sent (their chip was removed).
#[tauri::command]
#[specta::specta]
fn discard_attachments(app: tauri::AppHandle, state: tauri::State<AppState>, attachments: Vec<attachments::Attachment>) {
    let unused: Vec<attachments::Attachment> = attachments.into_iter().filter(|a| !state.ledger.attachment_in_use(&a.path)).collect();
    attachments::remove(&attachments::root(&app), &unused);
}

/// The start of a chat's text or HTML file, for its preview.
#[tauri::command]
#[specta::specta]
fn read_attachment_text(app: tauri::AppHandle, path: String) -> Result<String, String> {
    attachments::preview_text(&attachments::root(&app), std::path::Path::new(&path))
}

/// Pick an interrupted task back up where it left off, in its own conversation.
#[tauri::command]
#[specta::specta]
fn resume_task(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tasks::resume(&app, &id)
}

/// Quit for real: every agent session stops. (Closing the window doesn't.)
#[tauri::command]
#[specta::specta]
fn quit_app(app: tauri::AppHandle) {
    lifecycle::quit(&app);
}

/// Whether Starkline opens at login, in the background.
#[tauri::command]
#[specta::specta]
fn login_item_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
#[specta::specta]
fn set_login_item(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    let launcher = app.autolaunch();
    let result = if enabled { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| format!("macOS didn't accept the change: {e}"))?;
    launcher.is_enabled().map_err(|e| e.to_string())
}

/// Hand work to an agent as a task: it starts in a conversation of its own, or
/// waits its turn if the agent is busy.
#[tauri::command]
#[specta::specta]
fn start_task(
    app: tauri::AppHandle,
    agent_id: String,
    prompt: String,
    dir: Option<String>,
    attachments: Vec<attachments::Attachment>,
) -> Result<ledger::Task, String> {
    let files = attachments::checked(&attachments::root(&app), &attachments)?;
    tasks::start(&app, &agent_id, &prompt, dir.map(|d| shellexpand_home(d.trim())), &files)
}

/// The Notification Centre's record, newest first.
#[tauri::command]
#[specta::specta]
fn list_notifications(state: tauri::State<AppState>, limit: Option<i64>) -> Vec<ledger::Notification> {
    state.ledger.notifications(limit.unwrap_or(500))
}

#[tauri::command]
#[specta::specta]
fn mark_notifications_read(app: tauri::AppHandle, state: tauri::State<AppState>, ids: Vec<i64>) {
    state.ledger.mark_notifications_read(&ids);
    let _ = app.emit("notifications://changed", ());
}

#[tauri::command]
#[specta::specta]
fn mark_all_notifications_read(app: tauri::AppHandle, state: tauri::State<AppState>) {
    state.ledger.mark_all_notifications_read();
    let _ = app.emit("notifications://changed", ());
}

/// Permission rules the developer granted (revoked ones too, when asked).
#[tauri::command]
#[specta::specta]
fn list_permission_rules(state: tauri::State<AppState>, include_revoked: bool) -> Vec<policy::PermissionRule> {
    state.ledger.rules(include_revoked)
}

/// What Starkline can do with an agent on each kind of provider, as built.
#[tauri::command]
#[specta::specta]
fn provider_capabilities() -> Vec<providers::ProviderCapabilities> {
    providers::all()
}

/// The models a provider offers, as its CLI lists them (asked off the main thread).
#[tauri::command]
#[specta::specta]
async fn provider_models(app: tauri::AppHandle, engine_id: String) -> Result<Vec<providers::ModelChoice>, String> {
    let engine = {
        let state = app.state::<AppState>();
        let config = state.config.lock().unwrap();
        config.engines.iter().find(|e| e.id == engine_id).cloned().ok_or("That provider doesn't exist.")?
    };
    let program = chat::resolve_program(&engine.command).ok_or_else(|| format!("{} isn't installed on this Mac.", engine.label))?;
    tauri::async_runtime::spawn_blocking(move || providers::models(&engine.kind, &program))
        .await
        .map_err(|e| e.to_string())?
}

/// Starkline's permission policy: every rule and whether it runs on its own,
/// asks first, or never runs on its own.
#[tauri::command]
#[specta::specta]
fn permission_policy() -> Vec<gate::PolicyRule> {
    gate::policy()
}

/// Take back a rule: the calls it covered need approval again.
#[tauri::command]
#[specta::specta]
fn revoke_permission_rule(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64) -> bool {
    let revoked = state.ledger.revoke_rule(id);
    if revoked {
        let _ = app.emit("rules://changed", ());
    }
    revoked
}

/// Every automation, by name.
#[tauri::command]
#[specta::specta]
fn list_automations(app: tauri::AppHandle) -> Vec<ledger::Automation> {
    automations::list(&app)
}

/// Create an automation (no id) or change one; it's checked before it's saved.
#[tauri::command]
#[specta::specta]
fn save_automation(app: tauri::AppHandle, input: automations::AutomationInput) -> Result<ledger::Automation, String> {
    automations::save(&app, input)
}

/// Pause an automation or turn it back on (its next run counts from now).
#[tauri::command]
#[specta::specta]
fn set_automation_enabled(app: tauri::AppHandle, id: i64, enabled: bool) -> Result<ledger::Automation, String> {
    automations::set_enabled(&app, id, enabled)
}

#[tauri::command]
#[specta::specta]
fn delete_automation(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    automations::delete(&app, id)
}

/// Run an automation now, outside its schedule.
#[tauri::command]
#[specta::specta]
fn run_automation_now(app: tauri::AppHandle, id: i64) -> Result<ledger::AutomationRun, String> {
    automations::run_now(&app, id)
}

/// Don't make up a missed run; wait for the next one.
#[tauri::command]
#[specta::specta]
fn skip_missed_run(app: tauri::AppHandle, id: i64) {
    automations::skip_missed(&app, id)
}

/// An automation's runs, newest first.
#[tauri::command]
#[specta::specta]
fn list_automation_runs(app: tauri::AppHandle, id: i64) -> Vec<ledger::AutomationRun> {
    automations::runs(&app, id)
}

/// Every reminder, soonest first.
#[tauri::command]
#[specta::specta]
fn list_reminders(app: tauri::AppHandle) -> Vec<ledger::Reminder> {
    reminders::list(&app)
}

/// Set a reminder (no id) or change one; it's checked before it's saved.
#[tauri::command]
#[specta::specta]
fn save_reminder(app: tauri::AppHandle, input: reminders::ReminderInput) -> Result<ledger::Reminder, String> {
    reminders::save(&app, input)
}

/// Done with a reminder: a one-off is finished, a repeating one waits for its next time.
#[tauri::command]
#[specta::specta]
fn complete_reminder(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    reminders::complete(&app, id)
}

/// Remind me again later.
#[tauri::command]
#[specta::specta]
fn snooze_reminder(app: tauri::AppHandle, id: i64, until: i64) -> Result<ledger::Reminder, String> {
    reminders::snooze(&app, id, until)
}

#[tauri::command]
#[specta::specta]
fn delete_reminder(app: tauri::AppHandle, id: i64) -> Result<(), String> {
    reminders::delete(&app, id)
}

/// Everything the task screen shows: the task, what it delegated, its history,
/// plan, checks, uncommitted changes and conversation.
#[tauri::command]
#[specta::specta]
fn get_task_detail(app: tauri::AppHandle, id: String) -> Option<tasks::TaskDetail> {
    tasks::detail(&app, &id)
}

/// The readable diff of one changed file in a task's folder.
#[tauri::command]
#[specta::specta]
fn get_task_file_diff(state: tauri::State<AppState>, id: String, path: String) -> Result<String, String> {
    let task = state.ledger.task(&id).ok_or("That task doesn't exist.")?;
    tasks::file_diff(&task.cwd, &path)
}

/// The persisted transcript for an agent's active conversation (for rehydration).
#[tauri::command]
#[specta::specta]
fn get_chat(state: tauri::State<AppState>, agent_id: String, limit: Option<i64>) -> Vec<StoredMessage> {
    state.ledger.messages(&agent_id, limit.unwrap_or(500))
}

/// The agent's current saved chat, if it has one, so the UI can restore the folder
/// it runs in: resuming a Claude session only works from its own folder.
#[tauri::command]
#[specta::specta]
fn active_conversation(state: tauri::State<AppState>, agent_id: String) -> Option<ledger::Conversation> {
    state
        .ledger
        .current_conversation(&agent_id)
        .and_then(|id| state.ledger.conversation(id))
}

/// All saved chats across agents, most-recently-active first.
#[tauri::command]
#[specta::specta]
fn list_conversations(state: tauri::State<AppState>) -> Vec<ledger::Conversation> {
    state.ledger.conversations(200)
}

/// End an agent's live session because the developer chose to (stop, new chat,
/// another chat, removed or turned off). A task it was running is marked blocked.
fn stop_by_developer(app: &tauri::AppHandle, agent_id: &str) {
    tasks::session_ended(app, agent_id, tasks::Ended::ByYou);
    chat::stop(app, agent_id);
}

/// Tell the UI an agent now talks in a different conversation.
fn emit_chat_switched(app: &tauri::AppHandle, agent_id: &str, conversation_id: i64) {
    let _ = app.emit("chat://switched", serde_json::json!({ "agentId": agent_id, "conversationId": conversation_id }));
}

/// Start a fresh conversation with an agent (ends the live session so the next
/// message begins a genuinely new chat), in `cwd` (a project folder) or where the
/// agent works now. Returns the new conversation id.
#[tauri::command]
#[specta::specta]
fn new_chat(app: tauri::AppHandle, state: tauri::State<AppState>, agent_id: String, cwd: Option<String>) -> i64 {
    stop_by_developer(&app, &agent_id);
    let cwd = cwd
        .filter(|c| !c.trim().is_empty())
        .or_else(|| state.workdirs.lock().unwrap().get(&agent_id).cloned())
        .unwrap_or_else(|| current_project(&state));
    state.workdirs.lock().unwrap().insert(agent_id.clone(), cwd.clone());
    let id = state.ledger.new_conversation(&agent_id, &cwd);
    emit_chat_switched(&app, &agent_id, id);
    let _ = app.emit("conversations://changed", ());
    id
}

/// Delete a chat for good: its messages go, and tasks that ran in it stay in history without
/// their transcript. The chat an agent is working in can't be deleted until they finish; the
/// open chat, once deleted, gives way to a fresh one in the same folder.
#[tauri::command]
#[specta::specta]
fn delete_conversation(app: tauri::AppHandle, state: tauri::State<AppState>, conversation_id: i64) -> Result<(), String> {
    let chat = state.ledger.conversation(conversation_id).ok_or("That chat doesn't exist any more.")?;
    let agent = chat.agent_id.clone();
    let was_open = state.ledger.current_conversation(&agent) == Some(conversation_id);
    if was_open {
        if tasks::is_busy(&app, &agent) {
            let name = prompts::agent_name(&app, &agent);
            return Err(format!("{name} is working in this chat. Delete it once they've finished."));
        }
        stop_by_developer(&app, &agent);
    }
    let files = state.ledger.conversation_attachments(conversation_id);
    if !state.ledger.delete_conversation(conversation_id) {
        return Err("The chat couldn't be deleted.".into());
    }
    attachments::remove(&attachments::root(&app), &files);
    if was_open {
        let fresh = state.ledger.new_conversation(&agent, &chat.cwd);
        emit_chat_switched(&app, &agent, fresh);
    }
    let _ = app.emit("conversations://changed", ());
    let _ = app.emit("tasks://changed", ());
    Ok(())
}

/// Reopen a saved conversation: make it active, end the live session, and point
/// the agent's workdir at the conversation's dir so the next message resumes it.
#[tauri::command]
#[specta::specta]
fn open_conversation(app: tauri::AppHandle, state: tauri::State<AppState>, conversation_id: i64) {
    state.ledger.open_conversation(conversation_id);
    if let Some(c) = state.ledger.conversation(conversation_id) {
        stop_by_developer(&app, &c.agent_id);
        if !c.cwd.trim().is_empty() {
            state.workdirs.lock().unwrap().insert(c.agent_id.clone(), c.cwd.clone());
        }
        emit_chat_switched(&app, &c.agent_id, conversation_id);
    }
    let _ = app.emit("conversations://changed", ());
}

#[derive(serde::Serialize, specta::Type)]
struct PathEntry {
    path: String,
    dir: bool,
}

/// List files AND folders under `dir` (relative paths, recursively into every
/// subfolder) for the chat's `@` picker. Respects .gitignore and skips heavy
/// noise dirs, so it mirrors what Claude Code would see.
#[tauri::command]
#[specta::specta]
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

/// End the agent's live session. Saved chats are never deleted here; starting a
/// fresh conversation is `new_chat`.
#[tauri::command]
#[specta::specta]
fn chat_stop(app: tauri::AppHandle, agent_id: String) {
    // Only the live session ends; the transcript stays in saved chats.
    stop_by_developer(&app, &agent_id);
}

/// What the agent runtime can do right now: installed provider CLIs, the data
/// store and the agent bridge.
#[tauri::command]
#[specta::specta]
fn runtime_health(app: tauri::AppHandle, state: tauri::State<AppState>) -> health::RuntimeHealth {
    let engines = state.config.lock().unwrap().engines.clone();
    let engines = engines
        .iter()
        .map(|e| {
            let path = chat::resolve_program(&e.command);
            let version = path.as_deref().and_then(|p| state.probes.version_of(&app, p));
            let sign_in = path.as_deref().and_then(|p| state.probes.sign_in_of(&app, &e.kind, p));
            health::EngineHealth {
                id: e.id.clone(),
                label: e.label.clone(),
                kind: e.kind.clone(),
                enabled: e.enabled,
                installed: path.is_some(),
                path,
                version,
                sign_in,
            }
        })
        .collect();
    let node_path = chat::resolve_program("node");
    let node = node_path.as_deref().and_then(|p| state.probes.version_of(&app, p));
    health::RuntimeHealth {
        host: "app".into(),
        engines,
        data_store: state.ledger.healthy(),
        bridge: health::bridge_up(),
        bridge_error: health::bridge_error(),
        live_sessions: state.chat.sessions.lock().unwrap().len() as u32,
        node,
        node_path,
        background: true,
    }
}

/// Whether Starkline is keeping this Mac awake, and why.
#[tauri::command]
#[specta::specta]
fn power_state(app: tauri::AppHandle) -> power::PowerState {
    power::state(&app)
}

/// Allow (or stop allowing) Starkline to keep this Mac awake while agents work.
#[tauri::command]
#[specta::specta]
fn set_keep_awake(app: tauri::AppHandle, state: tauri::State<AppState>, enabled: bool) -> power::PowerState {
    state.config.lock().unwrap().keep_awake = enabled;
    state.save_config();
    state.power.set_enabled(enabled);
    power::state(&app)
}

/// Everything agents are currently blocked on, oldest first.
#[tauri::command]
#[specta::specta]
fn pending_reviews(state: tauri::State<AppState>) -> Vec<bridge::ReviewRequest> {
    let mut list: Vec<_> = state.pending_reviews.lock().unwrap().values().cloned().collect();
    list.sort_by(|a, b| a.created.total_cmp(&b.created));
    list
}

/// Deliver the human's decision back to a blocked `ask_human` review.
#[tauri::command]
#[specta::specta]
fn review_respond(state: tauri::State<AppState>, id: String, decision: String) {
    // A question and its answer belong in the agent's conversation history.
    let question = state.pending_reviews.lock().unwrap().get(&id).cloned();
    if let Some(q) = question.filter(|q| q.kind == "questions") {
        let asked = if q.body.trim().is_empty() { &q.title } else { &q.body };
        state.ledger.add_message(&q.agent_id, "agent", Some(asked), None, None);
        state.ledger.add_message(&q.agent_id, "user", Some(&decision), None, None);
    }
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
    // Reconcile the floor: make sure every agent has its mailbox dirs.
    for a in &cfg.agents {
        floor::ensure_agent_dirs(&state.floor_dir, &a.id);
    }
    let _ = app.emit("config://changed", cfg.clone());
    cfg
}

#[tauri::command]
#[specta::specta]
fn get_config(state: tauri::State<AppState>) -> AppConfig {
    state.config.lock().unwrap().clone()
}

/// Upsert an agent (edit an existing one by id, or add a new one).
#[tauri::command]
#[specta::specta]
fn update_agent(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    mut agent: AgentConfig,
) -> AppConfig {
    // A new agent starts at its default tone; the dials always stay in range.
    agent.tone = Some(agent.tone.unwrap_or_else(|| tone::default_for(&agent.id)).clamped());
    // Turning an agent off ends its live session; its chats are kept.
    if !agent.enabled {
        stop_by_developer(&app, &agent.id);
    }
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
#[specta::specta]
fn remove_agent(app: tauri::AppHandle, state: tauri::State<AppState>, id: String) -> AppConfig {
    stop_by_developer(&app, &id);
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.agents.retain(|a| a.id != id);
    }
    commit_config(&app, &state)
}

/// Upsert an engine (edit by id, or add a new backend).
#[tauri::command]
#[specta::specta]
fn update_engine(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    mut engine: EngineConfig,
) -> AppConfig {
    {
        // Move any new/changed secret into the store, preserve unchanged ones
        // (SENTINEL), and clear removed ones — so the config never holds plaintext.
        let mut store = state.secrets.lock().unwrap();
        secrets::reconcile(&mut store, &mut engine);
        secrets::save(std::path::Path::new(&state.secrets_file), &store);
    }
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
#[specta::specta]
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
#[specta::specta]
fn set_onboarded(app: tauri::AppHandle, state: tauri::State<AppState>, value: bool) -> AppConfig {
    state.config.lock().unwrap().onboarded = value;
    commit_config(&app, &state)
}

/// Set the floor lighting mode ("auto" | "system" | morning/day/evening/night).
#[tauri::command]
#[specta::specta]
fn set_lighting(app: tauri::AppHandle, state: tauri::State<AppState>, mode: String) -> AppConfig {
    state.config.lock().unwrap().lighting = mode;
    commit_config(&app, &state)
}

/// Change how Starkline looks and what the agents wear; nothing about the work changes with it.
#[tauri::command]
#[specta::specta]
fn set_theme(app: tauri::AppHandle, state: tauri::State<AppState>, theme: String, outfits: String) -> Result<AppConfig, String> {
    if !config::THEMES.contains(&theme.as_str()) {
        return Err("That theme isn't one Starkline has.".into());
    }
    if !config::is_outfits(&outfits) {
        return Err("Those outfits aren't ones Starkline has.".into());
    }
    {
        let mut cfg = state.config.lock().unwrap();
        cfg.theme = theme;
        cfg.outfits = outfits;
    }
    Ok(commit_config(&app, &state))
}

/// Set the standup mission cadence in minutes (0 = off).
#[tauri::command]
#[specta::specta]
fn set_standup_minutes(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    minutes: u32,
) -> AppConfig {
    state.config.lock().unwrap().standup_minutes = minutes;
    commit_config(&app, &state)
}

/// Restore the built-in engines + roster (wipes customizations).
#[tauri::command]
#[specta::specta]
fn reset_config(app: tauri::AppHandle, state: tauri::State<AppState>) -> AppConfig {
    *state.config.lock().unwrap() = config::default_config();
    commit_config(&app, &state)
}

#[tauri::command]
#[specta::specta]
fn get_ledger(state: tauri::State<AppState>, limit: Option<i64>) -> Vec<LedgerEntry> {
    state.ledger.recent(limit.unwrap_or(60))
}

/// The task board — durable cards for delegated work, newest first.
#[tauri::command]
#[specta::specta]
fn get_tasks(state: tauri::State<AppState>, limit: Option<i64>) -> Vec<ledger::Task> {
    state.ledger.tasks(limit.unwrap_or(50))
}

/// Close a task card without reviewing it (cancel it, or set aside a blocked one): it
/// leaves the Work board but stays in history.
#[tauri::command]
#[specta::specta]
fn close_task(app: tauri::AppHandle, id: String) {
    tasks::close(&app, &id);
}

/// Where an agent's tone dials start: a built-in agent's character, else neutral.
#[tauri::command]
#[specta::specta]
fn default_tone(agent_id: String) -> tone::Tone {
    tone::default_for(&agent_id)
}

/// Mark a task that's ready for review as reviewed: it leaves the Work board and stays in
/// history as reviewed.
#[tauri::command]
#[specta::specta]
fn review_task(app: tauri::AppHandle, id: String) -> Result<(), String> {
    tasks::review(&app, &id)
}

/// An agent's durable memory (the markdown it curates across sessions).
#[tauri::command]
#[specta::specta]
fn get_memory(state: tauri::State<AppState>, agent_id: String) -> String {
    let path = std::path::Path::new(&state.memory_dir).join(format!("{agent_id}.md"));
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Bugs agents have reported about the app, newest first.
#[tauri::command]
#[specta::specta]
fn get_bugs(state: tauri::State<AppState>) -> Vec<ledger::Bug> {
    state.ledger.bugs(200)
}

/// Change a bug's status (open | doing | fixed | wontfix).
#[tauri::command]
#[specta::specta]
fn set_bug_status(app: tauri::AppHandle, state: tauri::State<AppState>, id: i64, status: String) {
    state.ledger.set_bug_status(id, &status);
    let _ = app.emit("bugs://changed", ());
}

/// The stark-tower repo root (the maintenance agent's working dir).
fn repo_root() -> String {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| env!("CARGO_MANIFEST_DIR").to_string())
}

/// "Solve them now": hand the open bugs to the maintenance agent (DUM-E), which
/// works through them in the app's repo. Streams to DUM-E's chat tab; the bugs
/// are marked doing, then fixed when the run completes (reopen from the UI if not).
#[tauri::command]
#[specta::specta]
fn run_maintenance(app: tauri::AppHandle, state: tauri::State<AppState>) -> Result<(), String> {
    let bugs = state.ledger.open_bugs();
    if bugs.is_empty() {
        return Err("No open bugs to fix.".into());
    }
    for b in &bugs {
        state.ledger.set_bug_status(b.id, "doing");
    }
    let _ = app.emit("bugs://changed", ());

    let mut task = String::from(
        "Fix these bugs that agents reported in the Starkline app. Work in THIS repo (your cwd). \
For each: locate the cause, fix it cleanly (match the surrounding code, keep it minimal and \
reversible), and briefly say what you changed. If one is too vague to act on, say what you'd need.\n\n",
    );
    for b in &bugs {
        task.push_str(&format!(
            "[bug #{}] (reported by {}) {}\n{}\n\n",
            b.id, b.reporter, b.title, b.detail
        ));
    }
    let repo = repo_root();
    // Names are the developer's to choose: find the maintenance agent by its kind.
    let maintainer = state
        .config
        .lock()
        .unwrap()
        .agents
        .iter()
        .find(|a| a.kind == agents::AgentKind::Maintenance && a.enabled)
        .map(|a| a.id.clone())
        .ok_or("There's no maintenance agent on the roster.")?;
    state.workdirs.lock().unwrap().insert(maintainer.clone(), repo.clone());
    let ids: Vec<i64> = bugs.iter().map(|b| b.id).collect();

    std::thread::spawn(move || {
        // A run that fails or ends without a result fixed nothing: reopen the bugs.
        let outcome = chat::run_task_blocking(&app, tasks::BY_DEVELOPER, &maintainer, &task, &repo);
        let fixed = matches!(&outcome, Ok(result) if !result.trim().is_empty());
        if let Some(state) = app.try_state::<AppState>() {
            for id in ids {
                state.ledger.set_bug_status(id, if fixed { "fixed" } else { "open" });
            }
        }
        let _ = app.emit("bugs://changed", ());
    });
    Ok(())
}

#[tauri::command]
#[specta::specta]
fn get_project(state: tauri::State<AppState>) -> String {
    current_project(&state)
}

#[tauri::command]
#[specta::specta]
fn list_projects(state: tauri::State<AppState>) -> ProjectsState {
    projects_state(&state)
}

/// Set the active/default project (adds it to the managed list if new).
#[tauri::command]
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
fn pty_write(app: tauri::AppHandle, agent_id: String, data: String) -> Result<(), String> {
    pty::write_bytes(&app, &agent_id, data.as_bytes())
}

#[tauri::command]
#[specta::specta]
fn pty_resize(app: tauri::AppHandle, agent_id: String, cols: u16, rows: u16) -> Result<(), String> {
    pty::resize(&app, &agent_id, cols, rows)
}

#[tauri::command]
#[specta::specta]
fn kill_agent(app: tauri::AppHandle, agent_id: String) -> Result<(), String> {
    pty::kill(&app, &agent_id)
}

/// Release Ultron containment for a Blocked agent (the "release" action).
#[tauri::command]
#[specta::specta]
fn unblock_agent(app: tauri::AppHandle, agent_id: String) {
    pty::unblock(&app, &agent_id);
}

/// Notify-only check for a newer GitHub release (fail-loud; logs to updater.log).
#[tauri::command]
#[specta::specta]
fn check_update(app: tauri::AppHandle) {
    std::thread::spawn(move || update::check(&app));
}

#[derive(serde::Serialize, specta::Type)]
pub struct DispatchResult {
    pub agent_id: String,
    pub name: String,
    pub spawned: bool,
}

/// JARVIS routing: pick a free worker for a task, spawning one if needed, and
/// deliver the prompt to its session (in the current project directory).
#[tauri::command]
#[specta::specta]
fn dispatch_task(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    prompt: String,
    cols: u16,
    rows: u16,
) -> Result<DispatchResult, String> {
    if prompt.trim().is_empty() {
        return Err("The task is empty, so there is nothing to route.".into());
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

    let agent = chosen.ok_or("Every agent is busy. Try again when one is free.")?;

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
#[specta::specta]
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
/// The tauri-specta builder: the single registry of commands, used both to serve
/// them at runtime and to generate the typed TS bindings (see the export test).
fn specta_builder() -> tauri_specta::Builder {
    tauri_specta::Builder::<tauri::Wry>::new().commands(
        tauri_specta::collect_commands![
            list_agents,
            get_ledger,
            get_tasks,
            close_task,
            review_task,
            delete_conversation,
            attach_files,
            attach_data,
            discard_attachments,
            read_attachment_text,
            default_tone,
            start_task,
            resume_task,
            quit_app,
            login_item_enabled,
            set_login_item,
            get_task_detail,
            get_task_file_diff,
            list_notifications,
            mark_notifications_read,
            mark_all_notifications_read,
            list_permission_rules,
            revoke_permission_rule,
            permission_policy,
            provider_capabilities,
            provider_models,
            list_reminders,
            save_reminder,
            complete_reminder,
            snooze_reminder,
            delete_reminder,
            list_automations,
            save_automation,
            set_automation_enabled,
            delete_automation,
            run_automation_now,
            skip_missed_run,
            list_automation_runs,
            get_memory,
            get_bugs,
            set_bug_status,
            run_maintenance,
            get_project,
            set_project,
            list_projects,
            add_project,
            remove_project,
            spawn_agent,
            pty_write,
            pty_resize,
            kill_agent,
            unblock_agent,
            check_update,
            dispatch_task,
            request_assist,
            chat_send,
            chat_stop,
            get_chat,
            active_conversation,
            list_conversations,
            new_chat,
            open_conversation,
            list_files,
            review_respond,
            pending_reviews,
            runtime_health,
            power_state,
            set_keep_awake,
            get_config,
            update_agent,
            remove_agent,
            update_engine,
            remove_engine,
            set_onboarded,
            set_lighting,
            set_theme,
            set_standup_minutes,
            reset_config
        ],
    )
}

pub fn run() {
    let specta_builder = specta_builder();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![lifecycle::BACKGROUND_ARG]),
        ))
        .on_window_event(lifecycle::on_window_event)
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            std::fs::create_dir_all(&data_dir).ok();
            let ledger =
                Ledger::open(&data_dir.join("ledger.db")).expect("failed to open ledger db");

            // Per-launch token + a randomly-named socket in a user-only folder,
            // instead of a predictable world-reachable /tmp path. Sweep any stale
            // bridge sockets from a previous run.
            let sock_token = gen_token();
            for dir in [data_dir.clone(), std::env::temp_dir()] {
                if let Ok(rd) = std::fs::read_dir(&dir) {
                    for e in rd.flatten() {
                        let n = e.file_name();
                        let n = n.to_string_lossy();
                        if (n.starts_with("delegate-") || n.starts_with(BRIDGE_SOCKET_PREFIX)) && n.ends_with(".sock") {
                            let _ = std::fs::remove_file(e.path());
                        }
                    }
                }
            }
            let sock_path = bridge_socket_path(&data_dir, &std::env::temp_dir(), &gen_token()).to_string_lossy().to_string();
            let projects_file = data_dir.join("projects.json").to_string_lossy().to_string();
            let (projects, active) = load_projects(&projects_file);

            let config_file = data_dir.join("config.json").to_string_lossy().to_string();
            let mut cfg = config::load(std::path::Path::new(&config_file));

            // Secrets live outside config.json. Migrate any plaintext api-key-env
            // values from an existing config into the 0600 secret store, leaving a
            // sentinel behind, then re-save the (now secret-free) config.
            let secrets_file = data_dir.join("secrets.json").to_string_lossy().to_string();
            let mut secret_store = secrets::load(std::path::Path::new(&secrets_file));
            let before = format!("{:?}", cfg.engines);
            for e in cfg.engines.iter_mut() {
                secrets::reconcile(&mut secret_store, e);
            }
            if format!("{:?}", cfg.engines) != before {
                secrets::save(std::path::Path::new(&secrets_file), &secret_store);
                config::save(std::path::Path::new(&config_file), &cfg);
            }
            let roster = cfg.roster();

            let memory_dir = data_dir.join("memory");
            std::fs::create_dir_all(&memory_dir).ok();
            let memory_dir = memory_dir.to_string_lossy().to_string();

            // The git-versioned floor: seed it with the current roster's mailboxes.
            let data_str = data_dir.to_string_lossy().to_string();
            let agent_ids: Vec<String> = roster.iter().map(|a| a.id.clone()).collect();
            let floor_dir = floor::init(&data_str, &agent_ids);
            floor::start_committer(floor_dir.clone());

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
                sock_token: sock_token.clone(),
                reviews: Mutex::new(HashMap::new()),
                pending_reviews: Mutex::new(HashMap::new()),
                delegations: Mutex::new(chat::DelegationState::default()),
                config: Mutex::new(cfg),
                config_file,
                oneshot_pids: Mutex::new(HashSet::new()),
                memory_dir,
                tasks: tasks::TaskEngine::default(),
                scripts: health::BridgeScripts::resolve(app.handle()),
                floor_dir,
                secrets: Mutex::new(secret_store),
                secrets_file,
                power: power::PowerManager::default(),
                probes: health::Probes::default(),
            });
            {
                let state = app.state::<AppState>();
                let enabled = state.config.lock().unwrap().keep_awake;
                state.power.set_enabled(enabled);
            }
            // Agents are given read access to the attachments folder, so it always exists.
            std::fs::create_dir_all(attachments::root(app.handle())).ok();
            // Only now is there anything for the page to talk to.
            lifecycle::create_main(app)?;
            start_power_monitor(app.handle().clone());

            pty::start_idle_monitor(app.handle().clone());
            bridge::start_delegation_server(app.handle().clone(), sock_path);
            start_mission_scheduler(app.handle().clone());
            start_floor_router(app.handle().clone());
            if let Err(e) = lifecycle::setup_tray(app.handle()) {
                eprintln!("[lifecycle] couldn't add the menu bar item: {e}");
            }
            // Opened at login, it starts in the background; otherwise the window shows.
            if !lifecycle::launched_in_background() {
                lifecycle::show_main(app.handle());
            }
            // Recovery first, then the automation scheduler.
            automations::start(app.handle().clone());
            reminders::start(app.handle().clone());
            // Copies of files attached to messages that were never sent go after a day.
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    if let Some(state) = h.try_state::<AppState>() {
                        attachments::sweep_unused(&attachments::root(&h), |p| state.ledger.attachment_in_use(p), UNSENT_ATTACHMENT_AGE);
                    }
                });
            }
            {
                let h = app.handle().clone();
                std::thread::spawn(move || update::check(&h));
            }
            Ok(())
        })
        .invoke_handler(specta_builder.invoke_handler())
        .build(tauri::generate_context!())
        .expect("error while building Starkline")
        .run(|app_handle, event| lifecycle::on_run_event(app_handle, &event));
}

/// The floor router: move outbox messages to inboxes (single mover), then drain
/// each live+idle agent's inbox into its session. Delivering only when idle keeps
/// a teammate's message from interleaving mid-turn.
fn start_floor_router(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(1500));
        let Some(state) = app.try_state::<AppState>() else {
            continue;
        };
        let floor_dir = state.floor_dir.clone();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        for m in floor::route_once(&floor_dir) {
            floor::log_event(&floor_dir, now, &m.from, "message", &format!("→ {} ({})", m.to, m.kind));
        }
        let live_idle: Vec<String> = {
            let sessions = state.chat.sessions.lock().unwrap();
            let statuses = state.statuses.lock().unwrap();
            sessions
                .keys()
                .filter(|id| matches!(statuses.get(*id), Some(AgentStatus::Idle)))
                .cloned()
                .collect()
        };
        for id in live_idle {
            // Archive a message only once it reached the session; otherwise it
            // stays queued for the next pass.
            floor::drain_inbox_with(&floor_dir, &id, |m| {
                let delivered = delegation::deliver_message(&app, &id, &m.from, &m.body);
                if delivered {
                    floor::log_event(&floor_dir, now, &id, "message-in", &format!("from {} ({})", m.from, m.id));
                }
                delivered
            });
        }
    });
}

/// Re-checks keep-awake on a timer, so the waiting-on-you grace period ends even
/// when no agent changes status.
fn start_power_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(power::RECHECK_EVERY);
        power::sync(&app);
    });
}

/// Background loop that fires the standup mission every `standup_minutes` (0 =
/// off). It only nudges a live orchestrator — never spawns one — so autonomy
/// stays within a session the user actually opened.
fn start_mission_scheduler(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut minutes_elapsed: u64 = 0;
        loop {
            std::thread::sleep(Duration::from_secs(60));
            minutes_elapsed += 1;
            let interval = app
                .try_state::<AppState>()
                .map(|s| s.config.lock().unwrap().standup_minutes as u64)
                .unwrap_or(0);
            if interval > 0 && minutes_elapsed.is_multiple_of(interval) {
                delegation::run_standup(&app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_socket_always_fits_and_listens() {
        let random = "0123456789abcdef0123456789abcdef";
        // This Mac's real data folder: the old name made a 114-byte path, too long for a socket.
        let home = std::env::var("HOME").unwrap_or_default();
        let data = std::path::PathBuf::from(format!("{home}/Library/Application Support/com.omgandhi.starktower"));
        let private_tmp = std::env::temp_dir();
        let chosen = bridge_socket_path(&data, &private_tmp, random);
        assert!(chosen.as_os_str().len() <= MAX_SOCKET_PATH, "{chosen:?}");
        assert!(chosen.starts_with(&data), "a short name fits in the data folder");
        assert_eq!(chosen.file_name().unwrap(), "starkline-bridge-01234567.sock");

        // A folder too deep for any socket name falls back to the private temp folder.
        let deep = std::path::PathBuf::from(format!("/{}", "deep/".repeat(30)));
        let fallback = bridge_socket_path(&deep, &private_tmp, random);
        assert!(fallback.starts_with(&private_tmp) && fallback.as_os_str().len() <= MAX_SOCKET_PATH);

        // And a socket really listens at a path chosen this way. The name is this run's own
        // (a socket file outlives its listener, so a fixed name would collide with the last run).
        let dir = private_tmp.join(format!("starkline-bridge-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let unique = format!("{:08x}{random}", std::process::id());
        let path = bridge_socket_path(&dir, &private_tmp, &unique);
        let listener = std::os::unix::net::UnixListener::bind(&path);
        let bound = listener.is_ok();
        let error = listener.err();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(bound, "{path:?}: {error:?}");
    }

    use super::*;

    #[test]
    fn tilde_expands_to_home() {
        let home = default_workdir();
        assert_eq!(shellexpand_home("~"), home);
        assert_eq!(shellexpand_home("~/foo"), format!("{home}/foo"));
        assert_eq!(shellexpand_home("/abs/path"), "/abs/path");
    }

    #[test]
    fn token_is_32_hex_chars() {
        let t = gen_token();
        assert_eq!(t.len(), 32);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn truncate_and_short_path() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5).chars().count(), 6); // 5 chars + ellipsis
        assert_eq!(short_path("/a/b/c"), "c");
    }

    /// Regenerates the typed TS bindings from the Rust commands + types, so
    /// src/lib/bindings.ts can never drift. Run via `cargo test`.
    #[test]
    fn export_typescript_bindings() {
        // i64/u64 (ledger ids, timestamps) serialize to JSON as plain numbers, so
        // map them to TS `number` rather than the default bigint-forbidden error.
        let ts = specta_typescript::Typescript::default()
            .bigint(specta_typescript::BigIntExportBehavior::Number)
            // Generated + trusted; skip tsc's unused-locals/strict checks on it.
            .header("// @ts-nocheck\n");
        super::specta_builder()
            .export(ts, "../src/lib/bindings.ts")
            .expect("failed to export typescript bindings");
    }
}
