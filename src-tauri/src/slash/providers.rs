//! What Codex (app server) and OpenCode (ACP) say about their commands and MCP servers.

use super::{McpServer, McpStatus, SlashItem, SlashKind, SlashSource};
use serde_json::Value;

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn clip(s: &str) -> String {
    crate::chat::truncate(&s.split_whitespace().collect::<Vec<_>>().join(" "), 240)
}

/// Codex's `skills/list` answer: the enabled skills, by where Codex found them.
pub(crate) fn codex_skills(reply: &Value) -> Vec<SlashItem> {
    reply["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .filter(|s| s["enabled"].as_bool().unwrap_or(true))
        .map(|s| {
            let plugin = s["pluginId"].as_str().map(|id| id.split('@').next().unwrap_or(id).to_string());
            let source = match (plugin.is_some(), text(s, "scope")) {
                (true, _) => SlashSource::Plugin,
                (_, "repo") => SlashSource::Project,
                (_, "user") => SlashSource::User,
                _ => SlashSource::Provider,
            };
            let description = Some(text(s, "description")).filter(|d| !d.is_empty()).or_else(|| s["interface"]["shortDescription"].as_str()).or_else(|| s["shortDescription"].as_str());
            SlashItem {
                name: text(s, "name").to_string(),
                description: clip(description.unwrap_or("")),
                hint: String::new(),
                kind: SlashKind::Skill,
                source,
                origin: plugin.unwrap_or_default(),
            }
        })
        .filter(|i| !i.name.is_empty())
        .collect()
}

/// Where a Codex skill's `SKILL.md` is, for attaching it to a turn: (name, path).
pub(crate) fn codex_skill_paths(reply: &Value) -> Vec<(String, String)> {
    reply["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .filter(|s| s["enabled"].as_bool().unwrap_or(true))
        .map(|s| (text(s, "name").to_string(), text(s, "path").to_string()))
        .filter(|(name, path)| !name.is_empty() && !path.is_empty())
        .collect()
}

/// Codex's `mcpServerStatus/list` answer. It says who a server is and how it signs in, not
/// whether it is running: a server that listed tools or introduced itself is up, one that
/// isn't signed in and has nothing to show says so, and the rest wait for `mcpServer/startupStatus/updated` (`codex_startup`).
/// Whether it is a local process or a remote URL isn't in the answer; `http` is read off the way
/// it signs in, and `assemble` fills in the rest from `~/.codex/config.toml`.
pub(crate) fn codex_servers(reply: &Value) -> Vec<McpServer> {
    reply["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let auth = text(s, "authStatus");
            let tools = s["tools"].as_object().map(|t| t.len() as u32);
            let status = match auth {
                _ if tools.is_some_and(|t| t > 0) || s["serverInfo"].is_object() => McpStatus::Connected,
                "notLoggedIn" => McpStatus::NeedsAuth,
                _ => McpStatus::Unknown,
            };
            McpServer {
                name: text(s, "name").to_string(),
                status,
                source: if s["pluginId"].is_null() { "user".into() } else { "plugin".into() },
                tools,
                error: None,
                transport: if matches!(auth, "oAuth" | "bearerToken" | "notLoggedIn") { "http".into() } else { String::new() },
            }
        })
        .filter(|s| !s.name.is_empty())
        .collect()
}

/// What one `mcpServer/startupStatus/updated` says about a server: its status and, if it failed, why.
pub(crate) fn codex_startup(params: &Value) -> Option<(String, McpStatus, Option<String>)> {
    let name = text(params, "name");
    let error = params["error"].as_str().filter(|e| !e.is_empty());
    let signed_out = text(params, "failureReason") == "reauthenticationRequired" || error.is_some_and(|e| e.contains("not logged in"));
    let status = match text(params, "status") {
        "starting" => McpStatus::Pending,
        "ready" => McpStatus::Connected,
        "failed" if signed_out => McpStatus::NeedsAuth,
        "failed" => McpStatus::Failed,
        "cancelled" => McpStatus::Unknown,
        _ => return None,
    };
    let error = error.filter(|_| matches!(status, McpStatus::Failed | McpStatus::NeedsAuth)).map(|e| crate::chat::truncate(e.lines().next().unwrap_or(e), 200));
    (!name.is_empty()).then(|| (name.to_string(), status, error))
}

/// ACP's `available_commands_update`: each command with its input hint. ACP doesn't say where a
/// command came from, so they're the provider's until the disk scan recognises one.
pub(crate) fn acp_commands(update: &Value) -> Vec<SlashItem> {
    update["availableCommands"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| SlashItem {
            name: text(c, "name").trim_start_matches('/').to_string(),
            description: clip(text(c, "description")),
            hint: c["input"]["hint"].as_str().unwrap_or("").to_string(),
            kind: SlashKind::Command,
            source: SlashSource::Provider,
            origin: String::new(),
        })
        .filter(|i| !i.name.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_skills_read_as_the_app_server_sends_them() {
        let skills = json!({ "data": [{ "cwd": "/p", "errors": [], "skills": [
            { "name": "pdf", "description": "Read PDFs", "path": "/s/pdf/SKILL.md", "scope": "user", "enabled": true, "pluginId": null },
            { "name": "lint", "description": "", "interface": { "shortDescription": "Lint it" }, "path": "/p/.agents/skills/lint/SKILL.md", "scope": "repo", "enabled": true },
            { "name": "off", "description": "x", "path": "/o", "scope": "user", "enabled": false },
            { "name": "deploy", "description": "Ship", "path": "/d", "scope": "user", "enabled": true, "pluginId": "ops@market" }
        ] }] });
        let items = codex_skills(&skills);
        let got: Vec<(&str, &str, SlashSource, &str)> = items.iter().map(|i| (i.name.as_str(), i.description.as_str(), i.source, i.origin.as_str())).collect();
        assert_eq!(got, vec![("pdf", "Read PDFs", SlashSource::User, ""), ("lint", "Lint it", SlashSource::Project, ""), ("deploy", "Ship", SlashSource::Plugin, "ops")]);
        assert_eq!(codex_skill_paths(&skills)[0], ("pdf".to_string(), "/s/pdf/SKILL.md".to_string()));

    }

    #[test]
    fn codex_skills_read_as_codex_0_148_sends_them() {
        let reply = captured(include_str!("fixtures/codex-skills-list.json"));
        let items = codex_skills(&reply["result"]);
        let got: Vec<(&str, SlashSource, SlashKind)> = items.iter().map(|i| (i.name.as_str(), i.source, i.kind)).collect();
        // Codex's own skills have the scope "system".
        assert_eq!(got, vec![("starkcheck", SlashSource::Project, SlashKind::Skill), ("anthropic-skills:brainstorming", SlashSource::User, SlashKind::Skill), ("imagegen", SlashSource::Provider, SlashKind::Skill)]);
        assert!(items.iter().all(|i| !i.description.is_empty()));
        let paths = codex_skill_paths(&reply["result"]);
        assert_eq!(paths[0], ("starkcheck".to_string(), "/private/tmp/veronica-slash/proj/.agents/skills/starkcheck/SKILL.md".to_string()));
    }

    fn captured(file: &str) -> Value {
        serde_json::from_str(file).unwrap()
    }

    #[test]
    fn codex_servers_read_as_codex_0_148_sends_them() {
        let servers = codex_servers(&captured(include_str!("fixtures/codex-mcp-status-list.json")));
        let got: Vec<(&str, McpStatus, Option<u32>, &str, &str)> = servers.iter().map(|s| (s.name.as_str(), s.status, s.tools, s.source.as_str(), s.transport.as_str())).collect();
        assert_eq!(
            got,
            vec![
                ("argent", McpStatus::Connected, Some(77), "plugin", ""),
                ("code-review", McpStatus::Unknown, Some(0), "plugin", ""),
                ("codex_app", McpStatus::Unknown, Some(0), "plugin", ""),
                ("codex_apps", McpStatus::Connected, Some(179), "user", "http"),
                ("computer-use", McpStatus::Unknown, Some(0), "user", ""),
                ("context7", McpStatus::Connected, Some(2), "user", ""),
                ("cua_repl", McpStatus::Connected, Some(3), "plugin", ""),
                ("node_repl", McpStatus::Connected, Some(4), "user", ""),
                ("panchayat-local", McpStatus::Unknown, Some(0), "user", "http"),
                ("pika-mcp", McpStatus::NeedsAuth, Some(0), "user", "http"),
                ("stitch", McpStatus::Connected, Some(15), "user", "http"),
            ]
        );
        assert!(servers.iter().all(|s| s.error.is_none()));
    }

    #[test]
    fn codex_startup_notifications_say_starting_ready_or_why_not() {
        let events: Vec<Value> = captured(include_str!("fixtures/codex-mcp-startup.json")).as_array().unwrap().iter().map(|m| m["params"].clone()).collect();
        let states: Vec<(String, McpStatus, Option<String>)> = events.iter().filter_map(codex_startup).collect();
        assert_eq!(states.len(), events.len());
        let of = |name: &str, status: McpStatus| states.iter().find(|(n, s, _)| n == name && *s == status);
        assert!(of("argent", McpStatus::Pending).is_some());
        assert!(of("argent", McpStatus::Connected).is_some());
        let (_, _, error) = of("pika-mcp", McpStatus::NeedsAuth).unwrap();
        assert!(error.as_deref().unwrap().contains("not logged in"));
        let (_, _, error) = of("panchayat-local", McpStatus::Failed).unwrap();
        let error = error.as_deref().unwrap();
        assert!(error.starts_with("MCP client for `panchayat-local` failed to start"), "{error}");
        assert!(!error.contains('\n'));
        assert_eq!(codex_startup(&json!({ "name": "x", "status": "failed", "error": "token", "failureReason": "reauthenticationRequired" })).unwrap().1, McpStatus::NeedsAuth);
        assert_eq!(codex_startup(&json!({ "name": "x", "status": "ready", "error": "stale" })).unwrap(), ("x".into(), McpStatus::Connected, None));
        assert_eq!(codex_startup(&json!({ "name": "x", "status": "cancelled" })).unwrap().1, McpStatus::Unknown);
        assert!(codex_startup(&json!({ "name": "x", "status": "mystery" })).is_none());
        assert!(codex_startup(&json!({ "status": "ready" })).is_none());
    }

    #[test]
    fn acp_commands_keep_their_input_hint() {
        let items = acp_commands(&json!({ "sessionUpdate": "available_commands_update", "availableCommands": [
            { "name": "compact", "description": "Compact the session" },
            { "name": "/review", "description": "Review", "input": { "hint": "what to review" } }
        ] }));
        assert_eq!((items[0].name.as_str(), items[0].hint.as_str()), ("compact", ""));
        assert_eq!((items[1].name.as_str(), items[1].hint.as_str()), ("review", "what to review"));
    }
}
