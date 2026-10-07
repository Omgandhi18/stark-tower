//! Task workspaces, prepared before a session starts and removed only by the developer.
use crate::ledger::{Ledger, Task};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorktreeSetup {
    pub copy: Vec<String>,
    pub command: String,
}
impl Default for WorktreeSetup {
    fn default() -> Self {
        Self {
            copy: vec![".env*".into(), "node_modules".into()],
            command: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Worktree {
    pub path: String,
    pub project: String,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
    pub task_id: String,
    pub created: i64,
    pub removed: Option<i64>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct WorkspaceInfo {
    pub kind: String,
    pub path: String,
    pub project: String,
    pub branch: String,
    pub base: String,
    pub base_commit: String,
    pub decision: String,
    pub ahead: i64,
    pub changes: Vec<crate::tasks::FileChange>,
    pub unmerged: Vec<String>,
    pub removed: bool,
    pub removable: bool,
}

pub fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim_end().into())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().into())
    }
}

pub fn slug(text: &str) -> String {
    let words: Vec<_> = text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|s| !s.is_empty()).collect();
    let short: String = words.join("-").to_lowercase().chars().take(48).collect();
    if short.is_empty() {
        "task".into()
    } else {
        short.trim_end_matches('-').into()
    }
}

pub fn project_for(ledger: &Ledger, cwd: &str) -> String {
    ledger
        .worktrees()
        .into_iter()
        .filter(|w| Path::new(cwd).starts_with(&w.path))
        .max_by_key(|w| w.path.len())
        .map(|w| w.project)
        .unwrap_or_else(|| cwd.into())
}

pub fn needs_worktree(enabled: bool, repo: bool, writer: bool) -> bool {
    enabled && repo && writer
}

/// Who is already editing `cwd` for another task: another agent, or the same agent in another of its chats.
pub fn writer_in<'a>(tasks: &'a [Task], cwd: &str, task_id: &str) -> Option<&'a str> {
    tasks
        .iter()
        .find(|t| t.cwd == cwd && t.id != task_id && t.parent_id.is_none() && t.status == "doing")
        .map(|t| t.assignee.as_str())
}

fn copy_match(pattern: &str, name: &str) -> bool {
    if let Some(prefix) = pattern.strip_suffix('*') {
        name.starts_with(prefix)
    } else {
        pattern == name
    }
}

pub fn validate_setup(setup: &WorktreeSetup) -> Result<(), String> {
    for pattern in &setup.copy {
        if pattern.is_empty()
            || !Path::new(pattern).components().all(|c| matches!(c, Component::Normal(_)))
            || pattern.split('/').any(|p| p == ".git")
            || pattern.matches('*').count() > 1
            || (pattern.contains('*') && !pattern.ends_with('*'))
        {
            return Err("Use paths inside the project, with an optional * at the end. The .git folder can't be copied.".into());
        }
    }
    Ok(())
}

pub fn copy_files(project: &str, destination: &str, setup: &WorktreeSetup) -> Result<(), String> {
    validate_setup(setup)?;
    for pattern in &setup.copy {
        let p = Path::new(pattern);
        let parent = p.parent().unwrap_or(Path::new(""));
        let name = p.file_name().unwrap().to_string_lossy();
        let source_dir = Path::new(project).join(parent);
        let Ok(entries) = std::fs::read_dir(&source_dir) else { continue };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let filename = entry.file_name();
            if !copy_match(&name, &filename.to_string_lossy()) || filename == ".git" {
                continue;
            }
            let source = entry.path();
            let relative = parent.join(&filename);
            // Carry only ignored files; tracked files already came from HEAD.
            if git(project, &["check-ignore", "--", &relative.to_string_lossy()]).is_err() {
                continue;
            }
            let target = Path::new(destination).join(&relative);
            if target.symlink_metadata().is_ok() {
                continue;
            }
            std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            #[cfg(not(target_os = "macos"))]
            if filename == "node_modules" && source.is_dir() {
                std::os::unix::fs::symlink(&source, &target).map_err(|e| e.to_string())?;
                continue;
            }
            let mut cp = Command::new("cp");
            #[cfg(target_os = "macos")]
            cp.arg("-c");
            let out = cp.arg("-R").arg("--").arg(&source).arg(&target).output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).into());
            }
        }
    }
    Ok(())
}

pub fn create(project: &str, title: &str, task_id: &str, root: &Path) -> Result<Worktree, String> {
    let base = git(project, &["symbolic-ref", "--short", "HEAD"]).unwrap_or_else(|_| "HEAD".into());
    let base_commit = git(project, &["rev-parse", "HEAD"])?;
    let name = Path::new(project)
        .file_name()
        .map(|n| slug(&n.to_string_lossy()))
        .unwrap_or_else(|| "project".into());
    let tail: String = task_id.chars().rev().take(4).collect::<String>().chars().rev().collect();
    let stem = format!("{}-{}", slug(title), slug(&tail));
    let main = Path::new(project).canonicalize().map_err(|e| e.to_string())?;
    let resolved_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if resolved_root.starts_with(&main) {
        return Err("Worktrees must be created outside the project.".into());
    }
    let parent = root.join(name);
    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let mut n = 0;
    let (path, branch) = loop {
        let name = if n == 0 { stem.clone() } else { format!("{stem}-{n}") };
        let path = parent.join(&name);
        let branch = format!("starkline/{name}");
        if !path.exists() && git(project, &["show-ref", "--verify", &format!("refs/heads/{branch}")]).is_err() {
            break (path, branch);
        }
        n += 1;
    };
    let path = path.to_string_lossy().to_string();
    git(project, &["worktree", "add", "-b", &branch, &path, "HEAD"])?;
    Ok(Worktree {
        path,
        project: project.into(),
        branch,
        base,
        base_commit,
        task_id: task_id.into(),
        created: crate::ledger::now_ms(),
        removed: None,
    })
}

pub fn setup_command(cwd: &str, command: &str, app: Option<&tauri::AppHandle>) -> Result<String, String> {
    if command.trim().is_empty() {
        return Ok(String::new());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let mut cmd = Command::new(shell);
    cmd.args(["-lc", command])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    if let Some(app) = app {
        app.state::<crate::AppState>().oneshot_pids.lock().unwrap().insert(pid);
    }
    let output = child.wait_with_output();
    if let Some(app) = app {
        app.state::<crate::AppState>().oneshot_pids.lock().unwrap().remove(&pid);
    }
    let output = output.map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if output.status.success() {
        Ok(text)
    } else {
        Err(format!("Setup exited with {}. {text}", output.status))
    }
}

fn record(app: &tauri::AppHandle, task: &Task, summary: &str, data: &str) {
    let state = app.state::<crate::AppState>();
    let e = state.ledger.add_task_event(&task.id, &task.assignee, "workspace", summary, data);
    let _ = app.emit("tasks://event", e);
}

pub fn prepare(app: &tauri::AppHandle, task: &Task) -> Result<Task, String> {
    let state = app.state::<crate::AppState>();
    let _lock = state.workspace_lock.lock().unwrap();
    let task = state.ledger.task(&task.id).ok_or("That task doesn't exist.")?;
    if !task.workspace_kind.is_empty() {
        return Ok(task);
    }
    let mapped = project_for(&state.ledger, &task.cwd);
    let project = git(&mapped, &["rev-parse", "--show-toplevel"]).unwrap_or(mapped);
    let (enabled, setup) = {
        let config = state.config.lock().unwrap();
        (config.worktrees_enabled, config.worktree_setup.get(&project).cloned().unwrap_or_default())
    };
    let all_tasks = state.ledger.tasks(i64::MAX);
    let writer = writer_in(&all_tasks, &task.cwd, &task.id).map(str::to_string).or_else(|| crate::runs::busy_in_folder(app, &task.cwd).into_iter().next());
    let mut cwd = task.cwd.clone();
    let mut kind = "checkout";
    let repo = git(&cwd, &["rev-parse", "--show-toplevel"]).is_ok();
    let mut decision = if !repo {
        "This task is using this folder because it isn't a git repository.".into()
    } else if !enabled {
        "This task is using the current checkout because separate worktrees are turned off.".into()
    } else {
        "This task is using the current checkout because no other task is editing it.".into()
    };
    if needs_worktree(enabled, repo, writer.is_some()) {
        if let Some(writer) = writer {
            let root = PathBuf::from(std::env::var("HOME").map_err(|_| "Your home folder couldn't be found.")?).join(".starkline/worktrees");
            match create(&project, &task.title, &task.id, &root) {
                Ok(w) => {
                    state.ledger.save_worktree(&w)?;
                    cwd = w.path.clone();
                    kind = "worktree";
                    let name = crate::prompts::agent_name(app, &writer);
                    let project_name = Path::new(&project).file_name().unwrap_or_default().to_string_lossy();
                    decision = format!("A separate worktree was created because {name} is already working in {project_name}. It starts from {} at {}; your uncommitted changes in {project_name} aren't in it.", w.base, &w.base_commit[..7.min(w.base_commit.len())]);
                    if let Err(e) = copy_files(&project, &cwd, &setup) {
                        record(
                            app,
                            &task,
                            "Some files couldn't be carried into the worktree. Tell the agent what it needs.",
                            &e,
                        );
                    }
                    if !setup.command.trim().is_empty() {
                        match setup_command(&cwd, &setup.command, Some(app)) {
                            Ok(out) => record(app, &task, "Worktree setup finished", &out),
                            Err(e) => record(app, &task, "Worktree setup failed; the task will continue. The agent has been told.", &e),
                        }
                    }
                }
                Err(e) => decision = format!("This task is using the current checkout because a separate worktree couldn't be created: {e}"),
            }
        }
    }
    state.ledger.set_task_workspace(&task.id, &cwd, kind, &project)?;
    record(app, &task, &decision, "");
    // Reserve it before another task makes its workspace decision.
    state.ledger.set_task_status(&task.id, "doing", None);
    let _ = app.emit("workspaces://changed", ());
    state.ledger.task(&task.id).ok_or_else(|| "The workspace couldn't be saved.".into())
}

pub fn for_child(app: &tauri::AppHandle, id: &str, parent: Option<&str>) -> Option<Task> {
    let state = app.state::<crate::AppState>();
    let task = state.ledger.task(id)?;
    if let Some(parent) = parent.and_then(|id| state.ledger.task(id)) {
        let project = if parent.project_folder.is_empty() {
            project_for(&state.ledger, &parent.cwd)
        } else {
            parent.project_folder
        };
        let kind = if parent.workspace_kind.is_empty() {
            "checkout"
        } else {
            &parent.workspace_kind
        };
        state.ledger.set_task_workspace(id, &parent.cwd, kind, &project).ok()?;
        state.ledger.task(id)
    } else {
        prepare(app, &task).ok()
    }
}

pub fn info(ledger: &Ledger, task: &Task) -> WorkspaceInfo {
    let w = ledger.worktrees().into_iter().find(|w| w.path == task.cwd);
    let base = w.as_ref().map(|w| w.base.clone()).unwrap_or_default();
    let base_commit = w.as_ref().map(|w| w.base_commit.clone()).unwrap_or_default();
    let decision = ledger
        .task_events(&task.id, 400)
        .into_iter()
        .rev()
        .find(|e| e.kind == "workspace" && e.data.is_empty())
        .map(|e| e.summary)
        .unwrap_or_default();
    let ahead = if base_commit.is_empty() {
        0
    } else {
        git(&task.cwd, &["rev-list", "--count", &format!("{base_commit}..HEAD")])
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    };
    let unmerged = w.as_ref().and_then(|w| unmerged_commits(w).ok()).unwrap_or_default();
    WorkspaceInfo {
        kind: if task.workspace_kind.is_empty() {
            "checkout".into()
        } else {
            task.workspace_kind.clone()
        },
        path: task.cwd.clone(),
        project: if task.project_folder.is_empty() {
            task.cwd.clone()
        } else {
            task.project_folder.clone()
        },
        branch: crate::tasks::current_branch(&task.cwd).unwrap_or_else(|| task.branch.clone()),
        base,
        base_commit,
        decision,
        ahead,
        changes: crate::tasks::changes(&task.cwd),
        unmerged,
        removed: w.as_ref().is_some_and(|w| w.removed.is_some()),
        removable: w.is_some() && matches!(task.status.as_str(), "done" | "reviewed" | "closed"),
    }
}

fn unmerged_commits(w: &Worktree) -> Result<Vec<String>, String> {
    // Keep commits that are neither merged into the base nor reachable on a remote.
    let base = if w.base != "HEAD" && git(&w.path, &["rev-parse", "--verify", &w.base]).is_ok() {
        &w.base
    } else {
        &w.base_commit
    };
    git(&w.path, &["log", "--format=%h %s", "HEAD", "--not", base, "--remotes"]).map(|output| output.lines().map(str::to_string).collect())
}

pub fn remove(ledger: &Ledger, task: &Task, force: bool) -> Result<(), String> {
    let w = ledger
        .worktrees()
        .into_iter()
        .find(|w| w.path == task.cwd && w.removed.is_none())
        .ok_or("This worktree has already been removed.")?;
    if !matches!(task.status.as_str(), "done" | "reviewed" | "closed") {
        return Err("Finish, review or close the task before removing its worktree.".into());
    }
    if ledger
        .tasks(i64::MAX)
        .iter()
        .any(|t| t.cwd == w.path && matches!(t.status.as_str(), "doing" | "todo"))
    {
        return Err("An agent still has work in this worktree. Stop or finish that work first.".into());
    }
    if !force {
        let dirty = git(&w.path, &["status", "--porcelain=v1", "--untracked-files=all"])?;
        let unmerged = unmerged_commits(&w)?;
        if !dirty.is_empty() || !unmerged.is_empty() {
            return Err("This worktree has uncommitted changes or unmerged commits. Review them and choose Remove anyway to continue.".into());
        }
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(&w.path);
    git(&w.project, &args)?;
    ledger.mark_worktree_removed(&w.path);
    Ok(())
}

pub fn reconcile(ledger: &Ledger) {
    for w in ledger.worktrees().into_iter().filter(|w| w.removed.is_none()) {
        if !Path::new(&w.path).is_dir() {
            ledger.mark_worktree_removed(&w.path);
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::ledger::NewTask;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    pub(crate) struct Repo {
        pub root: PathBuf,
        pub project: String,
        pub ledger: Ledger,
    }
    impl Repo {
        pub(crate) fn new() -> Self {
            let root = std::env::temp_dir().join(format!("starkline-workspaces-{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
            let project = root.join("my project");
            std::fs::create_dir_all(&project).unwrap();
            let project = project.to_string_lossy().to_string();
            git(&project, &["init", "-b", "main"]).unwrap();
            git(&project, &["config", "user.name", "Workspace tests"]).unwrap();
            git(&project, &["config", "user.email", "test@localhost"]).unwrap();
            std::fs::write(Path::new(&project).join(".gitignore"), ".env*\nnode_modules/\n").unwrap();
            std::fs::write(Path::new(&project).join("source.txt"), "initial\n").unwrap();
            git(&project, &["add", "."]).unwrap();
            git(&project, &["commit", "-m", "Initial"]).unwrap();
            let ledger = Ledger::open(&root.join("ledger.db")).unwrap();
            Self { root, project, ledger }
        }
        pub(crate) fn task(&self, id: &str, agent: &str, status: &str, parent: Option<&str>) -> Task {
            self.ledger
                .create_task(&NewTask {
                    id,
                    assignee: agent,
                    title: "Fix login!",
                    status,
                    cwd: &self.project,
                    parent_id: parent,
                    requested_by: "you",
                    prompt: "Fix login",
                })
                .unwrap()
        }
        fn worktree(&self, id: &str) -> (Worktree, Task) {
            let task = self.task(id, "vision", "done", None);
            let w = create(&self.project, &task.title, id, &self.root.join("worktrees")).unwrap();
            self.ledger.save_worktree(&w).unwrap();
            self.ledger.set_task_workspace(id, &w.path, "worktree", &self.project).unwrap();
            (w, self.ledger.task(id).unwrap())
        }
    }
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn decisions_count_only_another_running_top_level_writer() {
        let r = Repo::new();
        assert!(!needs_worktree(true, true, false));
        assert!(needs_worktree(true, true, true));
        assert!(!needs_worktree(false, true, true));
        assert!(!needs_worktree(true, false, true));
        let mut tasks = vec![
            r.task("done", "karen", "done", None),
            r.task("queued", "edith", "todo", None),
            r.task("blocked", "friday", "blocked", None),
            r.task("child", "edith", "doing", Some("done")),
        ];
        assert!(writer_in(&tasks, &r.project, "new").is_none());
        tasks.push(r.task("running", "friday", "doing", None));
        assert_eq!(writer_in(&tasks, &r.project, "new"), Some("friday"));
        assert!(writer_in(&tasks, &r.project, "running").is_none(), "a task isn't in its own way");
        assert!(writer_in(&tasks, &format!("{}/nested", r.project), "new").is_none());
        // The same agent in another of its chats is a writer too: a second chat gets its own worktree.
        assert_eq!(writer_in(&tasks, &r.project, "friday-second-chat"), Some("friday"));
    }

    #[test]
    fn creation_names_branches_handles_collisions_and_leaves_local_changes_behind() {
        let r = Repo::new();
        std::fs::write(Path::new(&r.project).join("source.txt"), "local edits\n").unwrap();
        let first = create(&r.project, "Fix LOGIN!", "task-abcd", &r.root.join("worktrees")).unwrap();
        assert_eq!(first.branch, "starkline/fix-login-abcd");
        assert!(first.path.ends_with("worktrees/my-project/fix-login-abcd"));
        assert!(!first.path.contains(' '));
        assert_eq!(first.base, "main");
        assert_eq!(std::fs::read_to_string(Path::new(&first.path).join("source.txt")).unwrap(), "initial\n");
        let second = create(&r.project, "Fix LOGIN!", "task-abcd", &r.root.join("worktrees")).unwrap();
        assert_eq!(second.branch, "starkline/fix-login-abcd-1");
    }

    #[test]
    fn ignored_files_and_setup_are_prepared_before_work() {
        let r = Repo::new();
        let (w, _) = r.worktree("envs");
        std::fs::write(Path::new(&r.project).join(".env.local"), "SECRET=local").unwrap();
        std::fs::create_dir(Path::new(&r.project).join("node_modules")).unwrap();
        std::fs::write(Path::new(&r.project).join("node_modules/pkg"), "package").unwrap();
        copy_files(&r.project, &w.path, &WorktreeSetup::default()).unwrap();
        assert_eq!(std::fs::read_to_string(Path::new(&w.path).join(".env.local")).unwrap(), "SECRET=local");
        assert!(Path::new(&w.path).join("node_modules/pkg").is_file());
        #[cfg(not(target_os = "macos"))]
        assert!(Path::new(&w.path).join("node_modules").is_symlink());
        assert_eq!(
            setup_command(&w.path, "printf prepared > ready; printf 'setup done'", None).unwrap(),
            "setup done"
        );
        assert!(Path::new(&w.path).join("ready").is_file());
        assert!(setup_command(&w.path, "printf 'missing dependency' >&2; exit 4", None)
            .unwrap_err()
            .contains("missing dependency"));
        for bad in ["../secret", "/tmp/secret", ".git", ".git/config", "foo/*/bar"] {
            assert!(
                validate_setup(&WorktreeSetup {
                    copy: vec![bad.into()],
                    command: String::new()
                })
                .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn failed_creation_does_not_change_the_checkout() {
        let r = Repo::new();
        git(&r.project, &["config", "core.hooksPath", "/dev/null"]).unwrap();
        let invalid = r.root.join("file");
        std::fs::write(&invalid, "not a folder").unwrap();
        assert!(create(&r.project, "Fix", "fail", &invalid).is_err());
        assert_eq!(git(&r.project, &["branch", "--show-current"]).unwrap(), "main");
        // Git cannot register a worktree when its metadata folder is a regular file.
        std::fs::write(Path::new(&r.project).join(".git/worktrees"), "unavailable").unwrap();
        let failure = create(&r.project, "Git add fails", "fail", &r.root.join("worktrees")).unwrap_err();
        assert!(!failure.is_empty());
        assert_eq!(git(&r.project, &["branch", "--show-current"]).unwrap(), "main");
        assert!(Path::new(&r.project).join("source.txt").exists());
    }

    #[test]
    fn removal_requires_finished_work_and_explicit_force_and_keeps_the_branch() {
        let r = Repo::new();
        let (w, task) = r.worktree("dirty");
        std::fs::write(Path::new(&w.path).join("new.txt"), "work").unwrap();
        assert!(remove(&r.ledger, &task, false).is_err());
        assert!(Path::new(&w.path).exists());
        remove(&r.ledger, &task, true).unwrap();
        assert!(!Path::new(&w.path).exists());
        assert!(git(&r.project, &["show-ref", "--verify", &format!("refs/heads/{}", w.branch)]).is_ok());
        assert!(r.ledger.worktrees()[0].removed.is_some());
        let (clean, task) = r.worktree("clean");
        remove(&r.ledger, &task, false).unwrap();
        assert!(!Path::new(&clean.path).exists());
        let (active, task) = r.worktree("active");
        r.ledger.set_task_status(&task.id, "doing", None);
        assert!(remove(&r.ledger, &r.ledger.task(&task.id).unwrap(), true).is_err());
        assert!(Path::new(&active.path).exists());
    }

    #[test]
    fn unmerged_commits_require_force_and_mapping_survives_removal() {
        let r = Repo::new();
        let (w, task) = r.worktree("merge");
        std::fs::write(Path::new(&w.path).join("source.txt"), "committed\n").unwrap();
        git(&w.path, &["commit", "-am", "Work to keep"]).unwrap();
        let summary = info(&r.ledger, &task);
        assert_eq!(summary.ahead, 1);
        assert_eq!(summary.unmerged.len(), 1);
        assert!(remove(&r.ledger, &task, false).is_err());
        assert_eq!(project_for(&r.ledger, &format!("{}/src", w.path)), r.project);
        let rule = r
            .ledger
            .add_rule(
                "project",
                None,
                Some(&r.project),
                &crate::policy::RuleKey {
                    tool: "Bash".into(),
                    pattern: "npm install".into(),
                    display: "Install".into(),
                },
                "Dependencies",
                "approval",
            )
            .unwrap();
        assert!(crate::policy::applies(&rule, None, &project_for(&r.ledger, &w.path)));
        remove(&r.ledger, &task, true).unwrap();
        assert_eq!(project_for(&r.ledger, &w.path), r.project);
    }

    #[test]
    fn worktree_and_task_workspace_round_trip_and_vanished_folders_are_recorded() {
        let r = Repo::new();
        let (w, task) = r.worktree("stored");
        assert_eq!(task.project_folder, r.project);
        assert_eq!(task.workspace_kind, "worktree");
        let conversation = r.ledger.create_conversation("vision", &w.path, "Fix");
        let chat = r.ledger.conversation(conversation).unwrap();
        assert_eq!(chat.project_folder, r.project);
        assert_eq!(chat.branch, w.branch);
        assert_eq!(r.ledger.worktrees()[0].base_commit, w.base_commit);
        std::fs::remove_dir_all(&w.path).unwrap();
        reconcile(&r.ledger);
        assert!(r.ledger.worktrees()[0].removed.is_some());
    }
}
