//! What an agent could run, read from disk, so the slash menu works on a fresh chat
//! before any session has told us. Skills (`SKILL.md` folders), custom commands
//! (markdown files), the enabled plugins' own, and each provider's MCP server config
//! (names and transport only: never the commands, URLs or keys inside it).

use super::{McpServer, McpStatus, SlashItem, SlashKind, SlashSource};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Descriptions in the menu are one or two lines; longer ones are cut here.
const DESCRIPTION_CHARS: usize = 240;

#[derive(Default)]
pub(crate) struct Disk {
    pub items: Vec<SlashItem>,
    pub servers: Vec<McpServer>,
}

/// A markdown file's `---` header as plain keys, and the text after it.
pub(crate) struct Front {
    pub keys: HashMap<String, String>,
    pub body: String,
}

fn unquote(v: &str) -> String {
    let v = v.trim();
    let quoted = v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    if quoted { v[1..v.len() - 1].to_string() } else { v.to_string() }
}

/// The few YAML shapes skill and command headers use: `key: value`, quoted values, and
/// `>`/`|` blocks or indented continuation lines.
pub(crate) fn parse_front(text: &str) -> Front {
    let text = text.trim_start_matches('\u{feff}');
    let mut keys = HashMap::new();
    let Some(rest) = text.strip_prefix("---") else { return Front { keys, body: text.to_string() } };
    let rest = rest.trim_start_matches(['\r', '\n']);
    let (header, body) = match rest.find("\n---") {
        Some(end) => (&rest[..end], rest[end + 4..].split_once('\n').map_or("", |(_, body)| body).to_string()),
        None => return Front { keys, body: text.to_string() },
    };
    let lines: Vec<&str> = header.lines().collect();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        i += 1;
        if line.starts_with(' ') || line.starts_with('\t') || line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        let mut continuation = Vec::new();
        while i < lines.len() && (lines[i].starts_with(' ') || lines[i].starts_with('\t') || lines[i].trim().is_empty()) {
            continuation.push(lines[i].trim());
            i += 1;
        }
        let block = value.starts_with('>') || value.starts_with('|');
        let joiner = if value.starts_with('|') { "\n" } else { " " };
        let first = if block { String::new() } else { unquote(value) };
        let parts: Vec<&str> = std::iter::once(first.as_str()).chain(continuation.iter().copied()).filter(|p| !p.is_empty()).collect();
        keys.insert(key.trim().to_string(), parts.join(joiner));
    }
    Front { keys, body }
}

pub(super) fn read(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

pub(super) fn clip(s: &str) -> String {
    crate::chat::truncate(&s.split_whitespace().collect::<Vec<_>>().join(" "), DESCRIPTION_CHARS)
}

pub(super) fn sorted_entries(dir: &Path) -> Vec<PathBuf> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok().map(|e| e.path())).collect()).unwrap_or_default();
    entries.sort();
    entries
}

pub(super) fn is_hidden(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()).is_none_or(|n| n.starts_with('.'))
}

/// The skill in a folder holding a `SKILL.md`. A plugin's skills read `plugin:name`.
pub(super) fn skill_item(folder: &Path, prefix: Option<&str>, source: SlashSource, origin: &str) -> Option<SlashItem> {
    let front = parse_front(&read(&folder.join("SKILL.md"))?);
    // `user-invocable: false` keeps a skill out of the slash menu.
    if front.keys.get("user-invocable").is_some_and(|v| v == "false") {
        return None;
    }
    let folder_name = folder.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    let name = front.keys.get("name").filter(|n| !n.is_empty()).map(String::as_str).unwrap_or(folder_name);
    Some(SlashItem {
        name: prefix.map_or_else(|| name.to_string(), |p| format!("{p}:{name}")),
        description: clip(front.keys.get("description").map(String::as_str).unwrap_or("")),
        hint: front.keys.get("argument-hint").cloned().unwrap_or_default(),
        kind: SlashKind::Skill,
        source,
        origin: origin.to_string(),
    })
}

/// `<dir>/<name>/SKILL.md` for every skill folder in `dir`.
pub(super) fn skills_in(dir: &Path, prefix: Option<&str>, source: SlashSource, origin: &str, out: &mut Vec<SlashItem>) {
    for folder in sorted_entries(dir).into_iter().filter(|p| p.is_dir() && !is_hidden(p)) {
        out.extend(skill_item(&folder, prefix, source, origin));
    }
}

/// The command in a markdown file, called `local` (`name`, or `folder:name` from a subfolder).
pub(super) fn command_item(path: &Path, local: &str, prefix: Option<&str>, source: SlashSource, origin: &str) -> Option<SlashItem> {
    let front = parse_front(&read(path)?);
    let first_line = front.body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().trim_start_matches('#').trim();
    Some(SlashItem {
        name: prefix.map_or(local.to_string(), |p| format!("{p}:{local}")),
        description: clip(front.keys.get("description").map(String::as_str).unwrap_or(first_line)),
        hint: front.keys.get("argument-hint").cloned().unwrap_or_default(),
        kind: SlashKind::Command,
        source,
        origin: origin.to_string(),
    })
}

/// Markdown files under `dir` as commands; a file in a subfolder reads `folder:name`.
pub(super) fn commands_in(dir: &Path, prefix: Option<&str>, source: SlashSource, origin: &str, out: &mut Vec<SlashItem>) {
    fn walk(dir: &Path, trail: &[String], files: &mut Vec<(Vec<String>, PathBuf)>) {
        for path in sorted_entries(dir) {
            if is_hidden(&path) {
                continue;
            }
            let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            let mut next = trail.to_vec();
            next.push(stem);
            if path.is_dir() {
                walk(&path, &next, files);
            } else if path.extension().is_some_and(|e| e == "md") {
                files.push((next, path));
            }
        }
    }
    let mut files = Vec::new();
    walk(dir, &[], &mut files);
    for (trail, path) in files {
        out.extend(command_item(&path, &trail.join(":"), prefix, source, origin));
    }
}

pub(super) fn json_file(path: &Path) -> Value {
    read(path).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)
}

fn transport_of(config: &Value) -> String {
    if let Some(t) = config.get("type").and_then(Value::as_str) {
        return t.to_string();
    }
    if config.get("url").is_some() {
        "http".into()
    } else if config.get("command").is_some() {
        "stdio".into()
    } else {
        String::new()
    }
}

fn configured(name: &str, source: &str, transport: String) -> McpServer {
    McpServer { name: name.to_string(), status: McpStatus::Unknown, source: source.to_string(), tools: None, error: None, transport }
}

pub(super) fn servers_from(map: &Value, source: &str, prefix: Option<&str>, out: &mut Vec<McpServer>) {
    for (name, config) in map.as_object().into_iter().flatten() {
        let full = prefix.map_or_else(|| name.clone(), |p| format!("{p}:{name}"));
        out.push(configured(&full, source, transport_of(config)));
    }
}

/// Claude Code: `~/.claude` and `<project>/.claude` skills and commands, enabled plugins', and MCP config.
pub(crate) fn scan_claude(home: &Path, cwd: &Path) -> Disk {
    let mut disk = Disk::default();
    let items = &mut disk.items;
    skills_in(&cwd.join(".claude/skills"), None, SlashSource::Project, "", items);
    commands_in(&cwd.join(".claude/commands"), None, SlashSource::Project, "", items);
    skills_in(&home.join(".claude/skills"), None, SlashSource::User, "", items);
    commands_in(&home.join(".claude/commands"), None, SlashSource::User, "", items);
    let plugins = super::plugins::enabled(home, cwd);
    for plugin in &plugins {
        super::plugins::scan(plugin, items);
    }
    let servers = &mut disk.servers;
    let user_config = json_file(&home.join(".claude.json"));
    servers_from(&user_config["mcpServers"], "user", None, servers);
    servers_from(&user_config["projects"][cwd.to_string_lossy().as_ref()]["mcpServers"], "local", None, servers);
    servers_from(&json_file(&cwd.join(".mcp.json"))["mcpServers"], "project", None, servers);
    for plugin in &plugins {
        let config = json_file(&plugin.root.join(".mcp.json"));
        servers_from(config.get("mcpServers").unwrap_or(&config), "plugin", Some(&format!("plugin:{}", plugin.name)), servers);
    }
    disk
}

/// Codex: skills folders, and the servers in `~/.codex/config.toml`.
pub(crate) fn scan_codex(home: &Path, cwd: &Path) -> Disk {
    let mut disk = Disk::default();
    skills_in(&cwd.join(".agents/skills"), None, SlashSource::Project, "", &mut disk.items);
    skills_in(&home.join(".agents/skills"), None, SlashSource::User, "", &mut disk.items);
    skills_in(&home.join(".codex/skills"), None, SlashSource::User, "", &mut disk.items);
    disk.servers = read(&home.join(".codex/config.toml")).map(|t| toml_servers(&t)).unwrap_or_default();
    disk
}

/// The `[mcp_servers.NAME]` tables of a Codex config, each with a transport read from its `url`/`command` line.
fn toml_servers(text: &str) -> Vec<McpServer> {
    let mut servers: Vec<McpServer> = Vec::new();
    let mut current: Option<usize> = None;
    for line in text.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            current = None;
            if let Some(rest) = header.strip_prefix("mcp_servers.") {
                let name = rest.split('.').next().unwrap_or(rest).trim_matches('"');
                current = Some(match servers.iter().position(|s| s.name == name) {
                    Some(at) => at,
                    None => {
                        servers.push(configured(name, "user", String::new()));
                        servers.len() - 1
                    }
                });
            }
        } else if let Some(at) = current {
            if line.starts_with("url") && line.contains('=') {
                servers[at].transport = "http".into();
            } else if line.starts_with("command") && line.contains('=') && servers[at].transport.is_empty() {
                servers[at].transport = "stdio".into();
            }
        }
    }
    servers
}

/// The folders OpenCode searches for project-local skills and commands: `cwd` and each parent up to
/// the git worktree's root (just `cwd` when it isn't in one).
fn project_dirs(cwd: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for dir in cwd.ancestors() {
        dirs.push(dir.to_path_buf());
        if dir.join(".git").exists() {
            return dirs;
        }
    }
    vec![cwd.to_path_buf()]
}

/// How deep below a `skills` folder OpenCode's search for `SKILL.md` goes in here (it reads `skills/**`).
const SKILL_SEARCH_DEPTH: usize = 6;

/// Every skill folder at any depth under `dir` (`skills/synced/<id>/docx/SKILL.md` is one); a skill's own folder isn't searched further.
fn skills_deep(dir: &Path, depth: usize, source: SlashSource, out: &mut Vec<SlashItem>) {
    for folder in sorted_entries(dir).into_iter().filter(|p| p.is_dir() && !is_hidden(p) && !p.ends_with("node_modules")) {
        match skill_item(&folder, None, source, "") {
            Some(item) => out.push(item),
            None if folder.join("SKILL.md").is_file() => {}
            None if depth > 0 => skills_deep(&folder, depth - 1, source, out),
            None => {}
        }
    }
}

/// OpenCode: skills from `.opencode`, `.claude` and `.agents` (in the project and its parents up to
/// the git root) and from `~/.config/opencode`, `~/.claude` and `~/.agents`; commands from
/// `.opencode/commands` and `~/.config/opencode/commands`; and the commands and servers in
/// `opencode.json`. Its ACP session lists skills as commands, so they're found here the same way.
/// Where a name is defined twice the nearer one wins.
pub(crate) fn scan_opencode(home: &Path, cwd: &Path) -> Disk {
    let mut disk = Disk::default();
    // (folder, where it is, whether it is OpenCode's own: the only one with commands)
    let mut roots: Vec<(PathBuf, SlashSource, bool)> = Vec::new();
    for dir in project_dirs(cwd) {
        roots.extend([(".opencode", true), (".claude", false), (".agents", false)].map(|(d, own)| (dir.join(d), SlashSource::Project, own)));
    }
    roots.extend([(home.join(".config/opencode"), true), (home.join(".claude"), false), (home.join(".agents"), false)].map(|(d, own)| (d, SlashSource::User, own)));
    for (root, source, own) in &roots {
        for folder in if *own { &["skills", "skill"][..] } else { &["skills"][..] } {
            skills_deep(&root.join(folder), SKILL_SEARCH_DEPTH, *source, &mut disk.items);
        }
        if *own {
            for folder in ["commands", "command"] {
                commands_in(&root.join(folder), None, *source, "", &mut disk.items);
            }
        }
    }
    for (config, source) in [(cwd.join("opencode.json"), SlashSource::Project), (home.join(".config/opencode/opencode.json"), SlashSource::User)] {
        let json = json_file(&config);
        for (name, command) in json["command"].as_object().into_iter().flatten() {
            let text = |key: &str| command[key].as_str().unwrap_or("");
            disk.items.push(SlashItem { name: name.clone(), description: clip(text("description")), hint: String::new(), kind: SlashKind::Command, source, origin: String::new() });
        }
        for (name, server) in json["mcp"].as_object().into_iter().flatten() {
            if !disk.servers.iter().any(|s| &s.name == name) {
                let transport = server["type"].as_str().map(|t| if t == "remote" { "http" } else { "stdio" }).unwrap_or_default();
                disk.servers.push(configured(name, "user", transport.to_string()));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    disk.items.retain(|i| seen.insert(i.name.clone()));
    disk
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("starkline-slash-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn a_header_reads_plain_quoted_and_block_values() {
        let front = parse_front("---\nname: demo\ndescription: >-\n  First line\n  second line.\nargument-hint: \"[who]\"\n---\nBody text\n");
        assert_eq!(front.keys["name"], "demo");
        assert_eq!(front.keys["description"], "First line second line.");
        assert_eq!(front.keys["argument-hint"], "[who]");
        assert_eq!(front.body.trim(), "Body text");
        assert!(parse_front("No header here").keys.is_empty());
    }

    #[test]
    fn claude_skills_commands_and_plugins_are_found_by_where_they_live() {
        let home = temp("home");
        let cwd = temp("cwd");
        write(&home.join(".claude/skills/pdf/SKILL.md"), "---\nname: pdf\ndescription: Work with PDFs\n---\nbody");
        write(&home.join(".claude/skills/hidden/SKILL.md"), "---\nname: hidden\nuser-invocable: false\n---\n");
        write(&cwd.join(".claude/commands/deploy/staging.md"), "---\nargument-hint: [branch]\n---\n# Ship it to staging\n");
        write(&cwd.join(".claude/skills/local/SKILL.md"), "---\ndescription: Project skill\n---\n");
        let plugin = home.join("plugins/tools");
        write(&plugin.join("commands/review.md"), "---\ndescription: Review a diff\n---\n");
        write(&plugin.join(".mcp.json"), r#"{"mcpServers":{"lint":{"command":"x","env":{"KEY":"secret"}}}}"#);
        write(&home.join(".claude/settings.json"), r#"{"enabledPlugins":{"tools@market":true,"off@market":false}}"#);
        write(
            &home.join(".claude/plugins/installed_plugins.json"),
            &format!(r#"{{"plugins":{{"tools@market":[{{"installPath":"{}"}}]}}}}"#, plugin.display()),
        );
        write(&home.join(".claude.json"), r#"{"mcpServers":{"docs":{"type":"http","url":"https://x","headers":{"k":"secret"}}}}"#);
        write(&cwd.join(".mcp.json"), r#"{"mcpServers":{"db":{"command":"psql"}}}"#);

        let disk = scan_claude(&home, &cwd);
        let found: Vec<(&str, SlashKind, SlashSource)> = disk.items.iter().map(|i| (i.name.as_str(), i.kind, i.source)).collect();
        assert!(found.contains(&("pdf", SlashKind::Skill, SlashSource::User)));
        assert!(found.contains(&("local", SlashKind::Skill, SlashSource::Project)));
        assert!(found.contains(&("deploy:staging", SlashKind::Command, SlashSource::Project)));
        assert!(found.contains(&("tools:review", SlashKind::Command, SlashSource::Plugin)));
        assert!(!found.iter().any(|f| f.0 == "hidden"));
        let staging = disk.items.iter().find(|i| i.name == "deploy:staging").unwrap();
        assert_eq!((staging.description.as_str(), staging.hint.as_str()), ("Ship it to staging", "[branch]"));
        let servers: Vec<(&str, &str, &str)> = disk.servers.iter().map(|s| (s.name.as_str(), s.source.as_str(), s.transport.as_str())).collect();
        assert_eq!(servers, vec![("docs", "user", "http"), ("db", "project", "stdio"), ("plugin:tools:lint", "plugin", "stdio")]);
        assert!(!serde_json::to_string(&disk.servers).unwrap().contains("secret"));
    }

    #[test]
    fn codex_servers_come_from_its_config_tables() {
        let servers = toml_servers("model = \"x\"\n[mcp_servers.context7]\ncommand = \"npx\"\n\n[mcp_servers.pika]\nurl = \"https://p\"\n[mcp_servers.pika.http_headers]\nKey = \"secret\"\n");
        let names: Vec<(&str, &str)> = servers.iter().map(|s| (s.name.as_str(), s.transport.as_str())).collect();
        assert_eq!(names, vec![("context7", "stdio"), ("pika", "http")]);
    }

    #[test]
    fn opencode_reads_skills_where_it_does_including_claude_and_agents_folders_and_nested_ones() {
        let home = temp("oc-home");
        let repo = temp("oc-repo");
        let cwd = repo.join("packages/app");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        write(&home.join(".config/opencode/skills/own/SKILL.md"), "---\ndescription: Own\n---\n");
        write(&home.join(".claude/skills/synced/id-1/docx/SKILL.md"), "---\nname: docx\ndescription: Word\n---\n");
        write(&home.join(".agents/skills/shared/SKILL.md"), "---\ndescription: Shared\n---\n");
        write(&home.join(".config/opencode/commands/ship.md"), "---\ndescription: Ship it\n---\n");
        write(&repo.join(".claude/skills/root-skill/SKILL.md"), "---\ndescription: From the repo root\n---\n");
        write(&repo.join(".opencode/commands/local.md"), "---\ndescription: Local\n---\n");
        write(&cwd.join("opencode.json"), r#"{"command":{"test":{"template":"run tests","description":"Run the tests"}},"mcp":{"db":{"type":"remote","url":"https://x"}}}"#);
        // Past the git root nothing is read.
        write(&repo.parent().unwrap().join(".agents/skills/outside/SKILL.md"), "---\ndescription: Outside\n---\n");

        let disk = scan_opencode(&home, &cwd);
        let found: Vec<(&str, SlashKind, SlashSource)> = disk.items.iter().map(|i| (i.name.as_str(), i.kind, i.source)).collect();
        for expected in [
            ("own", SlashKind::Skill, SlashSource::User),
            ("docx", SlashKind::Skill, SlashSource::User),
            ("shared", SlashKind::Skill, SlashSource::User),
            ("ship", SlashKind::Command, SlashSource::User),
            ("root-skill", SlashKind::Skill, SlashSource::Project),
            ("local", SlashKind::Command, SlashSource::Project),
            ("test", SlashKind::Command, SlashSource::Project),
        ] {
            assert!(found.contains(&expected), "{expected:?} in {found:?}");
        }
        assert!(!found.iter().any(|f| f.0 == "outside"));
        assert_eq!(disk.items.iter().find(|i| i.name == "test").unwrap().description, "Run the tests");
        assert_eq!(disk.servers.iter().map(|s| (s.name.as_str(), s.transport.as_str())).collect::<Vec<_>>(), vec![("db", "http")]);
        // A name defined in two places is listed once.
        write(&cwd.join(".opencode/skills/own/SKILL.md"), "---\ndescription: Nearer\n---\n");
        let disk = scan_opencode(&home, &cwd);
        let own: Vec<(&str, SlashSource)> = disk.items.iter().filter(|i| i.name == "own").map(|i| (i.description.as_str(), i.source)).collect();
        assert_eq!(own, vec![("Nearer", SlashSource::Project)]);
    }
}
