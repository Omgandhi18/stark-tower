//! The floor: a git-versioned, single-committer directory under the app data dir
//! that makes a run observable and recoverable. This is the first slice of
//! munder-difflin's hive substrate — an append-only `log.jsonl` event feed plus
//! per-agent `inbox/`/`outbox/` scaffolding for a future file-based actor model.
//!
//! Only the main process ever writes or commits here (single-committer), so
//! there's no `.git/index.lock` race. Git is best-effort: if the binary is
//! missing the log still accumulates, it just isn't versioned.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set whenever the floor changes, so the background committer knows to commit.
static DIRTY: AtomicBool = AtomicBool::new(false);

fn floor_path(base: &str) -> PathBuf {
    Path::new(base).join("floor")
}

/// Create the floor layout, git-init it (best-effort), and seed per-agent dirs.
/// Returns the absolute floor path.
pub fn init(base: &str, agent_ids: &[String]) -> String {
    let floor = floor_path(base);
    let _ = std::fs::create_dir_all(floor.join("agents"));
    let log = floor.join("log.jsonl");
    if !log.exists() {
        let _ = std::fs::write(&log, "");
    }
    let board = floor.join("board.md");
    if !board.exists() {
        let _ = std::fs::write(&board, "# Floor\n\nShared blackboard.\n");
    }
    for id in agent_ids {
        ensure_agent(&floor, id);
    }
    git_init(&floor);
    commit(&floor, "floor: init");
    floor.to_string_lossy().to_string()
}

fn ensure_agent(floor: &Path, id: &str) {
    let a = floor.join("agents").join(id);
    for sub in ["inbox/.done", "outbox/.sent"] {
        let _ = std::fs::create_dir_all(a.join(sub));
    }
}

/// Ensure a (possibly newly-added) agent has its mailbox dirs.
pub fn ensure_agent_dirs(floor_dir: &str, id: &str) {
    ensure_agent(Path::new(floor_dir), id);
    DIRTY.store(true, Ordering::Relaxed);
}

/// Append one event to the feed and mark the floor dirty for the next commit.
pub fn log_event(floor_dir: &str, ts: i64, agent_id: &str, kind: &str, detail: &str) {
    if floor_dir.is_empty() {
        return;
    }
    let line = serde_json::json!({
        "ts": ts, "agent": agent_id, "kind": kind, "detail": detail,
    });
    let path = Path::new(floor_dir).join("log.jsonl");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{line}");
        DIRTY.store(true, Ordering::Relaxed);
    }
}

fn git(floor: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .current_dir(floor)
        .args(args)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn git_init(floor: &Path) {
    if floor.join(".git").exists() {
        return;
    }
    if git(floor, &["init", "-q"]) {
        let _ = git(floor, &["config", "user.email", "floor@stark-tower.local"]);
        let _ = git(floor, &["config", "user.name", "Stark Tower"]);
    }
}

/// Stage and commit the floor (best-effort; a no-op if nothing changed or git
/// isn't available).
pub fn commit(floor: &Path, message: &str) {
    if !floor.join(".git").exists() {
        return;
    }
    if git(floor, &["add", "-A"]) {
        let _ = git(floor, &["commit", "-q", "-m", message]);
    }
}

/// Background committer: every few seconds, if the floor changed, commit it. As
/// the sole committer it never races on `.git/index.lock`.
pub fn start_committer(floor_dir: String) {
    std::thread::spawn(move || {
        let floor = PathBuf::from(&floor_dir);
        loop {
            std::thread::sleep(std::time::Duration::from_secs(8));
            if DIRTY.swap(false, Ordering::Relaxed) {
                commit(&floor, "floor: update");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);
    fn tmp_base() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let d = std::env::temp_dir().join(format!("stark-floor-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn init_creates_layout_and_agent_dirs() {
        let base = tmp_base();
        let bs = base.to_string_lossy().to_string();
        let floor = init(&bs, &["jarvis".into(), "friday".into()]);
        let f = Path::new(&floor);
        assert!(f.join("log.jsonl").exists());
        assert!(f.join("board.md").exists());
        assert!(f.join("agents/jarvis/inbox").exists());
        assert!(f.join("agents/friday/outbox").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn log_event_appends_a_line() {
        let base = tmp_base();
        let bs = base.to_string_lossy().to_string();
        let floor = init(&bs, &[]);
        log_event(&floor, 1, "friday", "task", "review ats");
        log_event(&floor, 2, "friday", "task", "done");
        let body = std::fs::read_to_string(Path::new(&floor).join("log.jsonl")).unwrap();
        assert_eq!(body.lines().count(), 2);
        assert!(body.contains("review ats"));
        std::fs::remove_dir_all(&base).ok();
    }
}
