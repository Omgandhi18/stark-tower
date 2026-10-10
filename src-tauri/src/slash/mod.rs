//! The slash menu's catalog: what an agent's session can run (skills, custom and plugin
//! commands, MCP prompts, the provider's own commands) and the state of its MCP servers.
//!
//! A chat with no session yet has only what's on disk (`disk`). A running session reports
//! the real list itself (Claude Code over stream-json, Codex over its app server, OpenCode
//! over ACP): those reports are kept per chat, and the last one per agent and folder stands
//! in for a chat whose session has ended. Nothing here holds a secret: servers carry names,
//! status and transport, never their config.

mod claude;
mod disk;
mod plugins;
mod providers;

pub(crate) use providers::{acp_commands, codex_servers, codex_skill_paths, codex_skills, codex_startup};

use claude::RawCommand;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

/// A burst of `commands_changed` (each MCP server connecting sends one) asks for the servers' status once.
const MCP_REFRESH_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SlashKind {
    Skill,
    Command,
    /// A prompt an MCP server offers.
    Prompt,
    /// One of the provider's own commands.
    Builtin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SlashSource {
    Project,
    User,
    Plugin,
    /// Skills the developer's claude.ai account syncs.
    Synced,
    Mcp,
    /// Built into the agent's provider.
    Provider,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SlashItem {
    /// What follows the slash: `review`, `sarathi:review`, `mcp__docs__summarize`.
    pub name: String,
    pub description: String,
    /// The arguments it takes, as its author wrote them (`[branch]`); empty when none.
    pub hint: String,
    pub kind: SlashKind,
    pub source: SlashSource,
    /// The plugin or MCP server it comes from; empty otherwise.
    pub origin: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum McpStatus {
    Connected,
    Pending,
    Failed,
    NeedsAuth,
    Disabled,
    /// Set up, but no session has reported on it yet.
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub status: McpStatus,
    /// user | project | local | plugin | claude.ai …
    pub source: String,
    pub tools: Option<u32>,
    pub error: Option<String>,
    /// stdio | http | sse; empty when not known.
    pub transport: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SlashCatalog {
    pub items: Vec<SlashItem>,
    pub servers: Vec<McpServer>,
    /// A running session reported this; otherwise it's read from disk.
    pub live: bool,
}

/// What one chat's session (or the last one for an agent and folder) reported.
#[derive(Debug, Clone, Default)]
struct Live {
    /// Claude Code: every command with its description.
    raw: Vec<RawCommand>,
    /// Claude Code: the names from the turn's `init`, for when no descriptions have arrived.
    names: Vec<String>,
    skills: Vec<String>,
    plugins: Vec<String>,
    hidden: Vec<String>,
    /// Codex and OpenCode: the commands, already classified.
    items: Vec<SlashItem>,
    servers: Vec<McpServer>,
    servers_known: bool,
    /// Codex: each server's latest `startupStatus` (status, error), which its server list can't say.
    startup: HashMap<String, (McpStatus, Option<String>)>,
    refresh_queued: bool,
}

#[derive(Default)]
struct Store {
    by_chat: HashMap<i64, Live>,
    /// The last report for an agent in a folder, outliving its session.
    last: HashMap<(String, String), Live>,
}

fn store() -> &'static Mutex<Store> {
    static STORE: OnceLock<Mutex<Store>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Store::default()))
}

fn changed(app: &tauri::AppHandle, chat: i64) {
    let _ = app.emit("slash://changed", chat);
}

/// Update what a chat's session reported, remember it as the agent's latest for that folder, and tell the window.
fn update(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, edit: impl FnOnce(&mut Live)) {
    {
        let mut store = store().lock().unwrap();
        let live = store.by_chat.entry(chat).or_default();
        edit(live);
        let snapshot = Live { refresh_queued: false, ..live.clone() };
        store.last.insert((agent.to_string(), cwd.to_string()), snapshot);
    }
    changed(app, chat);
}

/// Claude Code's `initialize` answer or a `commands_changed` message: every command, described.
pub(crate) fn claude_commands(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, commands: &serde_json::Value) {
    let raw = claude::parse_commands(commands);
    update(app, chat, agent, cwd, |live| live.raw = raw);
}

/// A turn's `init` from Claude Code.
pub(crate) fn claude_init(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, init: &serde_json::Value) {
    let init = claude::parse_init(init);
    update(app, chat, agent, cwd, |live| {
        live.names = init.names;
        live.skills = init.skills;
        live.plugins = init.plugins;
        live.hidden = init.terminal_only;
        if !init.servers.is_empty() {
            // A turn's `init` has statuses but no tool lists: keep the counts `mcp_status` gave.
            let before = std::mem::take(&mut live.servers);
            live.servers = init
                .servers
                .into_iter()
                .map(|s| McpServer { tools: s.tools.or_else(|| before.iter().find(|b| b.name == s.name).and_then(|b| b.tools)), ..s })
                .collect();
            live.servers_known = true;
        }
    });
}

/// Claude Code's `mcp_status` answer.
pub(crate) fn claude_mcp_status(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, response: &serde_json::Value) {
    update(app, chat, agent, cwd, |live| {
        live.servers = claude::parse_mcp_status(response, &live.servers);
        live.servers_known = true;
    });
}

/// MCP servers connecting changes what's available; ask for their status once the burst settles.
pub(crate) fn queue_mcp_refresh(app: &tauri::AppHandle, chat: i64) {
    {
        let mut store = store().lock().unwrap();
        let Some(live) = store.by_chat.get_mut(&chat) else { return };
        if live.refresh_queued {
            return;
        }
        live.refresh_queued = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(MCP_REFRESH_DELAY);
        if let Some(live) = store().lock().unwrap().by_chat.get_mut(&chat) {
            live.refresh_queued = false;
        }
        crate::chat::request_mcp_status(&app, chat);
    });
}

/// Codex or OpenCode reported their commands.
pub(crate) fn provider_commands(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, items: Vec<SlashItem>) {
    update(app, chat, agent, cwd, |live| live.items = items);
}

/// Codex reported its MCP servers.
pub(crate) fn provider_servers(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, servers: Vec<McpServer>) {
    update(app, chat, agent, cwd, |live| {
        live.servers = servers;
        live.servers_known = true;
    });
}

/// Codex said a server is starting, ready or failed: it stands over what the server list says.
pub(crate) fn provider_startup(app: &tauri::AppHandle, chat: i64, agent: &str, cwd: &str, name: &str, status: McpStatus, error: Option<String>) {
    update(app, chat, agent, cwd, |live| {
        live.startup.insert(name.to_string(), (status, error));
    });
}

/// Ask `refresh` to re-list a provider's servers once a burst of startup notices settles.
pub(crate) fn queue_provider_refresh(chat: i64, refresh: impl FnOnce() + Send + 'static) {
    {
        let mut store = store().lock().unwrap();
        let Some(live) = store.by_chat.get_mut(&chat) else { return };
        if live.refresh_queued {
            return;
        }
        live.refresh_queued = true;
    }
    std::thread::spawn(move || {
        std::thread::sleep(MCP_REFRESH_DELAY);
        if let Some(live) = store().lock().unwrap().by_chat.get_mut(&chat) {
            live.refresh_queued = false;
        }
        refresh();
    });
}

/// A chat's session ended: what it reported stays as the agent's latest, but its servers' status no longer holds.
pub(crate) fn ended(chat: i64) {
    store().lock().unwrap().by_chat.remove(&chat);
}

const GROUP_ORDER: [SlashSource; 6] = [SlashSource::Project, SlashSource::User, SlashSource::Plugin, SlashSource::Synced, SlashSource::Mcp, SlashSource::Provider];

fn sort(items: &mut [SlashItem]) {
    items.sort_by_key(|i| (GROUP_ORDER.iter().position(|s| *s == i.source), i.origin.to_lowercase(), i.name.to_lowercase()));
}

/// Commands Claude Code always has in a chat, for a chat whose session hasn't said yet.
fn claude_basics() -> Vec<SlashItem> {
    let basic = |name: &str, description: &str, hint: &str| SlashItem {
        name: name.into(),
        description: description.into(),
        hint: hint.into(),
        kind: SlashKind::Builtin,
        source: SlashSource::Provider,
        origin: String::new(),
    };
    vec![basic("compact", "Free up context by summarizing the conversation so far", "<optional instructions>"), basic("context", "Show how much of the context window is in use", "")]
}

fn disk_for(kind: &str, cwd: &str) -> disk::Disk {
    let home = std::env::var("HOME").unwrap_or_default();
    let (home, cwd) = (Path::new(&home), Path::new(cwd));
    match kind {
        "claude-code" => disk::scan_claude(home, cwd),
        "codex" => disk::scan_codex(home, cwd),
        "opencode" => disk::scan_opencode(home, cwd),
        _ => disk::Disk::default(),
    }
}

/// The catalog from what a session reported (`live`), filled in from disk where it hasn't said.
fn assemble(kind: &str, live: Option<&Live>, running: bool, disk: disk::Disk) -> SlashCatalog {
    let mut items = match (kind, live) {
        ("claude-code", Some(live)) => {
            let skills: HashSet<String> = live.skills.iter().cloned().chain(disk.items.iter().filter(|i| i.kind == SlashKind::Skill).map(|i| i.name.clone())).collect();
            let raw: Vec<RawCommand> = if live.raw.is_empty() {
                live.names
                    .iter()
                    .map(|n| {
                        let known = disk.items.iter().find(|i| &i.name == n);
                        RawCommand { name: n.clone(), description: known.map(|i| i.description.clone()).unwrap_or_default(), hint: known.map(|i| i.hint.clone()).unwrap_or_default(), builtin: false }
                    })
                    .collect()
            } else {
                live.raw.clone()
            };
            claude::build_items(&raw, &skills, &live.plugins, &live.hidden, &live.servers)
        }
        ("claude-code", None) => disk.items.iter().cloned().chain(claude_basics()).collect(),
        // The provider lists commands without saying where they came from; the disk scan knows some.
        (_, Some(live)) if !live.items.is_empty() => live
            .items
            .iter()
            .map(|i| match disk.items.iter().find(|d| d.name == i.name) {
                Some(d) if i.source == SlashSource::Provider => SlashItem { kind: d.kind, source: d.source, origin: d.origin.clone(), hint: if i.hint.is_empty() { d.hint.clone() } else { i.hint.clone() }, ..i.clone() },
                _ => i.clone(),
            })
            .collect(),
        _ => disk.items.clone(),
    };
    // Whatever an engine lists, these never reach it: the menu has no use for them (see `session_command`).
    items.retain(|i| session_command(&format!("/{}", i.name)).is_none());
    sort(&mut items);
    let servers = match live {
        Some(live) if running && kind == "codex" => with_startup(live, &disk.servers),
        Some(live) if live.servers_known && running => live.servers.clone(),
        _ => disk.servers,
    };
    SlashCatalog { items, servers, live: running }
}

/// A running session's server list, completed from the config on disk and updated by startup notices.
/// Codex's list leaves out how a server connects and where it came from, and its `startupStatus`
/// notices say what the list can't (starting, ready, why it failed); before the list arrives they
/// colour the configured servers.
fn with_startup(live: &Live, configured: &[McpServer]) -> Vec<McpServer> {
    let base: &[McpServer] = if live.servers_known { &live.servers } else { configured };
    base.iter()
        .map(|s| {
            let mut s = s.clone();
            if let Some(known) = configured.iter().find(|c| c.name == s.name) {
                if s.transport.is_empty() {
                    s.transport = known.transport.clone();
                }
                if s.source == "user" || s.source.is_empty() {
                    s.source = known.source.clone();
                }
            } else if s.source == "user" {
                s.source = "built-in".into();
            }
            if let Some((status, error)) = live.startup.get(&s.name) {
                s.status = *status;
                s.error = error.clone();
            }
            s
        })
        .collect()
}

/// What the slash menu offers for an agent's chat. `chat` is the conversation when it has one.
pub(crate) fn catalog(app: &tauri::AppHandle, agent: &str, chat: Option<i64>, cwd: &str) -> SlashCatalog {
    let kind = crate::prompts::agent_engine(app, agent).kind;
    let (live, running) = {
        let store = store().lock().unwrap();
        match chat.and_then(|c| store.by_chat.get(&c)) {
            Some(live) => (Some(live.clone()), true),
            None => (store.last.get(&(agent.to_string(), cwd.to_string())).cloned(), false),
        }
    };
    let disk = disk_for(&kind, cwd);
    assemble(&kind, live.as_ref(), running, disk)
}

/// The command a message starts with, if it names one the agent has (`/review the diff` → `review`).
pub(crate) fn command_of(app: &tauri::AppHandle, agent: &str, chat: i64, cwd: &str, text: &str) -> Option<String> {
    let name = typed_command(text)?;
    catalog(app, agent, Some(chat), cwd).items.iter().any(|i| i.name == name).then_some(name)
}

/// Commands that start the chat over: Claude Code's `/clear` and its aliases, OpenCode's `/new`.
/// Starkline answers them with a new chat of its own; they never reach the engine.
const NEW_CHAT_COMMANDS: &[&str] = &["clear", "reset", "new"];

/// Commands that swap, rewind or end the engine's session while Starkline keeps showing the
/// old one (a resumed or branched session, an undone turn, an exited process). Claude Code's
/// `/resume` `/branch` `/rewind` `/exit` `/background` and their aliases, OpenCode's
/// `/sessions` `/undo` `/redo` `/exit`. They are never sent, and are left out of the menu.
const BLOCKED_COMMANDS: &[&str] = &["resume", "continue", "sessions", "branch", "rewind", "checkpoint", "undo", "redo", "exit", "quit", "background", "bg"];

/// How Starkline treats a message that opens with a command that would swap or reset the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SessionCommand {
    /// Start a new chat instead.
    NewChat(String),
    /// Refuse it.
    Blocked(String),
}

/// The session-swapping command a message opens with, as typed (`/Clear` → `Clear`), if it does.
pub(crate) fn session_command(text: &str) -> Option<SessionCommand> {
    let name = typed_command(text.trim_start())?;
    let is = |list: &[&str]| list.iter().any(|c| c.eq_ignore_ascii_case(&name));
    if is(NEW_CHAT_COMMANDS) {
        Some(SessionCommand::NewChat(name))
    } else if is(BLOCKED_COMMANDS) {
        Some(SessionCommand::Blocked(name))
    } else {
        None
    }
}

/// Refuse a message that would make the engine swap or reset the chat's session behind Starkline's back.
pub(crate) fn refuse_session_command(text: &str) -> Result<(), String> {
    match session_command(text) {
        None => Ok(()),
        Some(SessionCommand::NewChat(name)) => Err(format!("/{name} would swap this chat's session behind Starkline's back, so it isn't sent. Start a new chat instead.")),
        Some(SessionCommand::Blocked(name)) => Err(format!("/{name} would change or end this chat's session behind Starkline's back, so it isn't sent.")),
    }
}

/// The word after a leading slash, if the message opens with something shaped like a command name.
fn typed_command(text: &str) -> Option<String> {
    let word = text.strip_prefix('/')?.split(char::is_whitespace).next()?;
    let valid = !word.is_empty() && word.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'));
    valid.then(|| word.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(name: &str, status: McpStatus) -> McpServer {
        McpServer { name: name.into(), status, source: "user".into(), tools: Some(2), error: None, transport: "stdio".into() }
    }

    #[test]
    fn a_fresh_chat_offers_what_is_on_disk_and_a_running_one_what_it_reported() {
        let mut disk = disk::Disk::default();
        disk.items.push(SlashItem { name: "pdf".into(), description: "PDFs".into(), hint: String::new(), kind: SlashKind::Skill, source: SlashSource::User, origin: String::new() });
        disk.servers.push(McpServer { status: McpStatus::Unknown, ..server("docs", McpStatus::Unknown) });
        let fresh = assemble("claude-code", None, false, disk::Disk { items: disk.items.clone(), servers: disk.servers.clone() });
        let names: Vec<&str> = fresh.items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!((names, fresh.live, fresh.servers[0].status), (vec!["pdf", "compact", "context"], false, McpStatus::Unknown));

        let live = Live {
            raw: vec![RawCommand { name: "pdf".into(), description: "Read PDFs (user)".into(), ..Default::default() }, RawCommand { name: "clear".into(), builtin: true, ..Default::default() }],
            skills: vec!["pdf".into()],
            servers: vec![server("docs", McpStatus::Connected)],
            servers_known: true,
            ..Default::default()
        };
        let running = assemble("claude-code", Some(&live), true, disk);
        assert_eq!(running.items.len(), 1);
        assert_eq!((running.items[0].description.as_str(), running.items[0].kind), ("Read PDFs", SlashKind::Skill));
        assert_eq!((running.live, running.servers[0].status), (true, McpStatus::Connected));
    }

    #[test]
    fn a_session_that_ended_leaves_its_commands_but_not_its_server_status() {
        let live = Live { raw: vec![RawCommand { name: "hello".into(), description: "Hi (project)".into(), ..Default::default() }], servers: vec![server("docs", McpStatus::Connected)], servers_known: true, ..Default::default() };
        let mut disk = disk::Disk::default();
        disk.servers.push(server("docs", McpStatus::Unknown));
        let catalog = assemble("claude-code", Some(&live), false, disk);
        assert_eq!(catalog.items[0].name, "hello");
        assert_eq!(catalog.servers[0].status, McpStatus::Unknown);
    }

    #[test]
    fn codex_servers_take_their_status_from_startup_notices_and_their_transport_from_the_config() {
        let listed = |name: &str, source: &str, status: McpStatus| McpServer { name: name.into(), status, source: source.into(), tools: Some(1), error: None, transport: String::new() };
        let disk = || disk::Disk { servers: vec![McpServer { transport: "stdio".into(), ..server("context7", McpStatus::Unknown) }], ..Default::default() };
        let mut live = Live {
            servers: vec![listed("context7", "user", McpStatus::Unknown), listed("codex_apps", "user", McpStatus::Connected), listed("goldie", "plugin", McpStatus::Unknown)],
            servers_known: true,
            ..Default::default()
        };
        live.startup.insert("context7".into(), (McpStatus::Connected, None));
        live.startup.insert("goldie".into(), (McpStatus::Failed, Some("boom".into())));
        let got = assemble("codex", Some(&live), true, disk()).servers;
        let view: Vec<(&str, McpStatus, &str, &str, Option<&str>)> = got.iter().map(|s| (s.name.as_str(), s.status, s.source.as_str(), s.transport.as_str(), s.error.as_deref())).collect();
        assert_eq!(
            view,
            vec![("context7", McpStatus::Connected, "user", "stdio", None), ("codex_apps", McpStatus::Connected, "built-in", "", None), ("goldie", McpStatus::Failed, "plugin", "", Some("boom"))]
        );

        // Notices that arrive before the list colour the configured servers.
        let early = Live { startup: live.startup.clone(), ..Default::default() };
        let got = assemble("codex", Some(&early), true, disk()).servers;
        assert_eq!((got[0].name.as_str(), got[0].status), ("context7", McpStatus::Connected));
    }

    #[test]
    fn commands_that_swap_the_session_are_caught_by_name_and_never_sent() {
        for text in ["/clear", "  /clear", "/Clear", "/reset now", "/new\nmore"] {
            assert!(matches!(session_command(text), Some(SessionCommand::NewChat(_))), "{text}");
            assert!(refuse_session_command(text).is_err(), "{text}");
        }
        for text in ["/resume", "/continue abc", "/sessions", "/branch x", "/rewind", "/checkpoint", "/undo", "/redo", "/exit", "/quit", "/background", "/bg"] {
            assert!(matches!(session_command(text), Some(SessionCommand::Blocked(_))), "{text}");
            assert!(refuse_session_command(text).is_err(), "{text}");
        }
        // /compact works; only a leading whole command word counts.
        for text in ["/compact", "/clearly", "/new/file", "/review", "clear the cache", "please /clear", "/", ""] {
            assert_eq!(session_command(text), None, "{text}");
            assert!(refuse_session_command(text).is_ok(), "{text}");
        }
    }

    #[test]
    fn every_engine_hides_the_commands_it_will_not_send() {
        let live = Live {
            items: ["compact", "new", "clear", "sessions", "undo", "review"].map(|n| SlashItem { name: n.into(), description: String::new(), hint: String::new(), kind: SlashKind::Builtin, source: SlashSource::Provider, origin: String::new() }).to_vec(),
            ..Default::default()
        };
        for kind in ["opencode", "codex"] {
            let names: Vec<String> = assemble(kind, Some(&live), true, disk::Disk::default()).items.into_iter().map(|i| i.name).collect();
            assert_eq!(names, vec!["compact", "review"], "{kind}");
        }
    }

    #[test]
    fn only_a_leading_slash_word_counts_as_a_command() {
        assert_eq!(typed_command("/review the diff").as_deref(), Some("review"));
        assert_eq!(typed_command("/sarathi:review").as_deref(), Some("sarathi:review"));
        assert_eq!(typed_command("/mcp__docs__sum\nmore").as_deref(), Some("mcp__docs__sum"));
        assert_eq!(typed_command("/").as_deref(), None);
        assert_eq!(typed_command("/etc/hosts?").as_deref(), None);
        assert_eq!(typed_command("look at /review").as_deref(), None);
    }

    #[test]
    fn opencode_commands_are_labelled_by_where_the_disk_scan_finds_them() {
        let home = std::env::temp_dir().join(format!("starkline-oc-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        for (dir, name) in [(".agents/skills", "pdf"), (".claude/skills/synced/abc", "docx")] {
            let folder = home.join(dir).join(name);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("SKILL.md"), format!("---\nname: {name}\ndescription: The {name} skill\n---\n")).unwrap();
        }
        let reply: serde_json::Value = serde_json::from_str(include_str!("fixtures/opencode-available-commands.json")).unwrap();
        let live = Live { items: acp_commands(&reply["params"]["update"]), ..Default::default() };
        assert_eq!(live.items.len(), 75);
        let cwd = std::env::temp_dir().join("starkline-oc-no-project");
        let catalog = assemble("opencode", Some(&live), true, disk::scan_opencode(&home, &cwd));
        let of = |name: &str| catalog.items.iter().find(|i| i.name == name).map(|i| (i.kind, i.source));
        // A skill OpenCode lists as a command is the developer's, not the provider's.
        assert_eq!(of("pdf"), Some((SlashKind::Skill, SlashSource::User)));
        assert_eq!(of("docx"), Some((SlashKind::Skill, SlashSource::User)));
        // The ones nothing on disk accounts for are OpenCode's own.
        assert_eq!(of("review"), Some((SlashKind::Command, SlashSource::Provider)));
        assert_eq!(of("init"), Some((SlashKind::Command, SlashSource::Provider)));
        let _ = std::fs::remove_dir_all(&home);
    }
}
