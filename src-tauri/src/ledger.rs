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

#[derive(Debug, Clone, Serialize)]
pub struct LedgerEntry {
    pub id: i64,
    pub ts: i64,
    pub agent_id: String,
    pub kind: String,
    pub detail: String,
    pub load: i64,
}

/// One persisted chat turn — enough to rebuild the transcript UI on reopen.
#[derive(Debug, Clone, Serialize)]
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
        Ok(Ledger {
            conn: Mutex::new(conn),
        })
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
