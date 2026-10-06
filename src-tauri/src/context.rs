//! A local snapshot of the inputs Starkline sends and the files providers discover.
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

const TEXT_LIMIT: usize = 20 * 1024;

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct ContextSource {
    pub group: u8,
    pub name: String,
    pub scope: String,
    pub delivery: String,
    // Discovery is not a receipt from the running provider.
    pub accepted: bool,
    pub conditional: bool,
    pub path: Option<String>,
    pub characters: u32,
    pub tokens: u32,
    pub text: String,
    pub omitted_characters: u32,
    pub markdown: bool,
}

#[derive(Debug, Serialize, specta::Type)]
pub struct ActiveContext {
    pub agent_name: String,
    pub provider: String,
    pub model: String,
    pub sources: Vec<ContextSource>,
    pub project_hint: Option<String>,
    pub notes: Vec<String>,
}

impl ContextSource {
    fn new(group: u8, name: &str, scope: &str, delivery: &str, accepted: bool, text: &str) -> Self {
        let characters = text.chars().count() as u32;
        let mut end = text.len().min(TEXT_LIMIT);
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let excerpt = &text[..end];
        Self {
            group,
            name: name.into(),
            scope: scope.into(),
            delivery: delivery.into(),
            accepted,
            conditional: false,
            path: None,
            characters,
            tokens: characters.div_ceil(4),
            text: excerpt.into(),
            omitted_characters: characters - excerpt.chars().count() as u32,
            markdown: true,
        }
    }
}

fn task_attachment(attachment: &crate::attachments::Attachment, kind: &str) -> ContextSource {
    use crate::attachments::AttachmentKind;
    let inline = crate::attachments::is_inline_image(attachment)
        || (kind == "claude-code"
            && attachment.kind == AttachmentKind::Pdf
            && attachment.size <= crate::attachments::INLINE_PDF_BYTES);
    let textual = matches!(
        attachment.kind,
        AttachmentKind::Text | AttachmentKind::Markdown | AttachmentKind::Html
    );
    let text = if textual {
        std::fs::read_to_string(&attachment.path).unwrap_or_else(|_| {
            crate::attachments::note_for_agent(std::slice::from_ref(attachment))
        })
    } else {
        crate::attachments::note_for_agent(std::slice::from_ref(attachment))
    };
    let mut source = ContextSource::new(
        4,
        &attachment.name,
        "this task",
        if inline {
            "Sent with the task's first message as a document or image; size below counts the file note only"
        } else {
            "Named with the task's first message; the provider's tools can read the file when needed"
        },
        true,
        &text,
    );
    source.path = Some(attachment.path.clone());
    source.markdown = attachment.kind == AttachmentKind::Markdown;
    source.conditional = !inline;
    source
}

fn provider_name(kind: &str) -> &str {
    match kind {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "opencode" => "OpenCode",
        _ => "this provider",
    }
}

fn file_source(
    path: &Path,
    group: u8,
    scope: &str,
    kind: &str,
    accepted: bool,
    reason: &str,
) -> Option<ContextSource> {
    let text = std::fs::read_to_string(path).ok()?;
    let filename = path.file_name()?.to_string_lossy();
    let location = path
        .parent()?
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let delivery = if accepted {
        format!("Read by {} itself{reason}", provider_name(kind))
    } else {
        format!("Not read by {}{reason}", provider_name(kind))
    };
    let mut s = ContextSource::new(
        group,
        &format!("{filename} in {location}"),
        scope,
        &delivery,
        accepted,
        &text,
    );
    s.path = Some(path.to_string_lossy().into());
    s.markdown = path.extension().is_some_and(|ext| ext == "md");
    Some(s)
}

fn add_file(
    sources: &mut Vec<ContextSource>,
    path: &Path,
    group: u8,
    scope: &str,
    kind: &str,
    accepted: bool,
    reason: &str,
) {
    if sources
        .iter()
        .any(|s| s.path.as_deref() == Some(path.to_string_lossy().as_ref()))
    {
        return;
    }
    if let Some(source) = file_source(path, group, scope, kind, accepted, reason) {
        sources.push(source);
    }
}

fn path_scoped(text: &str) -> bool {
    text.strip_prefix("---")
        .and_then(|body| body.split_once("---"))
        .is_some_and(|(frontmatter, _)| {
            frontmatter
                .lines()
                .any(|line| line.trim_start().starts_with("paths:"))
        })
}

fn nonempty(path: &Path) -> bool {
    std::fs::read_to_string(path).is_ok_and(|text| !text.trim().is_empty())
}

fn project_dirs(folder: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    for dir in folder.ancestors() {
        dirs.push(dir.to_path_buf());
        // .git can be a directory or a worktree pointer file.
        if dir.join(".git").exists() {
            return dirs;
        }
    }
    vec![folder.to_path_buf()]
}

fn markdown_files(dir: &Path, depth: usize) -> Vec<PathBuf> {
    if depth == 0 {
        return vec![];
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return vec![];
    };
    let mut paths = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            paths.extend(markdown_files(&path, depth - 1));
        } else if path.extension().is_some_and(|ext| ext == "md") {
            paths.push(path);
        }
    }
    paths.sort();
    paths
}

fn add_skills(
    sources: &mut Vec<ContextSource>,
    dir: &Path,
    scope: &str,
    kind: &str,
    accepted: bool,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<_> = entries
        .flatten()
        .map(|e| e.path().join("SKILL.md"))
        .filter(|p| p.is_file())
        .collect();
    paths.sort();
    for path in paths {
        let before = sources.len();
        add_file(
            sources,
            &path,
            if scope == "everywhere" { 1 } else { 2 },
            scope,
            kind,
            accepted,
            if accepted {
                " when the skill is used"
            } else {
                " (another provider's skills)"
            },
        );
        if sources.len() > before {
            let source = sources.last_mut().unwrap();
            source.name = format!(
                "{} skill",
                path.parent()
                    .and_then(|p| p.file_name())
                    .unwrap_or_default()
                    .to_string_lossy()
            );
            source.conditional = true;
        }
    }
}

/// Inspect server names only; credentials and launch environments stay out of IPC.
fn add_mcp_names(sources: &mut Vec<ContextSource>, path: &Path, scope: &str, folder: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return;
    };
    for (servers, group, source_scope, name) in [
        (
            value.get("mcpServers"),
            if scope == "everywhere" { 1 } else { 2 },
            scope,
            "Configured MCP servers",
        ),
        (
            value
                .get("projects")
                .and_then(|v| v.get(folder.to_string_lossy().as_ref()))
                .and_then(|v| v.get("mcpServers")),
            2,
            "this project",
            "Project MCP servers",
        ),
    ] {
        let Some(servers) = servers
            .and_then(|v| v.as_object())
            .filter(|o| !o.is_empty())
        else {
            continue;
        };
        let mut names: Vec<_> = servers.keys().cloned().collect();
        names.sort();
        let mut s = ContextSource::new(group, name, source_scope, "Discovered in Claude Code settings; connection and approval are checked by Claude Code", true, &format!("Servers: {}.\n\nOnly names are shown. Credentials and server environments are omitted.", names.join(", ")));
        s.path = Some(path.to_string_lossy().into());
        s.conditional = true;
        sources.push(s);
    }
}

/// Highest-precedence project files first. Home is passed in so tests never read real preferences.
fn discover(kind: &str, folder: &Path, home: &Path) -> Vec<ContextSource> {
    let mut sources = Vec::new();
    let dirs = project_dirs(folder);
    let claude_dirs: Vec<_> = folder.ancestors().map(Path::to_path_buf).collect();
    let claude_present = claude_dirs.iter().any(|d| {
        d.join("CLAUDE.md").is_file()
            || d.join("CLAUDE.local.md").is_file()
            || d.join(".claude/CLAUDE.md").is_file()
    });
    let opencode_agents = dirs.iter().find(|d| d.join("AGENTS.md").is_file());
    let opencode_claude = dirs.iter().find(|d| d.join("CLAUDE.md").is_file());
    let project_scan = if kind == "claude-code" {
        &claude_dirs
    } else {
        &dirs
    };
    for dir in project_scan {
        let scope = if dir == home {
            "everywhere"
        } else if dir == folder {
            "this folder"
        } else {
            "this project"
        };
        for filename in [
            "CLAUDE.local.md",
            "CLAUDE.md",
            "AGENTS.override.md",
            "AGENTS.md",
            ".claude/CLAUDE.md",
        ] {
            let accepted = match kind {
                "claude-code" => {
                    filename.starts_with("CLAUDE")
                        || filename == ".claude/CLAUDE.md"
                        || (filename == "AGENTS.md" && !claude_present && dirs.contains(dir))
                }
                "codex" => {
                    (filename == "AGENTS.override.md" && nonempty(&dir.join(filename)))
                        || (filename == "AGENTS.md"
                            && !nonempty(&dir.join("AGENTS.override.md"))
                            && nonempty(&dir.join(filename)))
                }
                "opencode" => {
                    (filename == "AGENTS.md" && opencode_agents == Some(dir))
                        || (filename == "CLAUDE.md"
                            && opencode_agents.is_none()
                            && opencode_claude == Some(dir))
                }
                _ => false,
            };
            let reason = if kind == "codex"
                && filename.starts_with("AGENTS")
                && !nonempty(&dir.join(filename))
            {
                " (empty files are skipped)"
            } else if kind == "codex" && filename == "AGENTS.md" && !accepted {
                " (AGENTS.override.md takes its place)"
            } else if kind == "opencode" && !accepted {
                " (only the nearest matching instruction file is used)"
            } else {
                ""
            };
            add_file(
                &mut sources,
                &dir.join(filename),
                if dir == home && filename == ".claude/CLAUDE.md" {
                    1
                } else {
                    2
                },
                scope,
                kind,
                accepted,
                reason,
            );
        }
        for path in markdown_files(&dir.join(".claude/rules"), 8) {
            let before = sources.len();
            add_file(
                &mut sources,
                &path,
                2,
                scope,
                kind,
                kind == "claude-code",
                "",
            );
            if sources.len() > before
                && kind == "claude-code"
                && path_scoped(&sources.last().unwrap().text)
            {
                let source = sources.last_mut().unwrap();
                source.conditional = true;
                source.delivery = "Read by Claude Code itself when its path rules match".into();
            }
        }
        if dirs.contains(dir) {
            add_skills(
                &mut sources,
                &dir.join(".claude/skills"),
                scope,
                kind,
                kind == "claude-code" || kind == "opencode",
            );
        }
        if kind == "claude-code" {
            for file in [
                ".mcp.json",
                ".claude/settings.json",
                ".claude/settings.local.json",
            ] {
                add_mcp_names(&mut sources, &dir.join(file), scope, folder);
            }
        }
        if kind == "codex" {
            add_skills(&mut sources, &dir.join(".agents/skills"), scope, kind, true);
        }
    }
    let codex_override = home.join(".codex/AGENTS.override.md");
    let opencode_global = home.join(".config/opencode/AGENTS.md");
    for (file, accepted) in [
        (
            ".claude/CLAUDE.md",
            kind == "claude-code" || (kind == "opencode" && !opencode_global.is_file()),
        ),
        (
            ".codex/AGENTS.override.md",
            kind == "codex" && nonempty(&codex_override),
        ),
        (
            ".codex/AGENTS.md",
            kind == "codex"
                && !nonempty(&codex_override)
                && nonempty(&home.join(".codex/AGENTS.md")),
        ),
        (".config/opencode/AGENTS.md", kind == "opencode"),
    ] {
        add_file(
            &mut sources,
            &home.join(file),
            1,
            "everywhere",
            kind,
            accepted,
            "",
        );
    }
    for path in markdown_files(&home.join(".claude/rules"), 8) {
        let before = sources.len();
        add_file(
            &mut sources,
            &path,
            1,
            "everywhere",
            kind,
            kind == "claude-code",
            "",
        );
        if sources.len() > before
            && kind == "claude-code"
            && path_scoped(&sources.last().unwrap().text)
        {
            let source = sources.last_mut().unwrap();
            source.conditional = true;
            source.delivery = "Read by Claude Code itself when its path rules match".into();
        }
    }
    add_skills(
        &mut sources,
        &home.join(".claude/skills"),
        "everywhere",
        kind,
        kind == "claude-code" || kind == "opencode",
    );
    add_skills(
        &mut sources,
        &home.join(".codex/skills"),
        "everywhere",
        kind,
        kind == "codex",
    );
    add_skills(
        &mut sources,
        &home.join(".agents/skills"),
        "everywhere",
        kind,
        kind == "codex",
    );
    if kind == "claude-code" {
        add_mcp_names(
            &mut sources,
            &home.join(".claude.json"),
            "everywhere",
            folder,
        );
        add_mcp_names(
            &mut sources,
            &home.join(".claude/settings.json"),
            "everywhere",
            folder,
        );
    }
    sources.sort_by_key(|s| s.group);
    sources
}

fn prompt_delivery(kind: &str) -> (&'static str, bool) {
    match kind {
        "claude-code" => ("Sent by Starkline in the system prompt (new sessions; resumed sessions keep their original prompt)", true),
        "codex" => ("Sent by Starkline as developer instructions", true),
        "opencode" => ("Sent by Starkline as an instructions file OpenCode adds to its system prompt (new sessions)", true),
        _ => ("Not sent by Starkline to this provider", false),
    }
}

pub fn snapshot(
    app: &tauri::AppHandle,
    agent_id: &str,
    folder: &str,
    task_id: Option<&str>,
) -> Result<ActiveContext, String> {
    let state = app.state::<crate::AppState>();
    if state.config.lock().unwrap().agent(agent_id).is_none() {
        return Err("That agent is no longer in the roster.".into());
    }
    let engine = crate::prompts::agent_engine(app, agent_id);
    let name = crate::prompts::agent_name(app, agent_id);
    let folder = if folder.is_empty() {
        state
            .workdirs
            .lock()
            .unwrap()
            .get(agent_id)
            .cloned()
            .or_else(|| {
                state
                    .ledger
                    .current_conversation(agent_id)
                    .and_then(|id| state.ledger.conversation(id))
                    .map(|c| c.cwd)
            })
            .unwrap_or_else(|| state.project.lock().unwrap().clone())
    } else {
        folder.into()
    };
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let mut sources = discover(&engine.kind, Path::new(&folder), &home);
    let has_project_instructions = sources.iter().any(|s| {
        s.group == 2
            && (s.accepted || s.characters == 0)
            && s.path.as_ref().is_some_and(|p| {
                let filenames: &[&str] = match engine.kind.as_str() {
                    "claude-code" => &["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"],
                    "codex" => &["AGENTS.md", "AGENTS.override.md"],
                    "opencode" => &["AGENTS.md", "CLAUDE.md"],
                    _ => &[],
                };
                filenames
                    .iter()
                    .any(|f| Path::new(p).file_name().is_some_and(|n| n == *f))
            })
    });
    let filename = if engine.kind == "claude-code" {
        "CLAUDE.md"
    } else {
        "AGENTS.md"
    };
    let project_hint = (!has_project_instructions && matches!(engine.kind.as_str(), "claude-code" | "codex" | "opencode")).then(|| format!("{} reads {filename} from the project. {} doesn't have one. Add {filename} to give it project instructions.", provider_name(&engine.kind), crate::chat::base_name(&folder)));
    let (delivery, accepted) = prompt_delivery(&engine.kind);
    for section in crate::prompts::system_prompt_sections(app, agent_id) {
        let (group, title, scope) = match section.key {
            "identity" => (3, format!("{name}'s personality and tone"), "this agent"),
            "memory" => (3, format!("{name}'s memory"), "this agent"),
            "permission" => (1, "Permission policy".into(), "everywhere"),
            "delegation" => (1, "Delegation mechanics".into(), "this agent"),
            "planning" => (1, "Planning playbook".into(), "this agent"),
            "ask_human" => (1, "Asking you".into(), "everywhere"),
            "messaging" => (1, "Team messaging".into(), "everywhere"),
            "sharing" => (1, "Sharing files".into(), "everywhere"),
            _ => (1, "Live state instructions".into(), "this agent"),
        };
        let mut source =
            ContextSource::new(group, &title, scope, delivery, accepted, &section.text);
        if section.key == "memory" {
            let path = crate::prompts::memory_file_path(app, agent_id);
            if Path::new(&path).is_file() {
                source.path = Some(path);
            }
        }
        sources.push(source);
    }
    if crate::prompts::agent_is_orchestrator(app, agent_id) {
        let text = crate::prompts::orchestrator_turn_context(app, agent_id);
        if !text.is_empty() {
            sources.push(ContextSource::new(
                4,
                "Team and projects (each message)",
                "this agent",
                "Sent with each message",
                true,
                &text,
            ));
        }
    }
    let task = if let Some(id) = task_id {
        Some(
            state
                .ledger
                .task(id)
                .filter(|t| t.assignee == agent_id)
                .ok_or("That task doesn't belong to this agent.")?,
        )
    } else {
        crate::tasks::active_task_for(app, agent_id)
            .and_then(|id| state.ledger.task(&id))
            .or_else(|| {
                state
                    .ledger
                    .current_conversation(agent_id)
                    .and_then(|id| state.ledger.task_for_conversation(id))
            })
    };
    if let Some(task) = task.filter(|t| t.cwd == folder) {
        sources.push(ContextSource::new(
            4,
            if task.parent_id.is_some() {
                "Delegation request"
            } else {
                "Task request"
            },
            "this task",
            "Sent with the task's first message",
            true,
            &task.prompt,
        ));
        for attachment in state.ledger.task_attachments(&task.id) {
            sources.push(task_attachment(&attachment, &engine.kind));
        }
    }
    sources.sort_by_key(|s| s.group);
    Ok(ActiveContext {
        agent_name: name, provider: engine.label.clone(), model: crate::providers::model_name(&crate::prompts::agent_model(app, agent_id, &engine)), sources, project_hint,
        notes: vec![
            "This is a snapshot of current settings and local files, not a receipt from the running provider. Token counts are estimates; ignored and conditional sources are excluded from the total.".into(),
            "Project files are shown closest folder first. Codex gives nearby files precedence; Claude Code concatenates instructions and does not guarantee which conflicting file wins.".into(),
            "Provider defaults, conversation history, imported files, provider memory, plugins and custom discovery settings can add context. Discovery follows default provider settings: exclusions, disabled skills, alternate homes, extra command arguments and custom file names can change it. Codex defaults to a 32 KiB instruction budget. Conditional skills and path rules load only when used. Refresh after changing files; start a new chat to apply changed Claude Code prompts.".into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Tree(PathBuf);
    impl Tree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "stark-context-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn write(&self, path: &str, text: &str) {
            let path = self.0.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
    }
    impl Drop for Tree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn discovery_obeys_provider_roots_overrides_and_fallbacks() {
        let tree = Tree::new();
        for (path, text) in [
            ("repo/.git", "worktree"),
            ("CLAUDE.md", "parent"),
            ("AGENTS.md", "outside repo"),
            ("repo/CLAUDE.md", "Claude"),
            ("repo/AGENTS.md", "root"),
            ("repo/sub/AGENTS.override.md", "override"),
            ("repo/sub/AGENTS.md", "ignored"),
            ("repo/sub/CLAUDE.local.md", "local"),
            ("home/.codex/AGENTS.md", "home"),
            ("home/.codex/AGENTS.override.md", "home override"),
            ("home/.claude/CLAUDE.md", "global"),
            ("home/.config/opencode/AGENTS.md", "OpenCode global"),
        ] {
            tree.write(path, text);
        }
        let folder = tree.0.join("repo/sub");
        let home = tree.0.join("home");
        let claude = discover("claude-code", &folder, &home);
        assert!(claude.iter().any(|s| s.text == "parent" && s.accepted));
        assert!(claude.iter().any(|s| s.text == "local" && s.accepted));
        assert!(claude.iter().any(|s| s.text == "root" && !s.accepted));
        let codex = discover("codex", &folder, &home);
        assert!(!codex.iter().any(|s| s.text == "outside repo"));
        assert!(codex
            .iter()
            .any(|s| s.text == "home override" && s.accepted));
        assert!(codex.iter().any(|s| s.text == "home" && !s.accepted));
        assert!(codex.iter().any(|s| s.text == "ignored" && !s.accepted));
        assert!(codex
            .iter()
            .any(|s| s.text == "Claude" && s.delivery == "Not read by Codex"));
        let active: Vec<_> = codex
            .iter()
            .filter(|s| s.group == 2 && s.accepted)
            .map(|s| s.text.as_str())
            .collect();
        assert_eq!(active, ["override", "root"]);
        let opencode = discover("opencode", &folder, &home);
        assert!(opencode.iter().any(|s| s.text == "ignored" && s.accepted));
        assert!(opencode.iter().any(|s| s.text == "Claude" && !s.accepted));
        std::fs::remove_file(folder.join("AGENTS.md")).unwrap();
        std::fs::remove_file(tree.0.join("repo/AGENTS.md")).unwrap();
        assert!(discover("opencode", &folder, &home)
            .iter()
            .any(|s| s.text == "Claude" && s.accepted));
    }
    #[test]
    fn empty_missing_skills_rules_and_mcp_secrets() {
        let tree = Tree::new();
        tree.write("repo/CLAUDE.md", "");
        tree.write("repo/.claude/rules/api.md", "---\npaths: src/**\n---\nRule");
        tree.write("home/.claude/skills/test/SKILL.md", "Skill");
        tree.write(
            "home/.claude/settings.json",
            r#"{"mcpServers":{"local":{"env":{"SECRET":"do-not-return"}}}}"#,
        );
        let sources = discover("claude-code", &tree.0.join("repo"), &tree.0.join("home"));
        assert!(sources.iter().any(|s| s.characters == 0 && s.accepted));
        assert!(!sources.iter().any(|s| s.name.starts_with("AGENTS")));
        assert_eq!(sources.iter().filter(|s| s.conditional).count(), 3);
        assert!(sources
            .iter()
            .any(|s| s.name == "Configured MCP servers" && s.text.contains("local")));
        assert!(!serde_json::to_string(&sources)
            .unwrap()
            .contains("do-not-return"));
    }
    #[test]
    fn empty_codex_overrides_fall_back_and_plain_rules_are_unconditional() {
        let tree = Tree::new();
        tree.write("repo/AGENTS.override.md", "");
        tree.write("repo/AGENTS.md", "Project guidance");
        tree.write("home/.codex/AGENTS.override.md", "");
        tree.write("home/.codex/AGENTS.md", "Global guidance");
        tree.write(
            "repo/.claude/rules/plain.md",
            "---\ndescription: Rules\n---\nAlways loaded",
        );
        let codex = discover("codex", &tree.0.join("repo"), &tree.0.join("home"));
        assert!(codex
            .iter()
            .any(|s| s.text == "Project guidance" && s.accepted));
        assert!(codex
            .iter()
            .any(|s| s.text == "Global guidance" && s.accepted));
        assert!(codex.iter().any(|s| s.characters == 0 && !s.accepted));
        let claude = discover("claude-code", &tree.0.join("repo"), &tree.0.join("home"));
        assert!(claude
            .iter()
            .any(|s| s.text.ends_with("Always loaded") && !s.conditional));
    }

    #[test]
    fn task_files_show_content_without_claiming_it_was_inlined() {
        let tree = Tree::new();
        tree.write("brief.md", "# Task brief");
        let attachment = crate::attachments::Attachment {
            path: tree.0.join("brief.md").to_string_lossy().into(),
            name: "brief.md".into(),
            mime: "text/markdown".into(),
            kind: crate::attachments::AttachmentKind::Markdown,
            size: 12,
        };
        let source = task_attachment(&attachment, "codex");
        assert_eq!(source.group, 4);
        assert_eq!(source.text, "# Task brief");
        assert_eq!(source.path.as_deref(), Some(attachment.path.as_str()));
        assert!(source.conditional && source.markdown && source.accepted);
        assert_eq!(source.characters, 12);
    }

    #[test]
    fn size_and_truncation_count_unicode_characters() {
        let text = "界".repeat(10_000);
        let source = ContextSource::new(2, "File", "this folder", "Read", true, &text);
        assert_eq!(source.characters, 10_000);
        assert_eq!(source.tokens, 2_500);
        assert!(source.text.len() <= TEXT_LIMIT);
        assert_eq!(
            source.text.chars().count() as u32 + source.omitted_characters,
            10_000
        );
        assert!(prompt_delivery("opencode").1);
        assert!(prompt_delivery("codex").1);
    }
}
