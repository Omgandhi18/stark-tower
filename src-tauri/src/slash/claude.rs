//! What Claude Code tells a stream-json session about itself: the `initialize` control
//! response and `commands_changed` (every command with its description), each turn's
//! `init` (names, skills, plugins, MCP servers), and the `mcp_status` control response.

use super::{McpServer, McpStatus, SlashItem, SlashKind, SlashSource};
use serde_json::Value;
use std::collections::HashSet;

/// Claude's own commands that change the session itself, or that need a terminal. They'd
/// fight what Starkline already manages (model, effort, sessions) or can't be answered
/// from a chat, so the menu leaves them out.
const SESSION_COMMANDS: &[&str] = &[
    "clear", "reset", "new", "model", "effort", "fast", "config", "settings", "output-style", "color", "focus", "autocompact", "heapdump", "import", "rename", "name", "agents",
    "reload-plugins", "reload-skills", "doctor", "checkup", "mcp", "ultrareview", "usage-credits", "extra-usage", "team-onboarding", "insights", "design", "design-consent",
    "design-revoke", "list-agents", "peers", "auto-mode-setup",
];

/// How Claude labels where a command came from, at the end of its description.
const SUFFIXES: [(&str, SlashSource); 3] = [(" (user)", SlashSource::User), (" (project)", SlashSource::Project), (" (claude.ai sync)", SlashSource::Synced)];

/// One command as Claude reports it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct RawCommand {
    pub name: String,
    pub description: String,
    pub hint: String,
    pub builtin: bool,
}

/// What a turn's `init` says.
#[derive(Debug, Default)]
pub(crate) struct Init {
    pub names: Vec<String>,
    pub skills: Vec<String>,
    pub plugins: Vec<String>,
    pub terminal_only: Vec<String>,
    pub servers: Vec<McpServer>,
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

/// The `commands` array of an `initialize` response or a `commands_changed` message.
pub(crate) fn parse_commands(v: &Value) -> Vec<RawCommand> {
    v.as_array()
        .map(|all| {
            all.iter()
                .filter_map(|c| {
                    Some(RawCommand {
                        name: c["name"].as_str()?.to_string(),
                        description: c["description"].as_str().unwrap_or("").to_string(),
                        hint: c["argumentHint"].as_str().unwrap_or("").to_string(),
                        builtin: c["builtin"].as_bool().unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(crate) fn parse_init(v: &Value) -> Init {
    Init {
        names: strings(&v["slash_commands"]),
        skills: strings(&v["skills"]),
        plugins: v["plugins"].as_array().map(|p| p.iter().filter_map(|p| p["name"].as_str().map(str::to_string)).collect()).unwrap_or_default(),
        terminal_only: strings(&v["terminal_slash_commands"]),
        servers: v["mcp_servers"].as_array().map(|s| s.iter().filter_map(|s| server(s, None)).collect()).unwrap_or_default(),
    }
}

fn status_of(s: &str) -> McpStatus {
    match s {
        "connected" => McpStatus::Connected,
        "pending" => McpStatus::Pending,
        "needs-auth" => McpStatus::NeedsAuth,
        "disabled" => McpStatus::Disabled,
        "failed" => McpStatus::Failed,
        _ => McpStatus::Unknown,
    }
}

fn source_of(s: &str) -> String {
    if s == "claudeai" { "claude.ai".into() } else { s.to_string() }
}

/// One MCP server as `init` or `mcp_status` lists it. Its config (commands, URLs, headers)
/// can hold keys, so only its transport is kept.
fn server(s: &Value, previous: Option<&McpServer>) -> Option<McpServer> {
    let tools = s["tools"].as_array().map(|t| t.len() as u32).or(previous.and_then(|p| p.tools));
    Some(McpServer {
        name: s["name"].as_str()?.to_string(),
        status: status_of(s["status"].as_str().unwrap_or("")),
        source: s["source"].as_str().or(s["scope"].as_str()).map(source_of).unwrap_or_default(),
        tools,
        error: s["error"].as_str().filter(|e| !e.is_empty()).map(|e| crate::chat::truncate(e, 200)),
        transport: s["config"]["type"].as_str().map(str::to_string).or(previous.map(|p| p.transport.clone())).unwrap_or_default(),
    })
}

/// The `mcpServers` of an `mcp_status` control response; tool counts carry over from `before` when a server lists none.
pub(crate) fn parse_mcp_status(v: &Value, before: &[McpServer]) -> Vec<McpServer> {
    v["mcpServers"].as_array().map(|all| all.iter().filter_map(|s| server(s, before.iter().find(|b| Some(b.name.as_str()) == s["name"].as_str()))).collect()).unwrap_or_default()
}

/// A server name the way it appears inside an `mcp__server__prompt` command: anything but letters and digits becomes `_`.
fn mcp_key(name: &str) -> String {
    name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect()
}

/// The commands the menu offers: classified by where they came from, with the session's own
/// and terminal-only ones left out.
pub(crate) fn build_items(raw: &[RawCommand], skills: &HashSet<String>, plugins: &[String], hidden: &[String], servers: &[McpServer]) -> Vec<SlashItem> {
    raw.iter()
        .filter(|c| !c.name.starts_with("__") && !c.name.ends_with("-exec") && !hidden.contains(&c.name))
        .filter(|c| !(c.builtin && SESSION_COMMANDS.contains(&c.name.as_str())))
        .map(|c| {
            let mut description = c.description.trim().to_string();
            let mut item = SlashItem { name: c.name.clone(), description: String::new(), hint: c.hint.clone(), kind: SlashKind::Command, source: SlashSource::User, origin: String::new() };
            if let Some(rest) = c.name.strip_prefix("mcp__") {
                let key = rest.split("__").next().unwrap_or(rest);
                item.kind = SlashKind::Prompt;
                item.source = SlashSource::Mcp;
                item.origin = servers.iter().find(|s| mcp_key(&s.name) == key).map_or_else(|| key.to_string(), |s| s.name.clone());
            } else if c.builtin {
                item.kind = SlashKind::Builtin;
                item.source = SlashSource::Provider;
                if let Some(rest) = description.strip_suffix(" (dynamic workflow)") {
                    description = rest.to_string();
                }
            } else {
                for (suffix, source) in SUFFIXES {
                    if let Some(rest) = description.strip_suffix(suffix) {
                        item.source = source;
                        description = rest.trim_end().to_string();
                        break;
                    }
                }
                if let Some((plugin, _)) = c.name.split_once(':') {
                    if plugins.iter().any(|p| p == plugin) {
                        item.source = SlashSource::Plugin;
                        item.origin = plugin.to_string();
                    } else if plugin == "anthropic-skills" {
                        item.source = SlashSource::Synced;
                    }
                }
                item.kind = if skills.contains(&c.name) || item.source == SlashSource::Synced { SlashKind::Skill } else { SlashKind::Command };
            }
            item.description = crate::chat::truncate(&description.split_whitespace().collect::<Vec<_>>().join(" "), 240);
            item
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn raw(name: &str, description: &str, builtin: bool) -> RawCommand {
        RawCommand { name: name.into(), description: description.into(), hint: String::new(), builtin }
    }

    #[test]
    fn commands_are_told_apart_by_where_claude_says_they_came_from() {
        let servers = vec![McpServer { name: "claude.ai Vercel".into(), status: McpStatus::Connected, source: "claude.ai".into(), tools: Some(3), error: None, transport: String::new() }];
        let skills: HashSet<String> = ["pdf".to_string(), "sarathi:review".to_string()].into();
        let items = build_items(
            &[
                raw("pdf", "Read PDFs (user)", false),
                raw("hello", "Say hello (project)", false),
                raw("sarathi:review", "Review code", false),
                raw("docs", "Write docs (claude.ai sync)", false),
                raw("mcp__claude_ai_Vercel__quick_status", "Quick status", false),
                raw("compact", "Summarize the conversation", true),
                raw("simplify", "Clean up the changed code (dynamic workflow)", true),
                raw("clear", "Start over", true),
                raw("mcp", "Manage MCP servers", true),
                raw("__remote-workflow", "internal", true),
                raw("color", "Prompt bar colour", false),
            ],
            &skills,
            &["sarathi".to_string()],
            &["color".to_string()],
            &servers,
        );
        let got: Vec<(&str, SlashKind, SlashSource, &str, &str)> = items.iter().map(|i| (i.name.as_str(), i.kind, i.source, i.origin.as_str(), i.description.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("pdf", SlashKind::Skill, SlashSource::User, "", "Read PDFs"),
                ("hello", SlashKind::Command, SlashSource::Project, "", "Say hello"),
                ("sarathi:review", SlashKind::Skill, SlashSource::Plugin, "sarathi", "Review code"),
                ("docs", SlashKind::Skill, SlashSource::Synced, "", "Write docs"),
                ("mcp__claude_ai_Vercel__quick_status", SlashKind::Prompt, SlashSource::Mcp, "claude.ai Vercel", "Quick status"),
                ("compact", SlashKind::Builtin, SlashSource::Provider, "", "Summarize the conversation"),
                ("simplify", SlashKind::Builtin, SlashSource::Provider, "", "Clean up the changed code"),
            ]
        );
    }

    #[test]
    fn mcp_status_keeps_tool_counts_and_drops_the_config() {
        let before = vec![McpServer { name: "docs".into(), status: McpStatus::Pending, source: "user".into(), tools: Some(4), error: None, transport: "http".into() }];
        let status = json!({ "mcpServers": [
            { "name": "docs", "status": "connected", "scope": "user", "source": "user", "config": { "type": "http", "url": "https://x", "headers": { "k": "secret" } } },
            { "name": "db", "status": "failed", "error": "spawn ENOENT", "source": "claudeai", "tools": [{ "name": "a" }, { "name": "b" }], "config": { "type": "stdio" } },
            { "name": "crm", "status": "needs-auth", "source": "claudeai" }
        ] });
        let parsed = parse_mcp_status(&status, &before);
        assert_eq!((parsed[0].status, parsed[0].tools, parsed[0].source.as_str()), (McpStatus::Connected, Some(4), "user"));
        assert_eq!((parsed[1].status, parsed[1].tools, parsed[1].error.as_deref()), (McpStatus::Failed, Some(2), Some("spawn ENOENT")));
        assert_eq!((parsed[2].status, parsed[2].source.as_str()), (McpStatus::NeedsAuth, "claude.ai"));
        assert!(!serde_json::to_string(&parsed).unwrap().contains("secret"));
    }

    #[test]
    fn init_lists_names_skills_plugins_and_servers() {
        let init = parse_init(&json!({
            "slash_commands": ["pdf", "compact"], "skills": ["pdf"], "terminal_slash_commands": ["doctor"],
            "plugins": [{ "name": "sarathi" }], "mcp_servers": [{ "name": "a", "status": "pending", "source": "user" }]
        }));
        assert_eq!((init.names.len(), init.skills, init.plugins, init.terminal_only), (2, vec!["pdf".to_string()], vec!["sarathi".to_string()], vec!["doctor".to_string()]));
        assert_eq!(init.servers[0].status, McpStatus::Pending);
    }
}
