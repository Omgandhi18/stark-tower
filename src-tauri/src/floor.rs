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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Set whenever the floor changes, so the background committer knows to commit.
static DIRTY: AtomicBool = AtomicBool::new(false);
/// Monotonic suffix so two messages in the same millisecond get distinct ids.
static MSG_SEQ: AtomicU64 = AtomicU64::new(1);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A routed message, as read from a mailbox.
#[derive(Debug, Clone)]
pub struct Message {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub body: String,
}

fn write_atomic(path: &Path, contents: &str) -> bool {
    let tmp = path.with_extension("json.floortmp");
    std::fs::write(&tmp, contents).is_ok() && std::fs::rename(&tmp, path).is_ok()
}

/// Drop a message into `from`'s outbox for the router to deliver. Returns its id.
pub fn enqueue(floor_dir: &str, from: &str, to: &str, kind: &str, body: &str) -> String {
    let ts = now_ms();
    let seq = MSG_SEQ.fetch_add(1, Ordering::Relaxed);
    let id = format!("{ts}-{seq}");
    let msg = serde_json::json!({
        "id": id, "from": from, "to": to, "kind": kind, "body": body, "ts": ts,
    });
    let out = Path::new(floor_dir).join("agents").join(from).join("outbox");
    let _ = std::fs::create_dir_all(&out);
    if write_atomic(&out.join(format!("{id}.json")), &msg.to_string()) {
        DIRTY.store(true, Ordering::Relaxed);
    }
    id
}

/// Single-mover router: move every outbox message into its recipient's inbox,
/// forcing `from` to the owning directory (anti-spoof) and archiving the original
/// to `outbox/.sent/`. Best-effort; malformed files are left in place.
pub fn route_once(floor_dir: &str) -> Vec<Message> {
    let mut delivered = Vec::new();
    let agents = Path::new(floor_dir).join("agents");
    let Ok(dirs) = std::fs::read_dir(&agents) else {
        return delivered;
    };
    for owner in dirs.flatten() {
        let from = owner.file_name().to_string_lossy().to_string();
        let outbox = owner.path().join("outbox");
        let Ok(files) = std::fs::read_dir(&outbox) else { continue };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("json") {
                continue; // skip .sent/ and non-messages
            }
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
            let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&txt) else { continue };
            v["from"] = serde_json::Value::String(from.clone()); // the dir is authoritative
            let to = v.get("to").and_then(|t| t.as_str()).unwrap_or("").to_string();
            let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("msg").to_string();
            if to.is_empty() {
                continue;
            }
            let inbox = agents.join(&to).join("inbox");
            let _ = std::fs::create_dir_all(&inbox);
            if write_atomic(&inbox.join(format!("{id}.json")), &v.to_string()) {
                let sent = outbox.join(".sent");
                let _ = std::fs::create_dir_all(&sent);
                let _ = std::fs::rename(&p, sent.join(format!("{id}.json")));
                delivered.push(Message {
                    id,
                    from: from.clone(),
                    to,
                    kind: v.get("kind").and_then(|k| k.as_str()).unwrap_or("message").to_string(),
                    body: v.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string(),
                });
                DIRTY.store(true, Ordering::Relaxed);
            }
        }
    }
    delivered
}

/// Drain an agent's inbox: return its undelivered messages and archive them to
/// `inbox/.done/` (the archive IS the cursor — a message is drained exactly once).
pub fn drain_inbox(floor_dir: &str, agent_id: &str) -> Vec<Message> {
    let mut out = Vec::new();
    let inbox = Path::new(floor_dir).join("agents").join(agent_id).join("inbox");
    let Ok(files) = std::fs::read_dir(&inbox) else {
        return out;
    };
    let done = inbox.join(".done");
    let _ = std::fs::create_dir_all(&done);
    for f in files.flatten() {
        let p = f.path();
        if p.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(txt) = std::fs::read_to_string(&p) else { continue };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
            let id = v.get("id").and_then(|i| i.as_str()).unwrap_or("msg").to_string();
            out.push(Message {
                id: id.clone(),
                from: v.get("from").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                to: agent_id.to_string(),
                kind: v.get("kind").and_then(|x| x.as_str()).unwrap_or("message").to_string(),
                body: v.get("body").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
            let _ = std::fs::rename(&p, done.join(format!("{id}.json")));
            DIRTY.store(true, Ordering::Relaxed);
        }
    }
    out
}

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

    #[test]
    fn enqueue_route_drain_round_trip() {
        let base = tmp_base();
        let bs = base.to_string_lossy().to_string();
        let floor = init(&bs, &["friday".into(), "edith".into()]);

        enqueue(&floor, "friday", "edith", "message", "can you check db.rs?");
        // before routing, edith's inbox is empty
        assert!(drain_inbox(&floor, "edith").is_empty());

        let delivered = route_once(&floor);
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].to, "edith");
        assert_eq!(delivered[0].from, "friday");

        let msgs = drain_inbox(&floor, "edith");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].body, "can you check db.rs?");
        // draining is idempotent — the message is archived to .done
        assert!(drain_inbox(&floor, "edith").is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn router_forces_from_to_the_owning_dir() {
        let base = tmp_base();
        let bs = base.to_string_lossy().to_string();
        let floor = init(&bs, &["friday".into(), "edith".into()]);
        // friday spoofs from=edith; the router must overwrite it with the dir owner.
        let out = Path::new(&floor).join("agents/friday/outbox/x.json");
        std::fs::write(
            &out,
            r#"{"id":"x","from":"edith","to":"edith","kind":"message","body":"spoof"}"#,
        )
        .unwrap();
        route_once(&floor);
        let msgs = drain_inbox(&floor, "edith");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].from, "friday"); // not the spoofed "edith"
        std::fs::remove_dir_all(&base).ok();
    }
}
