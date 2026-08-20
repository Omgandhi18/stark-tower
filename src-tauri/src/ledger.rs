use rusqlite::Connection;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Durable audit trail of everything the tower does. The `load` column is an
/// abstract "reactor draw" figure (Claude Max is flat-rate, so this tracks
/// activity, not dollars).
pub struct Ledger {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct LedgerEntry {
    pub id: i64,
    pub ts: i64,
    pub agent_id: String,
    pub kind: String,
    pub detail: String,
    pub load: i64,
}

/// One persisted chat turn — enough to rebuild the transcript UI on reopen.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct StoredMessage {
    pub id: i64,
    pub ts: i64,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// A durable task card on the board. Delegations create one (`doing`) and close
/// it (`done` / `blocked`) so in-flight work is trackable across turns and
/// survives the UI closing — the flow upgrade munder-difflin's tasks.json gives.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Task {
    pub id: String,
    pub ts: i64,
    pub updated: i64,
    pub title: String,
    pub assignee: String,
    /// todo | doing | blocked | done
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Ledger {
    pub fn open(path: &std::path::Path) -> rusqlite::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS ledger (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       INTEGER NOT NULL,
                agent_id TEXT    NOT NULL,
                kind     TEXT    NOT NULL,
                detail   TEXT    NOT NULL,
                load     INTEGER NOT NULL DEFAULT 0
            )",
            [],
        )?;
        // Full chat transcript, per agent, so a conversation survives the UI
        // closing and can be shown again on reopen.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS messages (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                ts       INTEGER NOT NULL,
                agent_id TEXT    NOT NULL,
                role     TEXT    NOT NULL,
                text     TEXT,
                tool     TEXT,
                detail   TEXT
            )",
            [],
        )?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id, id)",
            [],
        )?;
        // Latest Claude Code session id per (agent, cwd), so continuing a chat
        // resumes the real conversation with its full context.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS sessions (
                agent_id   TEXT    NOT NULL,
                cwd        TEXT    NOT NULL,
                session_id TEXT    NOT NULL,
                updated    INTEGER NOT NULL,
                PRIMARY KEY (agent_id, cwd)
            )",
            [],
        )?;
        // The task board: durable cards for delegated work (todo/doing/blocked/done).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS tasks (
                id       TEXT    PRIMARY KEY,
                ts       INTEGER NOT NULL,
                updated  INTEGER NOT NULL,
                title    TEXT    NOT NULL,
                assignee TEXT    NOT NULL,
                status   TEXT    NOT NULL,
                detail   TEXT
            )",
            [],
        )?;
        Ok(Ledger {
            conn: Mutex::new(conn),
        })
    }

    /// Create or update a task card (idempotent by id; preserves the original
    /// created-at `ts` when updating).
    pub fn upsert_task(&self, id: &str, title: &str, assignee: &str, status: &str, detail: Option<&str>) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO tasks (id, ts, updated, title, assignee, status, detail) \
             VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6) \
             ON CONFLICT(id) DO UPDATE SET \
               updated = excluded.updated, title = excluded.title, \
               assignee = excluded.assignee, status = excluded.status, detail = excluded.detail",
            rusqlite::params![id, ts, title, assignee, status, detail],
        );
    }

    /// Move a task to a new status (no-op if the id is unknown).
    pub fn set_task_status(&self, id: &str, status: &str, detail: Option<&str>) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET status = ?2, updated = ?3, \
             detail = COALESCE(?4, detail) WHERE id = ?1",
            rusqlite::params![id, status, ts, detail],
        );
    }

    /// The most recent `limit` task cards, newest first.
    pub fn tasks(&self, limit: i64) -> Vec<Task> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, ts, updated, title, assignee, status, detail FROM tasks \
             ORDER BY updated DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map([limit], |r| {
            Ok(Task {
                id: r.get(0)?,
                ts: r.get(1)?,
                updated: r.get(2)?,
                title: r.get(3)?,
                assignee: r.get(4)?,
                status: r.get(5)?,
                detail: r.get(6)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// Append one chat message to the durable transcript.
    pub fn add_message(
        &self,
        agent_id: &str,
        role: &str,
        text: Option<&str>,
        tool: Option<&str>,
        detail: Option<&str>,
    ) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO messages (ts, agent_id, role, text, tool, detail) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![ts, agent_id, role, text, tool, detail],
        );
    }

    /// The last `limit` messages for an agent, in chronological order.
    pub fn messages(&self, agent_id: &str, limit: i64) -> Vec<StoredMessage> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, ts, role, text, tool, detail FROM messages \
             WHERE agent_id = ?1 ORDER BY id DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(rusqlite::params![agent_id, limit], |r| {
            Ok(StoredMessage {
                id: r.get(0)?,
                ts: r.get(1)?,
                role: r.get(2)?,
                text: r.get(3)?,
                tool: r.get(4)?,
                detail: r.get(5)?,
            })
        });
        let mut v: Vec<StoredMessage> = match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        v.reverse(); // DESC query → back to chronological
        v
    }

    /// Wipe an agent's transcript and resume pointer (the reset button).
    pub fn clear_agent(&self, agent_id: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM messages WHERE agent_id = ?1", [agent_id]);
        let _ = conn.execute("DELETE FROM sessions WHERE agent_id = ?1", [agent_id]);
    }

    /// Remember the Claude Code session id for (agent, cwd) so we can resume it.
    pub fn set_session(&self, agent_id: &str, cwd: &str, session_id: &str) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO sessions (agent_id, cwd, session_id, updated) VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(agent_id, cwd) DO UPDATE SET session_id = excluded.session_id, updated = excluded.updated",
            rusqlite::params![agent_id, cwd, session_id, ts],
        );
    }

    /// Forget only the resume pointer for (agent, cwd), keeping the transcript.
    /// Used when a stored session id no longer resolves, so the next message
    /// starts a fresh session instead of re-resuming a dead one forever.
    pub fn forget_session(&self, agent_id: &str, cwd: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "DELETE FROM sessions WHERE agent_id = ?1 AND cwd = ?2",
            rusqlite::params![agent_id, cwd],
        );
    }

    /// The session id to resume for (agent, cwd), if any.
    pub fn get_session(&self, agent_id: &str, cwd: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT session_id FROM sessions WHERE agent_id = ?1 AND cwd = ?2",
            rusqlite::params![agent_id, cwd],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    /// Insert an event and return the persisted row (so it can be emitted live).
    pub fn record(&self, agent_id: &str, kind: &str, detail: &str, load: i64) -> LedgerEntry {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO ledger (ts, agent_id, kind, detail, load) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![ts, agent_id, kind, detail, load],
        );
        let id = conn.last_insert_rowid();
        LedgerEntry {
            id,
            ts,
            agent_id: agent_id.into(),
            kind: kind.into(),
            detail: detail.into(),
            load,
        }
    }

    pub fn recent(&self, limit: i64) -> Vec<LedgerEntry> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, ts, agent_id, kind, detail, load FROM ledger ORDER BY id DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map([limit], |r| {
            Ok(LedgerEntry {
                id: r.get(0)?,
                ts: r.get(1)?,
                agent_id: r.get(2)?,
                kind: r.get(3)?,
                detail: r.get(4)?,
                load: r.get(5)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);
    fn temp_db() -> (Ledger, std::path::PathBuf) {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("stark-led-{}-{n}.db", std::process::id()));
        let _ = std::fs::remove_file(&p);
        (Ledger::open(&p).unwrap(), p)
    }

    #[test]
    fn messages_roundtrip_in_chronological_order() {
        let (l, p) = temp_db();
        l.add_message("a", "user", Some("hi"), None, None);
        l.add_message("a", "agent", Some("yo"), None, None);
        let msgs = l.messages("a", 10);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text.as_deref(), Some("hi"));
        assert_eq!(msgs[1].text.as_deref(), Some("yo"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn session_set_get_forget() {
        let (l, p) = temp_db();
        assert!(l.get_session("a", "/x").is_none());
        l.set_session("a", "/x", "sid-1");
        assert_eq!(l.get_session("a", "/x").as_deref(), Some("sid-1"));
        l.forget_session("a", "/x");
        assert!(l.get_session("a", "/x").is_none());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn clear_agent_wipes_messages_and_sessions() {
        let (l, p) = temp_db();
        l.add_message("a", "user", Some("hi"), None, None);
        l.set_session("a", "/x", "sid");
        l.clear_agent("a");
        assert!(l.messages("a", 10).is_empty());
        assert!(l.get_session("a", "/x").is_none());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn task_lifecycle_upsert_then_status() {
        let (l, p) = temp_db();
        l.upsert_task("t1", "Review ats", "edith", "doing", None);
        let ts = l.tasks(10);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].status, "doing");
        assert_eq!(ts[0].assignee, "edith");
        l.set_task_status("t1", "done", Some("looks good"));
        let ts = l.tasks(10);
        assert_eq!(ts[0].status, "done");
        assert_eq!(ts[0].detail.as_deref(), Some("looks good"));
        // upsert is idempotent by id — no duplicate card
        l.upsert_task("t1", "Review ats", "edith", "blocked", None);
        assert_eq!(l.tasks(10).len(), 1);
        std::fs::remove_file(&p).ok();
    }
}
