//! File reservations for agents collaborating in one workspace.
use serde::Serialize;
use std::path::{Component, Path, PathBuf};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct FileClaim {
    pub workspace: String,
    pub path: String,
    pub agent_id: String,
    pub task_id: Option<String>,
    pub reason: String,
    pub exclusive: bool,
}

#[derive(Default)]
pub struct Claims {
    files: Vec<FileClaim>,
}

pub fn resolve(workspace: &str, raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("Name a file or folder inside your workspace.".into());
    }
    let root = Path::new(workspace).canonicalize().unwrap_or_else(|_| PathBuf::from(workspace));
    let input = Path::new(raw);
    let absolute = if input.is_absolute() { input.to_path_buf() } else { root.join(input) };
    let mut normal = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                normal.pop();
            }
            Component::CurDir => {}
            other => normal.push(other.as_os_str()),
        }
    }
    // Resolve the existing parent too, so symlink aliases cannot bypass reservations.
    let mut existing = normal.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        if let Some(name) = existing.file_name() {
            suffix.push(name.to_os_string());
        }
        existing = existing.parent().ok_or("That path can't be resolved.")?;
    }
    let mut resolved = existing.canonicalize().map_err(|e| e.to_string())?;
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    let relative = resolved.strip_prefix(&root).map_err(|_| "Claim files inside your workspace.")?;
    Ok(relative.to_string_lossy().to_string())
}

fn overlaps(a: &str, b: &str) -> bool {
    Path::new(a).starts_with(b) || Path::new(b).starts_with(a)
}

pub fn sensitive(workspace: &str, path: &str) -> bool {
    let name = Path::new(path).file_name().unwrap_or_default().to_string_lossy();
    let parts: Vec<_> = Path::new(path).components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect();
    LOCKFILES.contains(&name.as_ref())
        || parts
            .iter()
            .any(|p| matches!(p.as_str(), "migrations" | "migrate" | "dist" | "build" | "generated" | "__generated__"))
        || parts.windows(2).any(|p| p[0] == "alembic" && p[1] == "versions")
        || name.contains(".gen.")
        || name.contains(".generated.")
        || name.ends_with(".proto")
        || name.ends_with(".d.ts")
        || name.starts_with("openapi.")
        || matches!(name.as_ref(), "schema.graphql" | "schema.prisma")
        || generated_header(Path::new(workspace).join(path))
}

fn generated_header(path: PathBuf) -> bool {
    use std::io::Read;
    let Ok(mut file) = std::fs::File::open(path) else { return false };
    let mut bytes = [0; 512];
    let n = file.read(&mut bytes).unwrap_or(0);
    let text = String::from_utf8_lossy(&bytes[..n]);
    text.contains("@generated") || text.contains("DO NOT EDIT")
}

pub const LOCKFILES: &[&str] = &[
    "package-lock.json",
    "npm-shrinkwrap.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "bun.lock",
    "bun.lockb",
    "Cargo.lock",
    "Gemfile.lock",
    "poetry.lock",
    "Pipfile.lock",
    "uv.lock",
    "composer.lock",
    "go.sum",
    "Podfile.lock",
    "Package.resolved",
    "pubspec.lock",
    "mix.lock",
    "flake.lock",
];

impl Claims {
    pub fn list(&self, workspace: &str) -> Vec<FileClaim> {
        self.files.iter().filter(|c| c.workspace == workspace).cloned().collect()
    }
    pub fn claim(&mut self, workspace: &str, path: &str, agent: &str, task: Option<&str>, reason: &str, exclusive: bool) -> Result<(), Box<FileClaim>> {
        if let Some(other) = self
            .files
            .iter()
            .find(|c| c.workspace == workspace && c.agent_id != agent && overlaps(path, &c.path))
        {
            return Err(Box::new(other.clone()));
        }
        if let Some(held) = self
            .files
            .iter_mut()
            .find(|c| c.workspace == workspace && c.agent_id == agent && c.path == path)
        {
            held.exclusive |= exclusive;
            if exclusive {
                held.reason = reason.into();
            }
        } else {
            self.files.push(FileClaim {
                workspace: workspace.into(),
                path: path.into(),
                agent_id: agent.into(),
                task_id: task.map(str::to_string),
                reason: reason.into(),
                exclusive,
            });
        }
        Ok(())
    }
    pub fn release(&mut self, workspace: &str, agent: &str, paths: &[String]) {
        self.files
            .retain(|c| c.workspace != workspace || c.agent_id != agent || (!paths.is_empty() && !paths.iter().any(|p| Path::new(&c.path).starts_with(p))));
    }
    pub fn release_agent(&mut self, agent: &str) {
        self.files.retain(|c| c.agent_id != agent);
    }
    pub fn release_task(&mut self, id: &str) {
        self.files.retain(|c| c.task_id.as_deref() != Some(id));
    }
    fn check_command(&self, workspace: &str, agent: &str, owner: &str, command: &str) -> Result<(), String> {
        if owner != agent && mutates_git(command) {
            return Err(format!("Only {owner}, who owns this task, runs git here."));
        }
        let ctx = crate::gate::Context::for_project(workspace);
        let dependencies = installs_dependencies(command, &ctx);
        if dependencies {
            let mut locks: Vec<String> = LOCKFILES
                .iter()
                .filter(|p| Path::new(workspace).join(p).exists())
                .map(|p| p.to_string())
                .collect();
            if locks.is_empty() {
                locks.push(lockfile_for(command).into());
            }
            locks.iter().try_for_each(|path| self.check_edit(workspace, path, agent, true))
        } else {
            Ok(())
        }
    }
    fn check_edit(&self, workspace: &str, path: &str, agent: &str, shared: bool) -> Result<(), String> {
        if !shared {
            return Ok(());
        }
        if let Some(other) = self
            .files
            .iter()
            .find(|c| c.workspace == workspace && c.agent_id != agent && overlaps(path, &c.path))
        {
            return Err(format!(
                "{} has claimed {} ({}). Ask them to release it, or ask the task owner.",
                other.agent_id, other.path, other.reason
            ));
        }
        if sensitive(workspace, path)
            && !self
                .files
                .iter()
                .any(|c| c.workspace == workspace && c.agent_id == agent && c.exclusive && Path::new(path).starts_with(&c.path))
        {
            return Err(format!(
                "{path} needs an exclusive claim before editing. Call claim_files with paths: [\"{path}\"] and a reason, then try again."
            ));
        }
        Ok(())
    }
}

pub fn edit_path<'a>(tool: &str, input: &'a serde_json::Value) -> Option<&'a str> {
    if !matches!(tool, "Edit" | "MultiEdit" | "Write" | "NotebookEdit") {
        return None;
    }
    ["file_path", "notebook_path", "path"]
        .iter()
        .find_map(|key| input.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()))
}

pub fn mutates_git(command: &str) -> bool {
    crate::gate::command_words(command).iter().any(|words| changes_repository(words))
}

fn changes_repository(words: &[String]) -> bool {
    let Some((index, program)) = words.iter().enumerate().find(|(_, w)| !w.contains('=')) else {
        return false;
    };
    let program = Path::new(program).file_name().unwrap_or_default().to_string_lossy();
    let args = &words[index + 1..];
    match program.as_ref() {
        "git" => {
            let mut rest = args.iter();
            while let Some(word) = rest.next() {
                if matches!(word.as_str(), "-C" | "-c" | "--git-dir" | "--work-tree") {
                    rest.next();
                    continue;
                }
                if word.starts_with('-') {
                    continue;
                }
                return matches!(
                    word.as_str(),
                    "commit" | "checkout" | "switch" | "reset" | "stash" | "merge" | "rebase" | "branch"
                );
            }
            false
        }
        "bash" | "sh" | "zsh" | "fish" => args
            .windows(2)
            .any(|pair| pair[0].starts_with('-') && pair[0].contains('c') && mutates_git(&pair[1])),
        "env" | "time" | "command" | "exec" | "nohup" | "sudo" | "nice" | "timeout" => {
            let mut skip = 0;
            while skip < args.len() {
                if matches!(args[skip].as_str(), "-u" | "-n" | "-s" | "--signal" | "--kill-after") {
                    skip += 2;
                } else if args[skip].starts_with('-')
                    || args[skip].contains('=')
                    || (program == "timeout" && args[skip].chars().next().is_some_and(|c| c.is_ascii_digit()))
                {
                    skip += 1;
                } else {
                    break;
                }
            }
            changes_repository(&args[skip.min(args.len())..])
        }
        _ => false,
    }
}

/// The other agents working in this folder now: holding claims there, busy in a session
/// there, or running a task there. An idle chat left open in the folder doesn't count.
pub fn peers(app: &tauri::AppHandle, workspace: &str, agent: &str) -> Vec<String> {
    use crate::agents::AgentStatus;
    let state = app.state::<crate::AppState>();
    let mut peers: Vec<String> = state
        .claims
        .lock()
        .unwrap()
        .list(workspace)
        .into_iter()
        .filter(|c| c.agent_id != agent)
        .map(|c| c.agent_id)
        .collect();
    let sessions: Vec<String> = state.chat.sessions.lock().unwrap().keys().cloned().collect();
    let terminals: Vec<String> = state.pty.sessions.lock().unwrap().keys().cloned().collect();
    let dirs = state.workdirs.lock().unwrap().clone();
    let statuses = state.statuses.lock().unwrap().clone();
    let busy = |id: &String| matches!(statuses.get(id), Some(AgentStatus::Working | AgentStatus::Thinking | AgentStatus::Blocked));
    peers.extend(
        sessions
            .into_iter()
            .chain(terminals)
            .filter(|id| id != agent && busy(id) && dirs.get(id).is_some_and(|cwd| cwd == workspace)),
    );
    peers.extend(state.ledger.running_in(workspace).into_iter().filter(|assignee| assignee != agent));
    peers.sort();
    peers.dedup();
    peers
}

pub fn shared(app: &tauri::AppHandle, workspace: &str, agent: &str) -> bool {
    !peers(app, workspace, agent).is_empty()
}

fn owner(app: &tauri::AppHandle, agent: &str) -> String {
    let state = app.state::<crate::AppState>();
    let mut task = crate::tasks::active_task_for(app, agent).and_then(|id| state.ledger.task(&id));
    while let Some(parent) = task.as_ref().and_then(|t| t.parent_id.clone()) {
        task = state.ledger.task(&parent);
    }
    task.map(|t| t.assignee).unwrap_or_else(|| agent.into())
}

pub fn report(app: &tauri::AppHandle, agent: &str, workspace: &str, reason: &str) {
    let state = app.state::<crate::AppState>();
    let task = crate::tasks::active_task_for(app, agent);
    let mut reason = reason.to_string();
    let roster = state.config.lock().unwrap().agents.clone();
    for member in roster {
        reason = reason.replace(&format!("{} has claimed", member.id), &format!("{} has claimed", member.name));
    }
    let owner_name = crate::prompts::agent_name(app, &owner(app, agent));
    reason = reason.replace("ask the task owner.", &format!("ask the task owner {owner_name}."));
    if let Some(id) = &task {
        let e = state.ledger.add_task_event(id, agent, "claim_refused", &reason, "");
        let _ = app.emit("tasks://event", e);
    }
    let title = if let Some((holder, claimed)) = reason.split_once(" has claimed ") {
        let path = claimed.split(" (").next().unwrap_or(claimed);
        format!(
            "{} wanted to edit {}, which {holder} has claimed",
            crate::prompts::agent_name(app, agent),
            crate::chat::base_name(path)
        )
    } else {
        format!("{} couldn't change the shared workspace", crate::prompts::agent_name(app, agent))
    };
    if first_in_a_while(agent, &title) {
        if let Some(stored) = state.ledger.add_notification(&crate::ledger::NewNotification {
            kind: "claim_refused",
            urgency: "update",
            agent_id: agent,
            task_id: task.as_deref(),
            cwd: workspace,
            title: &title,
            body: &reason,
            ..Default::default()
        }) {
            crate::system_notifications::deliver(app, &stored, "");
            let _ = app.emit("notifications://changed", ());
        }
    }
    changed(app);
}

/// How long the same refusal stays one notification, however often the agent retries.
const REPEAT_QUIET: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Whether this agent's refusal is new: not the same one notified within `REPEAT_QUIET`.
fn first_in_a_while(agent: &str, title: &str) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static LAST: OnceLock<Mutex<HashMap<(String, String), Instant>>> = OnceLock::new();
    let mut last = LAST.get_or_init(Default::default).lock().unwrap();
    let key = (agent.to_string(), title.to_string());
    let fresh = last.get(&key).is_none_or(|at| at.elapsed() >= REPEAT_QUIET);
    if fresh {
        last.insert(key, Instant::now());
    }
    fresh
}

fn changed(app: &tauri::AppHandle) {
    let _ = app.emit("tasks://changed", ());
}

pub fn check(app: &tauri::AppHandle, agent: &str, tool: &str, input: &serde_json::Value) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let Some(workspace) = state.workdirs.lock().unwrap().get(agent).cloned() else {
        return Ok(());
    };
    let sharing = shared(app, &workspace, agent);
    let result = if let Some(raw) = edit_path(tool, input) {
        // The permission gate handles files outside the workspace.
        resolve(&workspace, raw).map_or(Ok(()), |path| state.claims.lock().unwrap().check_edit(&workspace, &path, agent, sharing))
    } else if tool == "Bash" && sharing {
        let command = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let owner = owner(app, agent);
        state
            .claims
            .lock()
            .unwrap()
            .check_command(&workspace, agent, &owner, command)
            .map_err(|reason| reason.replace(&format!("Only {owner},"), &format!("Only {},", crate::prompts::agent_name(app, &owner))))
    } else {
        Ok(())
    };
    let result = result.map_err(|mut reason| {
        let roster = state.config.lock().unwrap().agents.clone();
        for member in roster {
            reason = reason.replace(&format!("{} has claimed", member.id), &format!("{} has claimed", member.name));
        }
        reason.replace(
            "Ask them to release it, or ask the task owner.",
            &format!(
                "Ask them to release it, or ask the task owner {}.",
                crate::prompts::agent_name(app, &owner(app, agent))
            ),
        )
    });
    if let Err(reason) = &result {
        report(app, agent, &workspace, reason);
    }
    result
}

fn installs_dependencies(command: &str, context: &crate::gate::Context) -> bool {
    if crate::gate::risky_commands(command, context)
        .iter()
        .any(|c| crate::gate::assess_command(c, context).rule == crate::gate::Rule::Dependencies)
    {
        return true;
    }
    // A shell wrapper can combine an install with a stricter action, hiding the install's rule.
    crate::gate::command_words(command).iter().any(|words| {
        words.iter().any(|w| {
            Path::new(w)
                .file_name()
                .is_some_and(|name| matches!(name.to_str(), Some("bash" | "sh" | "zsh" | "fish")))
        }) && words
            .windows(2)
            .any(|pair| pair[0].starts_with('-') && pair[0].contains('c') && installs_dependencies(&pair[1], context))
    })
}

fn lockfile_for(command: &str) -> &'static str {
    if command.contains("pnpm") {
        "pnpm-lock.yaml"
    } else if command.contains("yarn") {
        "yarn.lock"
    } else if command.contains("bun") {
        "bun.lock"
    } else if command.contains("cargo") {
        "Cargo.lock"
    } else if command.contains("uv ") {
        "uv.lock"
    } else if command.contains("poetry") {
        "poetry.lock"
    } else if command.contains("go ") {
        "go.sum"
    } else {
        "package-lock.json"
    }
}

pub fn allowed(app: &tauri::AppHandle, agent: &str, tool: &str, input: &serde_json::Value) -> Result<(), String> {
    // Recheck after a developer approval: a teammate may have reserved a file while waiting.
    check(app, agent, tool, input)?;
    let Some(raw) = edit_path(tool, input) else { return Ok(()) };
    let state = app.state::<crate::AppState>();
    let Some(workspace) = state.workdirs.lock().unwrap().get(agent).cloned() else {
        return Ok(());
    };
    let Ok(path) = resolve(&workspace, raw) else { return Ok(()) };
    let task = crate::tasks::active_task_for(app, agent);
    let conflict = state
        .claims
        .lock()
        .unwrap()
        .claim(&workspace, &path, agent, task.as_deref(), "edited it", false);
    if let Err(other) = conflict {
        let reason = format!(
            "{} has claimed {} ({}). Ask them to release it, or ask the task owner.",
            other.agent_id, other.path, other.reason
        );
        report(app, agent, &workspace, &reason);
        return Err(reason);
    }
    changed(app);
    Ok(())
}

pub fn after_edit(app: &tauri::AppHandle, agent: &str, tool: &str, input: &serde_json::Value) {
    let Some(raw) = edit_path(tool, input) else { return };
    let state = app.state::<crate::AppState>();
    let Some(workspace) = state.workdirs.lock().unwrap().get(agent).cloned() else {
        return;
    };
    let Ok(path) = resolve(&workspace, raw) else { return };
    let task = crate::tasks::active_task_for(app, agent);
    let sharing = shared(app, &workspace, agent);
    let problem = {
        let mut claims = state.claims.lock().unwrap();
        let problem = claims.check_edit(&workspace, &path, agent, sharing).err();
        // A sandbox edit already happened; retain its reservation whenever there is no other holder.
        let _ = claims.claim(&workspace, &path, agent, task.as_deref(), "edited it", false);
        problem
    };
    if let Some(reason) = problem {
        report(app, agent, &workspace, &reason);
        if let Some(id) = task {
            let e = state
                .ledger
                .add_task_event(&id, agent, "claim_overlap", &format!("The provider already edited this file. {reason}"), "");
            let _ = app.emit("tasks://event", e);
        }
    }
    changed(app);
}

pub fn tool(app: &tauri::AppHandle, agent: &str, paths: &[String], reason: &str, release: bool) -> Result<String, String> {
    let state = app.state::<crate::AppState>();
    let workspace = state
        .workdirs
        .lock()
        .unwrap()
        .get(agent)
        .cloned()
        .ok_or("Start work in a folder before claiming files.")?;
    let paths: Vec<String> = paths.iter().map(|p| resolve(&workspace, p)).collect::<Result<_, _>>()?;
    if release {
        state.claims.lock().unwrap().release(&workspace, agent, &paths);
        changed(app);
        return Ok("Released your file claims.".into());
    }
    if paths.is_empty() || reason.trim().is_empty() {
        return Err("Name files or folders and say why you need them.".into());
    }
    let task = crate::tasks::active_task_for(app, agent);
    let mut lines = Vec::new();
    for path in paths {
        let result = state.claims.lock().unwrap().claim(&workspace, &path, agent, task.as_deref(), reason, true);
        match result {
            Ok(()) => lines.push(format!("Claimed {path} exclusively.")),
            Err(other) => lines.push(format!(
                "{} holds {} ({}). Ask them to release it, or ask {}.",
                crate::prompts::agent_name(app, &other.agent_id),
                other.path,
                other.reason,
                crate::prompts::agent_name(app, &owner(app, agent))
            )),
        }
    }
    changed(app);
    Ok(lines.join("\n"))
}

pub fn ended(app: &tauri::AppHandle, agent: &str, task: Option<&str>) {
    let state = app.state::<crate::AppState>();
    let mut claims = state.claims.lock().unwrap();
    if let Some(task) = task {
        claims.release_task(task);
    } else {
        claims.release_agent(agent);
    }
    drop(claims);
    changed(app);
}

/// When the owner's task settles, every contributor's reservation ends too.
pub fn end_task_tree(app: &tauri::AppHandle, task_id: &str) {
    let state = app.state::<crate::AppState>();
    let mut pending = vec![task_id.to_string()];
    let mut claims = state.claims.lock().unwrap();
    while let Some(id) = pending.pop() {
        claims.release_task(&id);
        pending.extend(state.ledger.child_tasks(&id).into_iter().map(|child| child.id));
    }
    drop(claims);
    changed(app);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspaces::tests::Repo;

    #[test]
    fn implicit_edits_reserve_files_and_explicit_claims_are_exclusive() {
        let mut claims = Claims::default();
        claims.claim("/workspace", "src/form.tsx", "karen", Some("child"), "edited it", false).unwrap();
        assert!(!claims.list("/workspace")[0].exclusive);
        claims.claim("/workspace", "src/form.tsx", "karen", Some("child"), "Settings UI", true).unwrap();
        assert!(claims.list("/workspace")[0].exclusive);
        assert_eq!(claims.list("/workspace")[0].reason, "Settings UI");
        assert_eq!(claims.list("/workspace").len(), 1);
    }

    #[test]
    fn overlapping_files_and_folders_are_refused_with_actionable_reason() {
        let mut claims = Claims::default();
        claims.claim("/workspace", "src/settings", "karen", Some("child"), "Settings UI", true).unwrap();
        let reason = claims.check_edit("/workspace", "src/settings/Form.tsx", "vision", true).unwrap_err();
        assert!(reason.contains("karen has claimed src/settings (Settings UI)"));
        assert!(reason.contains("release"));
        assert!(claims.claim("/workspace", "src", "friday", Some("owner"), "Refactor", true).is_err());
        assert!(claims.check_edit("/workspace", "src/settings-other/Form.tsx", "vision", true).is_ok());
        assert!(claims.check_edit("/elsewhere", "src/settings/Form.tsx", "vision", true).is_ok());
    }

    #[test]
    fn releasing_files_tasks_and_sessions_preserves_other_contributors() {
        let mut claims = Claims::default();
        claims.claim("/workspace", "src/a", "karen", Some("child"), "UI", true).unwrap();
        claims.claim("/workspace", "src/b", "vision", Some("other"), "Backend", true).unwrap();
        claims.release("/workspace", "karen", &["src".into()]);
        assert_eq!(claims.list("/workspace").len(), 1);
        claims.claim("/workspace", "src/a", "karen", Some("child"), "UI", true).unwrap();
        claims.release_task("child");
        assert_eq!(claims.list("/workspace").len(), 1);
        claims.release_agent("vision");
        assert!(claims.list("/workspace").is_empty());
    }

    #[test]
    fn every_sensitive_pattern_needs_an_explicit_claim_when_sharing() {
        let repo = Repo::new();
        let mut paths: Vec<String> = LOCKFILES.iter().map(|p| p.to_string()).collect();
        paths.extend(
            [
                "db/migrations/a.sql",
                "db/migrate/a.sql",
                "alembic/versions/a.py",
                "dist/a.js",
                "build/a.js",
                "generated/a.rs",
                "__generated__/a.ts",
                "a.gen.rs",
                "a.generated.ts",
                "types.proto",
                "types.d.ts",
                "openapi.yaml",
                "schema.graphql",
                "schema.prisma",
            ]
            .map(String::from),
        );
        std::fs::write(Path::new(&repo.project).join("header.txt"), "// @generated\nbody").unwrap();
        std::fs::write(Path::new(&repo.project).join("other.txt"), "// DO NOT EDIT\nbody").unwrap();
        paths.extend(["header.txt".into(), "other.txt".into()]);
        for path in paths {
            assert!(sensitive(&repo.project, &path), "{path}");
            let mut claims = Claims::default();
            assert!(
                claims.check_edit(&repo.project, &path, "karen", false).is_ok(),
                "single-agent editing stays quiet"
            );
            assert!(claims.check_edit(&repo.project, &path, "karen", true).unwrap_err().contains("claim_files"));
            claims.claim(&repo.project, &path, "karen", Some("task"), "edited it", false).unwrap();
            assert!(claims.check_edit(&repo.project, &path, "karen", true).is_err(), "implicit isn't exclusive");
            claims
                .claim(&repo.project, &path, "karen", Some("task"), "Update generated code", true)
                .unwrap();
            assert!(claims.check_edit(&repo.project, &path, "karen", true).is_ok());
        }
        assert!(!sensitive(&repo.project, "src/regular.rs"));
        assert!(!sensitive(&repo.project, "migration-notes/readme.md"));
    }

    #[test]
    fn non_owner_git_mutations_are_refused_even_in_chains_and_wrappers() {
        let repo = Repo::new();
        let claims = Claims::default();
        for command in [
            "git commit -am change",
            "git checkout main",
            "git switch main",
            "git reset --hard",
            "git stash",
            "git merge main",
            "git rebase main",
            "git branch topic",
            "echo ready && git -C . switch main",
            "env X=1 /usr/bin/git -c color.ui=false commit",
            "bash -c 'git reset --hard'",
        ] {
            assert!(mutates_git(command), "{command}");
            assert!(claims
                .check_command(&repo.project, "karen", "friday", command)
                .unwrap_err()
                .contains("Only friday"));
            assert!(claims.check_command(&repo.project, "friday", "friday", command).is_ok());
        }
        for command in [
            "git status",
            "git diff",
            "git log -1",
            "printf 'git status'",
            "printf 'git commit'",
            "echo git commit",
        ] {
            assert!(claims.check_command(&repo.project, "karen", "friday", command).is_ok());
        }
    }

    #[test]
    fn dependency_commands_need_the_workspace_lockfile_claim() {
        let repo = Repo::new();
        std::fs::write(Path::new(&repo.project).join("package-lock.json"), "{}").unwrap();
        let mut claims = Claims::default();
        for command in ["npm install", "npm ci", "npm install && git push", "bash -lc 'npm install && git push'"] {
            assert!(claims
                .check_command(&repo.project, "karen", "karen", command)
                .unwrap_err()
                .contains("package-lock.json"));
        }
        claims
            .claim(&repo.project, "package-lock.json", "karen", Some("child"), "Dependencies", true)
            .unwrap();
        assert!(claims.check_command(&repo.project, "karen", "karen", "npm ci").is_ok());
        assert!(claims.check_command(&repo.project, "vision", "vision", "npm ci").is_err());
        assert!(claims.check_command(&repo.project, "vision", "vision", "npm test").is_ok());
    }

    #[test]
    fn path_aliases_are_normalized_and_outside_claims_refused() {
        let repo = Repo::new();
        assert_eq!(resolve(&repo.project, "src/../source.txt").unwrap(), "source.txt");
        assert_eq!(resolve(&repo.project, &format!("{}/source.txt", repo.project)).unwrap(), "source.txt");
        assert!(resolve(&repo.project, "../outside").is_err());
        assert!(resolve(&repo.project, "").is_err());
        std::os::unix::fs::symlink(&repo.project, Path::new(&repo.project).join("alias")).unwrap();
        assert_eq!(resolve(&repo.project, "alias/source.txt").unwrap(), "source.txt");
        std::os::unix::fs::symlink(&repo.root, Path::new(&repo.project).join("outside")).unwrap();
        assert!(resolve(&repo.project, "outside/new.txt").is_err());
    }
}
