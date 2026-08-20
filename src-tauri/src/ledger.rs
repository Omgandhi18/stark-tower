use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Durable audit trail of everything the tower does. The `load` column is an
/// abstract "reactor draw" figure (Claude Max is flat-rate, so this tracks
/// activity, not dollars).
pub struct Ledger {
    conn: Mutex<Connection>,
    /// The conversation each agent is currently talking in (agent id → conv id).
    active: Mutex<HashMap<String, i64>>,
}

/// A saved chat — one continuous conversation with an agent, resumable later.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Conversation {
    pub id: i64,
    pub agent_id: String,
    pub title: String,
    pub cwd: String,
    pub created: i64,
    pub updated: i64,
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

/// A bug in the app, reported by an agent for the maintenance agent to fix.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Bug {
    pub id: i64,
    pub reporter: String,
    pub title: String,
    pub detail: String,
    /// open | doing | fixed | wontfix
    pub status: String,
    pub created: i64,
    pub updated: i64,
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
        // Saved chats: one continuous, resumable conversation with an agent. Each
        // message belongs to a conversation; the session id (for --resume) lives
        // here so opening a past chat continues its real context.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS conversations (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id   TEXT    NOT NULL,
                title      TEXT    NOT NULL,
                cwd        TEXT    NOT NULL DEFAULT '',
                session_id TEXT,
                created    INTEGER NOT NULL,
                updated    INTEGER NOT NULL
            )",
            [],
        )?;
        // Migrate: add messages.conversation_id, then backfill one conversation
        // per agent for any pre-conversation transcript.
        let has_conv = conn
            .prepare("SELECT 1 FROM pragma_table_info('messages') WHERE name='conversation_id'")
            .and_then(|mut s| s.exists([]))
            .unwrap_or(true);
        if !has_conv {
            conn.execute("ALTER TABLE messages ADD COLUMN conversation_id INTEGER", [])?;
            // one conversation per distinct agent with orphaned messages
            let agents: Vec<String> = {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT agent_id FROM messages WHERE conversation_id IS NULL",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.filter_map(|x| x.ok()).collect()
            };
            let ts = now_ms();
            for a in agents {
                conn.execute(
                    "INSERT INTO conversations (agent_id, title, cwd, created, updated) \
                     VALUES (?1, 'Chat', '', ?2, ?2)",
                    rusqlite::params![a, ts],
                )?;
                let cid = conn.last_insert_rowid();
                conn.execute(
                    "UPDATE messages SET conversation_id = ?1 \
                     WHERE agent_id = ?2 AND conversation_id IS NULL",
                    rusqlite::params![cid, a],
                )?;
            }
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id)",
            [],
        )?;
        // Bugs agents report about the app, for the maintenance agent to fix.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS bugs (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                reporter TEXT    NOT NULL,
                title    TEXT    NOT NULL,
                detail   TEXT    NOT NULL DEFAULT '',
                status   TEXT    NOT NULL DEFAULT 'open',
                created  INTEGER NOT NULL,
                updated  INTEGER NOT NULL
            )",
            [],
        )?;
        Ok(Ledger {
            conn: Mutex::new(conn),
            active: Mutex::new(HashMap::new()),
        })
    }

    // ---- bugs (maintenance) ------------------------------------------------

    /// File a bug reported by an agent. Returns its id.
    pub fn add_bug(&self, reporter: &str, title: &str, detail: &str) -> i64 {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO bugs (reporter, title, detail, status, created, updated) \
             VALUES (?1, ?2, ?3, 'open', ?4, ?4)",
            rusqlite::params![reporter, title, detail, ts],
        );
        conn.last_insert_rowid()
    }

    fn read_bugs(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<Bug> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(params, |r| {
            Ok(Bug {
                id: r.get(0)?,
                reporter: r.get(1)?,
                title: r.get(2)?,
                detail: r.get(3)?,
                status: r.get(4)?,
                created: r.get(5)?,
                updated: r.get(6)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// All bugs, newest first.
    pub fn bugs(&self, limit: i64) -> Vec<Bug> {
        self.read_bugs(
            "SELECT id, reporter, title, detail, status, created, updated FROM bugs \
             ORDER BY updated DESC LIMIT ?1",
            &[&limit],
        )
    }

    /// Bugs still needing work (open or in progress).
    pub fn open_bugs(&self) -> Vec<Bug> {
        self.read_bugs(
            "SELECT id, reporter, title, detail, status, created, updated FROM bugs \
             WHERE status IN ('open','doing') ORDER BY created ASC",
            &[],
        )
    }

    /// Move a bug to a new status.
    pub fn set_bug_status(&self, id: i64, status: &str) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE bugs SET status = ?2, updated = ?3 WHERE id = ?1",
            rusqlite::params![id, status, ts],
        );
    }

    // ---- conversations (saved chats) ---------------------------------------

    /// The conversation the agent is talking in, creating one if none exists.
    fn ensure_active(&self, agent_id: &str) -> i64 {
        if let Some(id) = self.active.lock().unwrap().get(agent_id).copied() {
            return id;
        }
        // Reuse the agent's most recent conversation, else start a fresh one.
        let latest: Option<i64> = {
            let conn = self.conn.lock().unwrap();
            conn.query_row(
                "SELECT id FROM conversations WHERE agent_id = ?1 ORDER BY updated DESC LIMIT 1",
                [agent_id],
                |r| r.get(0),
            )
            .ok()
        };
        let id = latest.unwrap_or_else(|| self.create_conversation(agent_id, "", "New chat"));
        self.active.lock().unwrap().insert(agent_id.to_string(), id);
        id
    }

    fn create_conversation(&self, agent_id: &str, cwd: &str, title: &str) -> i64 {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO conversations (agent_id, title, cwd, created, updated) \
             VALUES (?1, ?2, ?3, ?4, ?4)",
            rusqlite::params![agent_id, title, cwd, ts],
        );
        conn.last_insert_rowid()
    }

    /// Start a fresh conversation for an agent and make it active. Returns its id.
    pub fn new_conversation(&self, agent_id: &str, cwd: &str) -> i64 {
        let id = self.create_conversation(agent_id, cwd, "New chat");
        self.active.lock().unwrap().insert(agent_id.to_string(), id);
        id
    }

    /// Make an existing conversation the active one for its agent.
    pub fn open_conversation(&self, conversation_id: i64) {
        if let Some(c) = self.conversation(conversation_id) {
            self.active.lock().unwrap().insert(c.agent_id, conversation_id);
        }
    }

    /// The agent's active conversation id (creating one if needed).
    pub fn active_conversation(&self, agent_id: &str) -> i64 {
        self.ensure_active(agent_id)
    }

    pub fn conversation(&self, id: i64) -> Option<Conversation> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id, agent_id, title, cwd, created, updated FROM conversations WHERE id = ?1",
            [id],
            |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    agent_id: r.get(1)?,
                    title: r.get(2)?,
                    cwd: r.get(3)?,
                    created: r.get(4)?,
                    updated: r.get(5)?,
                })
            },
        )
        .ok()
    }

    /// All saved chats, most-recently-active first.
    pub fn conversations(&self, limit: i64) -> Vec<Conversation> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, agent_id, title, cwd, created, updated FROM conversations \
             ORDER BY updated DESC LIMIT ?1",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map([limit], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                agent_id: r.get(1)?,
                title: r.get(2)?,
                cwd: r.get(3)?,
                created: r.get(4)?,
                updated: r.get(5)?,
            })
        });
        match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// The session id to resume for a conversation, if any.
    pub fn conversation_session(&self, id: i64) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT session_id FROM conversations WHERE id = ?1",
            [id],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn set_conversation_session(&self, id: i64, session_id: &str, cwd: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE conversations SET session_id = ?2, cwd = ?3 WHERE id = ?1",
            rusqlite::params![id, session_id, cwd],
        );
    }

    /// Forget a conversation's resume pointer (a stale session that won't resume).
    pub fn forget_conversation_session(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE conversations SET session_id = NULL WHERE id = ?1",
            [id],
        );
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

    /// The agent's current conversation without creating one (for reads).
    fn current_conversation(&self, agent_id: &str) -> Option<i64> {
        if let Some(id) = self.active.lock().unwrap().get(agent_id).copied() {
            return Some(id);
        }
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM conversations WHERE agent_id = ?1 ORDER BY updated DESC LIMIT 1",
            [agent_id],
            |r| r.get(0),
        )
        .ok()
    }

    /// Title an untitled conversation from its first user message.
    fn maybe_title(&self, conv: i64, text: &str) {
        let conn = self.conn.lock().unwrap();
        let cur: Option<String> = conn
            .query_row("SELECT title FROM conversations WHERE id = ?1", [conv], |r| r.get(0))
            .ok();
        if matches!(cur.as_deref(), Some("New chat") | Some("Chat")) {
            let t: String = text.trim().lines().next().unwrap_or("").chars().take(48).collect();
            let title = if t.trim().is_empty() { "Chat".to_string() } else { t };
            let _ = conn.execute(
                "UPDATE conversations SET title = ?2 WHERE id = ?1",
                rusqlite::params![conv, title],
            );
        }
    }

    /// Append one chat message to the agent's active conversation.
    pub fn add_message(
        &self,
        agent_id: &str,
        role: &str,
        text: Option<&str>,
        tool: Option<&str>,
        detail: Option<&str>,
    ) {
        let conv = self.ensure_active(agent_id);
        let ts = now_ms();
        {
            let conn = self.conn.lock().unwrap();
            let _ = conn.execute(
                "INSERT INTO messages (ts, agent_id, role, text, tool, detail, conversation_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![ts, agent_id, role, text, tool, detail, conv],
            );
            let _ = conn.execute(
                "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                rusqlite::params![conv, ts],
            );
        }
        if role == "user" {
            if let Some(t) = text {
                self.maybe_title(conv, t);
            }
        }
    }

    /// The last `limit` messages of the agent's current conversation, chronological.
    pub fn messages(&self, agent_id: &str, limit: i64) -> Vec<StoredMessage> {
        match self.current_conversation(agent_id) {
            Some(conv) => self.conversation_messages(conv, limit),
            None => vec![],
        }
    }

    /// The last `limit` messages of a specific conversation, chronological.
    pub fn conversation_messages(&self, conv: i64, limit: i64) -> Vec<StoredMessage> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, ts, role, text, tool, detail FROM messages \
             WHERE conversation_id = ?1 ORDER BY id DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(rusqlite::params![conv, limit], |r| {
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

    /// Reset button: delete the agent's current conversation (messages + row) and
    /// its legacy resume pointers, so the next message starts a genuinely fresh one.
    pub fn clear_agent(&self, agent_id: &str) {
        let conv = self.current_conversation(agent_id);
        self.active.lock().unwrap().remove(agent_id);
        let conn = self.conn.lock().unwrap();
        if let Some(c) = conv {
            let _ = conn.execute("DELETE FROM messages WHERE conversation_id = ?1", [c]);
            let _ = conn.execute("DELETE FROM conversations WHERE id = ?1", [c]);
        }
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
