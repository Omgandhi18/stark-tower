use crate::attachments::Attachment;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// Durable audit trail of everything the tower does. The `load` column is an
/// abstract "reactor draw" figure (Claude Max is flat-rate, so this tracks
/// activity, not dollars).
pub struct Ledger {
    pub(crate) conn: Mutex<Connection>,
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
    /// A teammate's delegation ran here, not a chat the developer had.
    pub delegated: bool,
    pub project_folder: String,
    pub branch: String,
}

/// A conversation's columns (aliased `c`), then whether a delegation ran in it.
const CONVERSATION_COLUMNS: &str = "c.id, c.agent_id, c.title, c.cwd, c.created, c.updated, \
    EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id = c.id AND t.parent_id IS NOT NULL), \
    COALESCE((SELECT project FROM worktrees w WHERE w.path = c.cwd), c.cwd), \
    COALESCE((SELECT branch FROM worktrees w WHERE w.path = c.cwd), '')";

fn conversation_row(r: &rusqlite::Row) -> rusqlite::Result<Conversation> {
    Ok(Conversation {
        id: r.get(0)?,
        agent_id: r.get(1)?,
        title: r.get(2)?,
        cwd: r.get(3)?,
        created: r.get(4)?,
        updated: r.get(5)?,
        delegated: r.get(6)?,
        project_folder: r.get(7)?,
        branch: r.get(8)?,
    })
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
    /// Files with the message: what the developer attached, or what the agent made or shared.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// Attachments as stored in a column: a JSON list, or nothing.
fn attachments_column(attachments: &[Attachment]) -> String {
    if attachments.is_empty() {
        String::new()
    } else {
        serde_json::to_string(attachments).unwrap_or_default()
    }
}

fn attachments_from(column: Option<String>) -> Vec<Attachment> {
    column.filter(|c| !c.is_empty()).and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default()
}

fn stored_message(r: &rusqlite::Row) -> rusqlite::Result<StoredMessage> {
    Ok(StoredMessage {
        id: r.get(0)?,
        ts: r.get(1)?,
        role: r.get(2)?,
        text: r.get(3)?,
        tool: r.get(4)?,
        detail: r.get(5)?,
        attachments: attachments_from(r.get(6)?),
    })
}

/// A unit of work with an accountable owner. The developer starts one from Work;
/// a delegation starts a child of the delegating agent's task. It is durable, so
/// in-flight and finished work survives the app closing.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Task {
    pub id: String,
    pub ts: i64,
    pub updated: i64,
    pub title: String,
    /// The agent accountable for the work.
    pub assignee: String,
    /// todo (queued) | doing | blocked | done (ready for review) | closed
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The folder the task runs in ("" for tasks recorded before this existed).
    pub cwd: String,
    /// The conversation the owner works on this task in.
    pub conversation_id: Option<i64>,
    /// The task this one was delegated from.
    pub parent_id: Option<String>,
    /// Who asked for it: "you" (the developer) or the delegating agent's id.
    pub requested_by: String,
    /// The full request, as asked.
    pub prompt: String,
    /// The git branch checked out when the task started ("" outside a repository).
    pub branch: String,
    pub request_url: Option<String>,
    pub request_host: Option<String>,
    pub request_number: Option<i64>,
    /// When it started running, and when it stopped (finished, blocked or closed).
    pub started: Option<i64>,
    pub finished: Option<i64>,
    /// The owner's own plan, as steps done out of steps total (from its to-do list).
    pub plan_done: Option<i64>,
    pub plan_total: Option<i64>,
    pub workspace_kind: String,
    pub project_folder: String,
}

/// What a new task needs to begin with.
pub struct NewTask<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub assignee: &'a str,
    pub status: &'a str,
    pub cwd: &'a str,
    pub parent_id: Option<&'a str>,
    pub requested_by: &'a str,
    pub prompt: &'a str,
}

/// Something that needed or may interest the developer, kept until they archive it.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Notification {
    pub id: i64,
    pub ts: i64,
    /// approval | question | review | task_ready | task_blocked | check_failed | rule_used
    pub kind: String,
    /// needs_you | update
    pub urgency: String,
    pub agent_id: String,
    pub task_id: Option<String>,
    pub cwd: String,
    pub title: String,
    pub body: String,
    /// The pending review it stands for, while it can still be answered.
    pub review_id: Option<String>,
    pub read: bool,
    /// When it was dealt with, and how ("Allowed once", "Answered", "Closed").
    pub handled: Option<i64>,
    pub outcome: Option<String>,
    /// The automation it's about (a missed or failed run).
    pub automation_id: Option<i64>,
    /// The reminder that went off.
    pub reminder_id: Option<i64>,
}

/// What a new notification says.
#[derive(Default)]
pub struct NewNotification<'a> {
    pub kind: &'a str,
    pub urgency: &'a str,
    pub agent_id: &'a str,
    pub task_id: Option<&'a str>,
    pub cwd: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub review_id: Option<&'a str>,
    pub automation_id: Option<i64>,
    pub reminder_id: Option<i64>,
}

const NOTIFICATION_COLUMNS: &str = "id, ts, kind, urgency, agent_id, task_id, cwd, title, body, review_id, read, handled, outcome, automation_id, reminder_id";

fn notification_from_row(r: &rusqlite::Row) -> rusqlite::Result<Notification> {
    Ok(Notification {
        id: r.get(0)?,
        ts: r.get(1)?,
        kind: r.get(2)?,
        urgency: r.get(3)?,
        agent_id: r.get(4)?,
        task_id: r.get(5)?,
        cwd: r.get(6)?,
        title: r.get(7)?,
        body: r.get(8)?,
        review_id: r.get(9)?,
        read: r.get::<_, i64>(10)? != 0,
        handled: r.get(11)?,
        outcome: r.get(12)?,
        automation_id: r.get(13)?,
        reminder_id: r.get(14)?,
    })
}

const RULE_COLUMNS: &str = "id, created, scope, task_id, project, tool, pattern, display, rule, tier, uses, last_used, revoked";

fn rule_from_row(r: &rusqlite::Row) -> rusqlite::Result<crate::policy::PermissionRule> {
    Ok(crate::policy::PermissionRule {
        id: r.get(0)?,
        created: r.get(1)?,
        scope: r.get(2)?,
        task_id: r.get(3)?,
        project: r.get(4)?,
        tool: r.get(5)?,
        pattern: r.get(6)?,
        display: r.get(7)?,
        rule: r.get(8)?,
        tier: r.get(9)?,
        uses: r.get(10)?,
        last_used: r.get(11)?,
        revoked: r.get(12)?,
    })
}

/// Something the developer wants reminding of, and the agent who reminds them.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Reminder {
    pub id: i64,
    /// What to remember ("Check the deploy").
    pub text: String,
    /// The agent who reminds the developer.
    pub agent_id: String,
    /// The task it's about, if any.
    pub task_id: Option<String>,
    /// When it next goes off.
    pub due: i64,
    /// How it repeats; None goes off once.
    pub repeat: Option<crate::schedule::Schedule>,
    /// waiting (for its time) | due (went off, waiting on the developer) | done
    pub status: String,
    /// When it last went off.
    pub fired: Option<i64>,
    /// Who set it: "you", or the agent the developer asked in chat.
    pub set_by: String,
    pub created: i64,
    pub updated: i64,
}

const REMINDER_COLUMNS: &str = "id, text, agent_id, task_id, due, repeat, status, fired, set_by, created, updated";

fn reminder_from_row(r: &rusqlite::Row) -> rusqlite::Result<Reminder> {
    let repeat: Option<String> = r.get(5)?;
    Ok(Reminder {
        id: r.get(0)?,
        text: r.get(1)?,
        agent_id: r.get(2)?,
        task_id: r.get(3)?,
        due: r.get(4)?,
        repeat: repeat.and_then(|json| serde_json::from_str(&json).ok()),
        status: r.get(6)?,
        fired: r.get(7)?,
        set_by: r.get(8)?,
        created: r.get(9)?,
        updated: r.get(10)?,
    })
}

/// Work that runs on a schedule, owned by one agent in one folder.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct Automation {
    pub id: i64,
    pub name: String,
    pub agent_id: String,
    pub cwd: String,
    /// What the owner is asked to do each run.
    pub instruction: String,
    pub schedule: crate::schedule::Schedule,
    pub enabled: bool,
    /// When a run was missed (the Mac was asleep or Starkline closed): run_once | skip | ask
    pub missed: String,
    /// failure | always | never
    pub notify: String,
    /// A run that takes longer is stopped.
    pub max_minutes: i64,
    /// The developer wants the Mac woken for it (needs the wake helper).
    pub wake: bool,
    pub created: i64,
    pub updated: i64,
    pub next_run: Option<i64>,
    pub last_run: Option<i64>,
    pub last_status: Option<String>,
}

/// One run of an automation.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct AutomationRun {
    pub id: i64,
    pub automation_id: i64,
    pub scheduled_for: i64,
    pub started: Option<i64>,
    pub finished: Option<i64>,
    /// running | succeeded | failed | missed | skipped
    pub status: String,
    pub task_id: Option<String>,
    pub summary: String,
    /// What started it: schedule | late (a missed slot, made up) | you
    pub trigger: String,
}

const AUTOMATION_COLUMNS: &str =
    "id, name, agent_id, cwd, instruction, schedule, enabled, missed, notify, max_minutes, wake, created, updated, next_run, last_run, last_status";

fn automation_from_row(r: &rusqlite::Row) -> rusqlite::Result<Automation> {
    let schedule: String = r.get(5)?;
    Ok(Automation {
        id: r.get(0)?,
        name: r.get(1)?,
        agent_id: r.get(2)?,
        cwd: r.get(3)?,
        instruction: r.get(4)?,
        schedule: serde_json::from_str(&schedule).unwrap_or(crate::schedule::Schedule::Daily { time: "09:00".into() }),
        enabled: r.get::<_, i64>(6)? != 0,
        missed: r.get(7)?,
        notify: r.get(8)?,
        max_minutes: r.get(9)?,
        wake: r.get::<_, i64>(10)? != 0,
        created: r.get(11)?,
        updated: r.get(12)?,
        next_run: r.get(13)?,
        last_run: r.get(14)?,
        last_status: r.get(15)?,
    })
}

fn run_from_row(r: &rusqlite::Row) -> rusqlite::Result<AutomationRun> {
    Ok(AutomationRun {
        id: r.get(0)?,
        automation_id: r.get(1)?,
        scheduled_for: r.get(2)?,
        started: r.get(3)?,
        finished: r.get(4)?,
        status: r.get(5)?,
        task_id: r.get(6)?,
        summary: r.get(7)?,
        trigger: r.get(8)?,
    })
}

/// One thing that happened in a task, in order. Append-only.
#[derive(Debug, Clone, Serialize, specta::Type)]
pub struct TaskEvent {
    pub id: i64,
    pub task_id: String,
    pub ts: i64,
    pub agent_id: String,
    /// created | queued | started | delegated | file | command | verification | plan | helper | approval | status
    pub kind: String,
    /// One readable line.
    pub summary: String,
    /// Kind-specific details as JSON ("" when there are none).
    pub data: String,
}

const TASK_COLUMNS: &str = "id, ts, updated, title, assignee, status, detail, cwd, conversation_id, parent_id, \
    requested_by, prompt, branch, started, finished, plan_done, plan_total, workspace_kind, project_folder, request_url, request_host, request_number";

fn task_from_row(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        ts: r.get(1)?,
        updated: r.get(2)?,
        title: r.get(3)?,
        assignee: r.get(4)?,
        status: r.get(5)?,
        detail: r.get(6)?,
        cwd: r.get(7)?,
        conversation_id: r.get(8)?,
        parent_id: r.get(9)?,
        requested_by: r.get(10)?,
        prompt: r.get(11)?,
        branch: r.get(12)?,
        started: r.get(13)?,
        finished: r.get(14)?,
        plan_done: r.get(15)?,
        plan_total: r.get(16)?,
        workspace_kind: r.get(17)?,
        project_folder: r.get(18)?,
        request_url: r.get(19)?,
        request_host: r.get(20)?,
        request_number: r.get(21)?,
    })
}

/// Add a column to an existing table if it isn't there yet (idempotent migrations).
fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> rusqlite::Result<()> {
    let exists = conn
        .prepare(&format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1"))
        .and_then(|mut s| s.exists([column]))
        .unwrap_or(true);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    }
    Ok(())
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

/// Runs an `UPDATE … RETURNING id` and gives back the ids it changed, so the Mac can take them off too.
pub(crate) fn notification_ids(conn: &rusqlite::Connection, sql: &str, params: impl rusqlite::Params) -> Vec<i64> {
    let Ok(mut stmt) = conn.prepare(sql) else { return vec![] };
    let Ok(rows) = stmt.query_map(params, |r| r.get(0)) else { return vec![] };
    rows.filter_map(Result::ok).collect()
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Ledger {
    /// The database answers a trivial query.
    pub fn healthy(&self) -> bool {
        self.conn
            .lock()
            .unwrap()
            .query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
            .is_ok()
    }

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
        // Migrate: tasks remember their folder, conversation, origin, branch,
        // timing and plan progress (older databases gain them empty).
        ensure_column(&conn, "tasks", "cwd", "TEXT NOT NULL DEFAULT ''")?;
        // Files attached to the request a task started from (JSON).
        ensure_column(&conn, "tasks", "attachments", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "tasks", "conversation_id", "INTEGER")?;
        ensure_column(&conn, "tasks", "parent_id", "TEXT")?;
        ensure_column(&conn, "tasks", "requested_by", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "tasks", "prompt", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "tasks", "branch", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "tasks", "started", "INTEGER")?;
        ensure_column(&conn, "tasks", "finished", "INTEGER")?;
        ensure_column(&conn, "tasks", "plan_done", "INTEGER")?;
        ensure_column(&conn, "tasks", "plan_total", "INTEGER")?;
        ensure_column(&conn, "tasks", "workspace_kind", "TEXT NOT NULL DEFAULT ''")?;
        ensure_column(&conn, "tasks", "project_folder", "TEXT NOT NULL DEFAULT ''")?;
        conn.execute("CREATE TABLE IF NOT EXISTS worktrees (path TEXT PRIMARY KEY, project TEXT NOT NULL, branch TEXT NOT NULL, base TEXT NOT NULL, base_commit TEXT NOT NULL, task_id TEXT NOT NULL, created INTEGER NOT NULL, removed INTEGER)", [])?;
        ensure_column(&conn, "tasks", "request_url", "TEXT")?;
        ensure_column(&conn, "tasks", "request_host", "TEXT")?;
        ensure_column(&conn, "tasks", "request_number", "INTEGER")?;
        conn.execute("CREATE TABLE IF NOT EXISTS code_review_seen (id TEXT PRIMARY KEY, seen TEXT NOT NULL DEFAULT '', failed_head TEXT NOT NULL DEFAULT '')", [])?;
        // Everything that happens in a task, append-only.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS task_events (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id  TEXT    NOT NULL,
                ts       INTEGER NOT NULL,
                agent_id TEXT    NOT NULL,
                kind     TEXT    NOT NULL,
                summary  TEXT    NOT NULL,
                data     TEXT    NOT NULL DEFAULT ''
            )",
            [],
        )?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id)", [])?;
        // Permission rules the developer granted (never deleted; revoking stamps them).
        conn.execute(
            "CREATE TABLE IF NOT EXISTS permission_rules (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                created   INTEGER NOT NULL,
                scope     TEXT    NOT NULL,
                task_id   TEXT,
                project   TEXT,
                tool      TEXT    NOT NULL,
                pattern   TEXT    NOT NULL,
                display   TEXT    NOT NULL,
                rule      TEXT    NOT NULL,
                tier      TEXT    NOT NULL,
                uses      INTEGER NOT NULL DEFAULT 0,
                last_used INTEGER,
                revoked   INTEGER
            )",
            [],
        )?;
        // The Notification Centre: everything that needed or may interest the developer.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS notifications (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ts        INTEGER NOT NULL,
                kind      TEXT    NOT NULL,
                urgency   TEXT    NOT NULL,
                agent_id  TEXT    NOT NULL,
                task_id   TEXT,
                cwd       TEXT    NOT NULL DEFAULT '',
                title     TEXT    NOT NULL,
                body      TEXT    NOT NULL DEFAULT '',
                review_id TEXT,
                read      INTEGER NOT NULL DEFAULT 0,
                handled   INTEGER,
                outcome   TEXT
            )",
            [],
        )?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_notifications_ts ON notifications(ts)", [])?;
        ensure_column(&conn, "notifications", "automation_id", "INTEGER")?;
        ensure_column(&conn, "notifications", "reminder_id", "INTEGER")?;
        // Reminders the developer set, each with the agent who reminds them.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS reminders (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                text     TEXT    NOT NULL,
                agent_id TEXT    NOT NULL,
                task_id  TEXT,
                due      INTEGER NOT NULL,
                repeat   TEXT,
                status   TEXT    NOT NULL DEFAULT 'waiting',
                fired    INTEGER,
                set_by   TEXT    NOT NULL DEFAULT 'you',
                created  INTEGER NOT NULL,
                updated  INTEGER NOT NULL
            )",
            [],
        )?;
        // Work that runs on a schedule, and every run it made.
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automations (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT    NOT NULL,
                agent_id    TEXT    NOT NULL,
                cwd         TEXT    NOT NULL,
                instruction TEXT    NOT NULL,
                schedule    TEXT    NOT NULL,
                enabled     INTEGER NOT NULL DEFAULT 1,
                missed      TEXT    NOT NULL DEFAULT 'run_once',
                notify      TEXT    NOT NULL DEFAULT 'failure',
                max_minutes INTEGER NOT NULL DEFAULT 60,
                wake        INTEGER NOT NULL DEFAULT 0,
                created     INTEGER NOT NULL,
                updated     INTEGER NOT NULL,
                next_run    INTEGER,
                last_run    INTEGER,
                last_status TEXT
            )",
            [],
        )?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS automation_runs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                automation_id INTEGER NOT NULL,
                scheduled_for INTEGER NOT NULL,
                started       INTEGER,
                finished      INTEGER,
                status        TEXT    NOT NULL,
                task_id       TEXT,
                summary       TEXT    NOT NULL DEFAULT '',
                trigger       TEXT    NOT NULL DEFAULT 'schedule'
            )",
            [],
        )?;
        ensure_column(&conn, "automation_runs", "trigger", "TEXT NOT NULL DEFAULT 'schedule'")?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_automation_runs ON automation_runs(automation_id, id)", [])?;
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
        // Files with a message (JSON): attached by the developer, or made or shared by the agent.
        ensure_column(&conn, "messages", "attachments", "TEXT NOT NULL DEFAULT ''")?;
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
        conn.execute_batch(crate::spend::SCHEMA)?;
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

    /// A new conversation that doesn't become the agent's active one (a delegated
    /// task's own thread). Returns its id.
    pub fn create_conversation(&self, agent_id: &str, cwd: &str, title: &str) -> i64 {
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
        self.new_titled_conversation(agent_id, cwd, "New chat")
    }

    /// Start a fresh, titled conversation for an agent and make it active.
    pub fn new_titled_conversation(&self, agent_id: &str, cwd: &str, title: &str) -> i64 {
        let id = self.create_conversation(agent_id, cwd, title);
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
        conn.query_row(&format!("SELECT {CONVERSATION_COLUMNS} FROM conversations c WHERE c.id = ?1"), [id], conversation_row)
            .ok()
    }

    /// All saved chats, most-recently-active first.
    pub fn conversations(&self, limit: i64) -> Vec<Conversation> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!("SELECT {CONVERSATION_COLUMNS} FROM conversations c ORDER BY c.updated DESC LIMIT ?1")) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map([limit], conversation_row);
        match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        }
    }

    /// Remember the files a task's request came with, for when it starts.
    pub fn set_task_attachments(&self, id: &str, attachments: &[Attachment]) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE tasks SET attachments = ?2 WHERE id = ?1", rusqlite::params![id, attachments_column(attachments)]);
    }

    /// The files a task's request came with.
    pub fn task_attachments(&self, id: &str) -> Vec<Attachment> {
        let conn = self.conn.lock().unwrap();
        attachments_from(conn.query_row("SELECT attachments FROM tasks WHERE id = ?1", [id], |r| r.get(0)).ok())
    }

    /// Whether any message or task still refers to a kept file.
    pub fn attachment_in_use(&self, path: &str) -> bool {
        // Paths are stored inside JSON, so look for the path as JSON writes it.
        let needle = format!("\"path\":{}", serde_json::to_string(path).unwrap_or_default());
        let conn = self.conn.lock().unwrap();
        let found = |table: &str| {
            conn.query_row(&format!("SELECT 1 FROM {table} WHERE instr(attachments, ?1) > 0 LIMIT 1"), [&needle], |_| Ok(()))
                .is_ok()
        };
        found("messages") || found("tasks")
    }

    /// Every file in a conversation's messages.
    pub fn conversation_attachments(&self, conv: i64) -> Vec<Attachment> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT attachments FROM messages WHERE conversation_id = ?1 AND attachments != ''") else { return vec![] };
        let Ok(rows) = stmt.query_map([conv], |r| r.get::<_, Option<String>>(0)) else { return vec![] };
        rows.filter_map(|r| r.ok()).flat_map(attachments_from).collect()
    }

    /// Delete a conversation for good: its messages go, and tasks that ran in it keep their
    /// history without a transcript. False when there was nothing to delete or it failed.
    pub fn delete_conversation(&self, id: i64) -> bool {
        let deleted = {
            let mut conn = self.conn.lock().unwrap();
            let Ok(tx) = conn.transaction() else { return false };
            let done = tx.execute("DELETE FROM messages WHERE conversation_id = ?1", [id]).is_ok()
                && tx.execute("UPDATE tasks SET conversation_id = NULL WHERE conversation_id = ?1", [id]).is_ok()
                && tx.execute("DELETE FROM conversations WHERE id = ?1", [id]).is_ok_and(|n| n > 0);
            // Anything short of all three rolls back when `tx` drops.
            done && tx.commit().is_ok()
        };
        if deleted {
            self.active.lock().unwrap().retain(|_, open| *open != id);
        }
        deleted
    }

    /// The developer's chat with an agent in a project folder: the open one if it's in
    /// that folder, else the latest there. Chats a delegation ran in never count.
    pub fn chat_in(&self, agent_id: &str, cwd: &str) -> Option<i64> {
        let folder = cwd.trim_end_matches('/');
        let open = self.current_conversation(agent_id).and_then(|id| self.conversation(id));
        if let Some(open) = open.filter(|c| c.cwd.trim_end_matches('/') == folder && !c.delegated) {
            return Some(open.id);
        }
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT c.id FROM conversations c WHERE c.agent_id = ?1 AND rtrim(c.cwd, '/') = ?2 \
             AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.conversation_id = c.id AND t.parent_id IS NOT NULL) \
             ORDER BY c.updated DESC, c.id DESC LIMIT 1",
            rusqlite::params![agent_id, folder],
            |r| r.get(0),
        )
        .ok()
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

    /// Record a new task. Returns it as stored.
    pub fn create_task(&self, t: &NewTask) -> Option<Task> {
        let ts = now_ms();
        {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO tasks (id, ts, updated, title, assignee, status, cwd, parent_id, requested_by, prompt) \
                 VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![t.id, ts, t.title, t.assignee, t.status, t.cwd, t.parent_id, t.requested_by, t.prompt],
            )
            .ok()?;
        }
        self.task(t.id)
    }

    pub fn save_worktree(&self, w: &crate::workspaces::Worktree) -> Result<(), String> {
        self.conn.lock().unwrap().execute("INSERT INTO worktrees (path, project, branch, base, base_commit, task_id, created, removed) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)", rusqlite::params![w.path, w.project, w.branch, w.base, w.base_commit, w.task_id, w.created, w.removed]).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn worktrees(&self) -> Vec<crate::workspaces::Worktree> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare("SELECT path, project, branch, base, base_commit, task_id, created, removed FROM worktrees ORDER BY created") else { return vec![] };
        let Ok(rows) = stmt.query_map([], |r| Ok(crate::workspaces::Worktree { path: r.get(0)?, project: r.get(1)?, branch: r.get(2)?, base: r.get(3)?, base_commit: r.get(4)?, task_id: r.get(5)?, created: r.get(6)?, removed: r.get(7)? })) else { return vec![] };
        rows.filter_map(Result::ok).collect()
    }

    pub fn mark_worktree_removed(&self, path: &str) {
        let _ = self.conn.lock().unwrap().execute("UPDATE worktrees SET removed = ?2 WHERE path = ?1 AND removed IS NULL", rusqlite::params![path, now_ms()]);
    }

    pub fn set_task_workspace(&self, id: &str, cwd: &str, kind: &str, project: &str) -> Result<(), String> {
        self.conn.lock().unwrap().execute("UPDATE tasks SET cwd = ?2, workspace_kind = ?3, project_folder = ?4 WHERE id = ?1", rusqlite::params![id, cwd, kind, project]).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn save_request(&self, id: &str, url: &str, host: &str, number: i64) -> Result<(), String> {
        self.conn.lock().unwrap().execute("UPDATE tasks SET request_url=?2, request_host=?3, request_number=?4 WHERE id=?1", rusqlite::params![id, url, host, number]).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn review_seen(&self, id: &str) -> String {
        self.conn.lock().unwrap().query_row("SELECT seen FROM code_review_seen WHERE id=?1", [id], |r| r.get(0)).unwrap_or_default()
    }

    pub fn mark_review_seen(&self, id: &str, time: &str) {
        let _ = self.conn.lock().unwrap().execute("INSERT INTO code_review_seen(id,seen) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET seen=excluded.seen", rusqlite::params![id, time]);
    }

    /// Atomically remember the head before notifying, including across restarts.
    pub fn review_failure(&self, id: &str, head: &str) -> bool {
        self.conn.lock().unwrap().execute("INSERT INTO code_review_seen(id,failed_head) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET failed_head=excluded.failed_head WHERE failed_head != excluded.failed_head", rusqlite::params![id, head]).unwrap_or(0) > 0
    }

    pub fn task(&self, id: &str) -> Option<Task> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE id = ?1"), [id], task_from_row)
            .ok()
    }

    fn query_tasks(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<Task> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let found: Vec<Task> = match stmt.query_map(params, task_from_row) {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        found
    }

    /// The most recently updated `limit` tasks, newest first.
    pub fn tasks(&self, limit: i64) -> Vec<Task> {
        self.query_tasks(&format!("SELECT {TASK_COLUMNS} FROM tasks ORDER BY updated DESC LIMIT ?1"), &[&limit])
    }

    /// Who has a task running in exactly this folder right now.
    pub fn running_in(&self, cwd: &str) -> Vec<String> {
        self.query_tasks(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE status = 'doing' AND cwd = ?1"), &[&cwd]).into_iter().map(|t| t.assignee).collect()
    }

    /// Tasks delegated from `parent`, oldest first.
    pub fn child_tasks(&self, parent: &str) -> Vec<Task> {
        self.query_tasks(&format!("SELECT {TASK_COLUMNS} FROM tasks WHERE parent_id = ?1 ORDER BY ts ASC"), &[&parent])
    }

    /// The open task a conversation belongs to, if any.
    pub fn task_for_conversation(&self, conv: i64) -> Option<Task> {
        self.query_tasks(
            &format!("SELECT {TASK_COLUMNS} FROM tasks WHERE conversation_id = ?1 AND status NOT IN ('closed', 'reviewed') ORDER BY updated DESC LIMIT 1"),
            &[&conv],
        )
        .into_iter()
        .next()
    }

    /// A task starts running in `conversation`, on `branch`.
    pub fn begin_task(&self, id: &str, conversation: Option<i64>, branch: &str) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET status = 'doing', updated = ?2, started = COALESCE(started, ?2), finished = NULL, \
             conversation_id = COALESCE(?3, conversation_id), branch = ?4 WHERE id = ?1",
            rusqlite::params![id, ts, conversation, branch],
        );
    }

    /// Move a task to a new status (no-op if the id is unknown). Stopping states
    /// (done, blocked, closed, reviewed) stamp when it stopped; doing clears that again.
    pub fn set_task_status(&self, id: &str, status: &str, detail: Option<&str>) {
        let ts = now_ms();
        let stopped = matches!(status, "done" | "blocked" | "closed" | "reviewed");
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET status = ?2, updated = ?3, detail = COALESCE(?4, detail), \
             finished = CASE WHEN ?5 THEN COALESCE(finished, ?3) ELSE NULL END, \
             started = CASE WHEN ?2 = 'doing' THEN COALESCE(started, ?3) ELSE started END \
             WHERE id = ?1",
            rusqlite::params![id, status, ts, detail, stopped],
        );
    }

    /// The owner's latest plan progress.
    pub fn set_task_plan(&self, id: &str, done: i64, total: i64) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE tasks SET plan_done = ?2, plan_total = ?3, updated = ?4 WHERE id = ?1",
            rusqlite::params![id, done, total, ts],
        );
    }

    /// Append to a task's history. Returns the stored event.
    pub fn add_task_event(&self, task_id: &str, agent_id: &str, kind: &str, summary: &str, data: &str) -> TaskEvent {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT INTO task_events (task_id, ts, agent_id, kind, summary, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![task_id, ts, agent_id, kind, summary, data],
        );
        TaskEvent {
            id: conn.last_insert_rowid(),
            task_id: task_id.into(),
            ts,
            agent_id: agent_id.into(),
            kind: kind.into(),
            summary: summary.into(),
            data: data.into(),
        }
    }

    // ---- Notifications ---------------------------------------------------------

    pub fn add_notification(&self, n: &NewNotification) -> Option<Notification> {
        let ts = now_ms();
        let id = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO notifications (ts, kind, urgency, agent_id, task_id, cwd, title, body, review_id, automation_id, reminder_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                rusqlite::params![ts, n.kind, n.urgency, n.agent_id, n.task_id, n.cwd, n.title, n.body, n.review_id, n.automation_id, n.reminder_id],
            )
            .ok()?;
            conn.last_insert_rowid()
        };
        self.notification(id)
    }

    pub fn notification(&self, id: i64) -> Option<Notification> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {NOTIFICATION_COLUMNS} FROM notifications WHERE id = ?1"), [id], notification_from_row)
            .ok()
    }

    /// The newest `limit` notifications, newest first.
    pub fn notifications(&self, limit: i64) -> Vec<Notification> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!("SELECT {NOTIFICATION_COLUMNS} FROM notifications ORDER BY ts DESC, id DESC LIMIT ?1")) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let found: Vec<Notification> = match stmt.query_map([limit], notification_from_row) {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        found
    }

    pub fn mark_notifications_read(&self, ids: &[i64]) -> Vec<i64> {
        let conn = self.conn.lock().unwrap();
        ids.iter()
            .flat_map(|id| notification_ids(&conn, "UPDATE notifications SET read = 1 WHERE id = ?1 AND read = 0 RETURNING id", [id]))
            .collect()
    }

    pub fn mark_all_notifications_read(&self) -> Vec<i64> {
        let conn = self.conn.lock().unwrap();
        notification_ids(&conn, "UPDATE notifications SET read = 1 WHERE read = 0 RETURNING id", [])
    }

    /// Settle the open notifications for a review or a task, saying how.
    pub fn handle_notifications(&self, review_id: Option<&str>, task_id: Option<&str>, kinds: &[&str], outcome: &str) -> Vec<i64> {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let mut changed = Vec::new();
        if let Some(review) = review_id {
            changed.extend(notification_ids(
                &conn,
                "UPDATE notifications SET handled = ?2, outcome = ?3, read = 1 WHERE review_id = ?1 AND handled IS NULL RETURNING id",
                rusqlite::params![review, ts, outcome],
            ));
        }
        if let Some(task) = task_id {
            for kind in kinds {
                changed.extend(notification_ids(
                    &conn,
                    "UPDATE notifications SET handled = ?2, outcome = ?3, read = 1 \
                     WHERE task_id = ?1 AND kind = ?4 AND handled IS NULL RETURNING id",
                    rusqlite::params![task, ts, outcome, kind],
                ));
            }
        }
        changed
    }

    /// Settle an automation's open notifications (a missed run that asked what to do).
    pub fn handle_automation_notifications(&self, automation_id: i64, outcome: &str) -> Vec<i64> {
        let conn = self.conn.lock().unwrap();
        notification_ids(
            &conn,
            "UPDATE notifications SET handled = ?2, outcome = ?3, read = 1 WHERE automation_id = ?1 AND handled IS NULL RETURNING id",
            rusqlite::params![automation_id, now_ms(), outcome],
        )
    }

    /// Settle a reminder's open notification (done, snoozed, deleted).
    pub fn handle_reminder_notifications(&self, reminder_id: i64, outcome: &str) -> Vec<i64> {
        let conn = self.conn.lock().unwrap();
        notification_ids(
            &conn,
            "UPDATE notifications SET handled = ?2, outcome = ?3, read = 1 WHERE reminder_id = ?1 AND handled IS NULL RETURNING id",
            rusqlite::params![reminder_id, now_ms(), outcome],
        )
    }

    // ---- Reminders -------------------------------------------------------------

    /// Create (id 0) or update a reminder; returns it as stored.
    pub fn save_reminder(&self, r: &Reminder) -> Option<Reminder> {
        let ts = now_ms();
        let repeat = match &r.repeat {
            Some(schedule) => Some(serde_json::to_string(schedule).ok()?),
            None => None,
        };
        let id = {
            let conn = self.conn.lock().unwrap();
            if r.id > 0 {
                conn.execute(
                    "UPDATE reminders SET text = ?2, agent_id = ?3, task_id = ?4, due = ?5, repeat = ?6, status = ?7, fired = ?8, updated = ?9 WHERE id = ?1",
                    rusqlite::params![r.id, r.text, r.agent_id, r.task_id, r.due, repeat, r.status, r.fired, ts],
                )
                .ok()?;
                r.id
            } else {
                conn.execute(
                    "INSERT INTO reminders (text, agent_id, task_id, due, repeat, status, fired, set_by, created, updated) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                    rusqlite::params![r.text, r.agent_id, r.task_id, r.due, repeat, r.status, r.fired, r.set_by, ts],
                )
                .ok()?;
                conn.last_insert_rowid()
            }
        };
        self.reminder(id)
    }

    pub fn reminder(&self, id: i64) -> Option<Reminder> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {REMINDER_COLUMNS} FROM reminders WHERE id = ?1"), [id], reminder_from_row).ok()
    }

    /// Every reminder, soonest first.
    pub fn reminders(&self) -> Vec<Reminder> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!("SELECT {REMINDER_COLUMNS} FROM reminders ORDER BY due, id")) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let found: Vec<Reminder> = match stmt.query_map([], reminder_from_row) {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        found
    }

    pub fn delete_reminder(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM reminders WHERE id = ?1", [id]);
    }

    // ---- Permission rules ------------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn add_rule(
        &self,
        scope: &str,
        task_id: Option<&str>,
        project: Option<&str>,
        key: &crate::policy::RuleKey,
        rule: &str,
        tier: &str,
    ) -> Option<crate::policy::PermissionRule> {
        let ts = now_ms();
        let id = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO permission_rules (created, scope, task_id, project, tool, pattern, display, rule, tier) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![ts, scope, task_id, project, key.tool, key.pattern, key.display, rule, tier],
            )
            .ok()?;
            conn.last_insert_rowid()
        };
        self.rules(false).into_iter().find(|r| r.id == id)
    }

    /// Every rule, newest first; revoked ones only when asked.
    pub fn rules(&self, include_revoked: bool) -> Vec<crate::policy::PermissionRule> {
        let conn = self.conn.lock().unwrap();
        let sql = if include_revoked {
            format!("SELECT {RULE_COLUMNS} FROM permission_rules ORDER BY created DESC")
        } else {
            format!("SELECT {RULE_COLUMNS} FROM permission_rules WHERE revoked IS NULL ORDER BY created DESC")
        };
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let found: Vec<crate::policy::PermissionRule> = match stmt.query_map([], rule_from_row) {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        found
    }

    pub fn record_rule_use(&self, id: i64) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE permission_rules SET uses = uses + 1, last_used = ?2 WHERE id = ?1", rusqlite::params![id, ts]);
    }

    pub fn revoke_rule(&self, id: i64) -> bool {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        conn.execute("UPDATE permission_rules SET revoked = ?2 WHERE id = ?1 AND revoked IS NULL", rusqlite::params![id, ts])
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    // ---- Automations -----------------------------------------------------------

    /// Create (id None) or update an automation; returns it as stored.
    pub fn save_automation(&self, a: &Automation) -> Option<Automation> {
        let ts = now_ms();
        let schedule = serde_json::to_string(&a.schedule).ok()?;
        let id = {
            let conn = self.conn.lock().unwrap();
            if a.id > 0 {
                conn.execute(
                    "UPDATE automations SET name = ?2, agent_id = ?3, cwd = ?4, instruction = ?5, schedule = ?6, enabled = ?7, \
                     missed = ?8, notify = ?9, max_minutes = ?10, wake = ?11, updated = ?12, next_run = ?13 WHERE id = ?1",
                    rusqlite::params![a.id, a.name, a.agent_id, a.cwd, a.instruction, schedule, a.enabled, a.missed, a.notify, a.max_minutes, a.wake, ts, a.next_run],
                )
                .ok()?;
                a.id
            } else {
                conn.execute(
                    "INSERT INTO automations (name, agent_id, cwd, instruction, schedule, enabled, missed, notify, max_minutes, wake, created, updated, next_run) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12)",
                    rusqlite::params![a.name, a.agent_id, a.cwd, a.instruction, schedule, a.enabled, a.missed, a.notify, a.max_minutes, a.wake, ts, a.next_run],
                )
                .ok()?;
                conn.last_insert_rowid()
            }
        };
        self.automation(id)
    }

    pub fn automation(&self, id: i64) -> Option<Automation> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {AUTOMATION_COLUMNS} FROM automations WHERE id = ?1"), [id], automation_from_row)
            .ok()
    }

    pub fn automations(&self) -> Vec<Automation> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(&format!("SELECT {AUTOMATION_COLUMNS} FROM automations ORDER BY name COLLATE NOCASE")) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let found: Vec<Automation> = match stmt.query_map([], automation_from_row) {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        found
    }

    /// Remove an automation and its run history (the tasks it started stay).
    pub fn delete_automation(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM automation_runs WHERE automation_id = ?1", [id]);
        let _ = conn.execute("DELETE FROM automations WHERE id = ?1", [id]);
    }

    /// Record when an automation next runs (and, after a run, how the last one went).
    pub fn set_automation_schedule_state(&self, id: i64, next_run: Option<i64>, last_run: Option<i64>, last_status: Option<&str>) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE automations SET next_run = ?2, last_run = COALESCE(?3, last_run), last_status = COALESCE(?4, last_status) WHERE id = ?1",
            rusqlite::params![id, next_run, last_run, last_status],
        );
    }

    pub fn set_automation_status(&self, id: i64, last_status: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("UPDATE automations SET last_status = ?2 WHERE id = ?1", rusqlite::params![id, last_status]);
    }

    pub fn add_automation_run(&self, automation_id: i64, scheduled_for: i64, trigger: &str, status: &str, task_id: Option<&str>, summary: &str) -> Option<AutomationRun> {
        let ts = now_ms();
        // A run that never started (missed, skipped) has no start; only a running one is unfinished.
        let started = if matches!(status, "missed" | "skipped") { None } else { Some(ts) };
        let finished = if status == "running" { None } else { Some(ts) };
        let id = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO automation_runs (automation_id, scheduled_for, started, finished, status, task_id, summary, trigger) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![automation_id, scheduled_for, started, finished, status, task_id, summary, trigger],
            )
            .ok()?;
            conn.last_insert_rowid()
        };
        self.automation_runs_where("id = ?1", &[&id], 1).into_iter().next()
    }

    fn automation_runs_where(&self, condition: &str, params: &[&dyn rusqlite::ToSql], limit: i64) -> Vec<AutomationRun> {
        let conn = self.conn.lock().unwrap();
        let sql = format!(
            "SELECT id, automation_id, scheduled_for, started, finished, status, task_id, summary, trigger FROM automation_runs \
             WHERE {condition} ORDER BY id DESC LIMIT {limit}"
        );
        let mut stmt = match conn.prepare(&sql) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let found: Vec<AutomationRun> = match stmt.query_map(params, run_from_row) {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        found
    }

    /// An automation's runs, newest first.
    pub fn automation_runs(&self, automation_id: i64, limit: i64) -> Vec<AutomationRun> {
        self.automation_runs_where("automation_id = ?1", &[&automation_id], limit)
    }

    /// The run a task belongs to, if an automation started it.
    pub fn run_for_task(&self, task_id: &str) -> Option<AutomationRun> {
        self.automation_runs_where("task_id = ?1", &[&task_id], 1).into_iter().next()
    }

    /// Runs whose task hasn't finished.
    pub fn unfinished_runs(&self) -> Vec<AutomationRun> {
        self.automation_runs_where("finished IS NULL", &[], i64::from(u16::MAX))
    }

    pub fn finish_run(&self, id: i64, status: &str, summary: &str) {
        let ts = now_ms();
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "UPDATE automation_runs SET status = ?2, summary = ?3, finished = ?4, started = COALESCE(started, ?4) WHERE id = ?1",
            rusqlite::params![id, status, summary, ts],
        );
    }

    /// A task's history, oldest first (the newest `limit` events).
    pub fn task_events(&self, task_id: &str, limit: i64) -> Vec<TaskEvent> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = match conn.prepare(
            "SELECT id, task_id, ts, agent_id, kind, summary, data FROM task_events \
             WHERE task_id = ?1 ORDER BY id DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(rusqlite::params![task_id, limit], |r| {
            Ok(TaskEvent {
                id: r.get(0)?,
                task_id: r.get(1)?,
                ts: r.get(2)?,
                agent_id: r.get(3)?,
                kind: r.get(4)?,
                summary: r.get(5)?,
                data: r.get(6)?,
            })
        });
        let mut events: Vec<TaskEvent> = match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        events.reverse();
        events
    }

    /// The agent's current conversation without creating one (for reads).
    pub fn current_conversation(&self, agent_id: &str) -> Option<i64> {
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

    /// Append one chat message to the agent's active conversation. Returns the
    /// stored message's id, which live events carry so the UI can merge them
    /// with a transcript it loaded at the same moment.
    pub fn add_message(
        &self,
        agent_id: &str,
        role: &str,
        text: Option<&str>,
        tool: Option<&str>,
        detail: Option<&str>,
    ) -> Option<i64> {
        let conv = self.ensure_active(agent_id);
        self.add_message_to(conv, agent_id, role, text, tool, detail)
    }

    /// Append one chat message to a specific conversation (a delegated task's own
    /// thread). Returns the stored message's id.
    pub fn add_message_to(
        &self,
        conv: i64,
        agent_id: &str,
        role: &str,
        text: Option<&str>,
        tool: Option<&str>,
        detail: Option<&str>,
    ) -> Option<i64> {
        self.add_message_with(conv, agent_id, role, text, tool, detail, &[])
    }

    /// Append a chat message with files to a conversation. Returns the stored message's id.
    #[allow(clippy::too_many_arguments)]
    pub fn add_message_with(
        &self,
        conv: i64,
        agent_id: &str,
        role: &str,
        text: Option<&str>,
        tool: Option<&str>,
        detail: Option<&str>,
        attachments: &[Attachment],
    ) -> Option<i64> {
        let ts = now_ms();
        let files = attachments_column(attachments);
        let id = {
            let conn = self.conn.lock().unwrap();
            let inserted = conn
                .execute(
                    "INSERT INTO messages (ts, agent_id, role, text, tool, detail, conversation_id, attachments) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    rusqlite::params![ts, agent_id, role, text, tool, detail, conv, files],
                )
                .ok()
                .map(|_| conn.last_insert_rowid());
            let _ = conn.execute(
                "UPDATE conversations SET updated = ?2 WHERE id = ?1",
                rusqlite::params![conv, ts],
            );
            inserted
        };
        if role == "user" {
            if let Some(t) = text {
                self.maybe_title(conv, t);
            }
        }
        id
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
            "SELECT id, ts, role, text, tool, detail, attachments FROM messages \
             WHERE conversation_id = ?1 ORDER BY id DESC LIMIT ?2",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(rusqlite::params![conv, limit], stored_message);
        let mut v: Vec<StoredMessage> = match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        v.reverse(); // DESC query → back to chronological
        v
    }

    /// A task's part of its chat: from when it started until the next task in that chat
    /// started (a chat keeps its session across requests, so it can hold several tasks).
    pub fn task_messages(&self, task: &Task, limit: i64) -> Vec<StoredMessage> {
        let Some(conv) = task.conversation_id else { return vec![] };
        let from = task.started.unwrap_or(task.ts);
        let conn = self.conn.lock().unwrap();
        let until: Option<i64> = conn
            .query_row(
                "SELECT MIN(started) FROM tasks WHERE conversation_id = ?1 AND started > ?2 AND id != ?3",
                rusqlite::params![conv, from, task.id],
                |r| r.get(0),
            )
            .ok()
            .flatten();
        let mut stmt = match conn.prepare(
            "SELECT id, ts, role, text, tool, detail, attachments FROM messages \
             WHERE conversation_id = ?1 AND ts >= ?2 AND (?3 IS NULL OR ts < ?3) ORDER BY id DESC LIMIT ?4",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let rows = stmt.query_map(rusqlite::params![conv, from, until, limit], stored_message);
        let mut v: Vec<StoredMessage> = match rows {
            Ok(it) => it.filter_map(|x| x.ok()).collect(),
            Err(_) => vec![],
        };
        v.reverse();
        v
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
    fn request_and_review_memory_survive_reopening() {
        let (ledger, path) = temp_db();
        ledger.create_task(&NewTask { id:"hosting", title:"Fix", assignee:"friday", status:"done", cwd:"/w", parent_id:None, requested_by:"you", prompt:"Fix" }).unwrap();
        ledger.save_request("hosting", "https://gitlab.com/g/r/-/merge_requests/45", "gitlab", 45).unwrap();
        ledger.mark_review_seen("request", "2026-10-06T10:00:00Z");
        assert!(ledger.review_failure("request", "sha1"));
        assert!(!ledger.review_failure("request", "sha1"));
        drop(ledger);
        let ledger = Ledger::open(&path).unwrap();
        let task = ledger.task("hosting").unwrap();
        assert_eq!(task.request_number, Some(45)); assert_eq!(task.request_host.as_deref(), Some("gitlab")); assert!(task.request_url.unwrap().ends_with("/45"));
        assert_eq!(ledger.review_seen("request"), "2026-10-06T10:00:00Z");
        assert!(!ledger.review_failure("request", "sha1")); assert!(ledger.review_failure("request", "sha2"));
        drop(ledger); let _ = std::fs::remove_file(path);
    }

    #[test]
    fn messages_roundtrip_in_chronological_order() {
        let (l, p) = temp_db();
        let first = l.add_message("a", "user", Some("hi"), None, None);
        let second = l.add_message("a", "agent", Some("yo"), None, None);
        assert!(first.is_some() && second > first, "stored ids increase");
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
    fn tasks_from_before_cwd_migrate_with_an_empty_folder() {
        let p = std::env::temp_dir().join(format!("stark-ledger-old-{}.db", std::process::id()));
        {
            let conn = Connection::open(&p).unwrap();
            conn.execute(
                "CREATE TABLE tasks (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, updated INTEGER NOT NULL, \
                 title TEXT NOT NULL, assignee TEXT NOT NULL, status TEXT NOT NULL, detail TEXT)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO tasks VALUES ('old', 1, 1, 'Earlier task', 'friday', 'done', NULL)",
                [],
            )
            .unwrap();
        }
        let l = Ledger::open(&p).expect("old database opens and migrates");
        let ts = l.tasks(10);
        assert_eq!(ts.len(), 1);
        assert_eq!(ts[0].cwd, "");
        drop(l);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn task_lifecycle_from_queued_to_review() {
        let (l, p) = temp_db();
        let created = l
            .create_task(&NewTask {
                id: "t1",
                title: "Review ats",
                assignee: "edith",
                status: "todo",
                cwd: "/work/ats",
                parent_id: None,
                requested_by: "you",
                prompt: "Review the ATS integration",
            })
            .expect("stored");
        assert_eq!((created.status.as_str(), created.started), ("todo", None));
        let conv = l.create_conversation("edith", "/work/ats", "Review ats");
        l.begin_task("t1", Some(conv), "main");
        let running = l.task("t1").unwrap();
        assert_eq!((running.status.as_str(), running.conversation_id, running.branch.as_str()), ("doing", Some(conv), "main"));
        assert!(running.started.is_some() && running.finished.is_none());
        assert_eq!(l.task_for_conversation(conv).map(|t| t.id), Some("t1".into()));
        l.set_task_plan("t1", 2, 5);
        l.set_task_status("t1", "done", Some("looks good"));
        let done = l.task("t1").unwrap();
        assert_eq!((done.status.as_str(), done.plan_done, done.plan_total), ("done", Some(2), Some(5)));
        assert!(done.finished.is_some());
        assert_eq!(done.detail.as_deref(), Some("looks good"));
        l.set_task_status("t1", "doing", None);
        assert!(l.task("t1").unwrap().finished.is_none(), "continuing clears the finish time");
        l.set_task_status("t1", "closed", None);
        assert!(l.task_for_conversation(conv).is_none(), "closed tasks no longer own their chat");
        l.set_task_status("t1", "reviewed", None);
        assert!(l.task_for_conversation(conv).is_none(), "nor do reviewed ones");
        assert!(l.task("t1").unwrap().finished.is_some(), "reviewed is a finished state");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn messages_and_task_requests_keep_their_files() {
        let (l, p) = temp_db();
        let file = |name: &str| Attachment {
            path: format!("/kept/{name}"),
            name: name.into(),
            mime: "image/png".into(),
            kind: crate::attachments::AttachmentKind::Image,
            size: 3,
        };
        let conv = l.create_conversation("jarvis", "/work/app", "Chat");
        l.add_message_with(conv, "jarvis", "user", Some("look"), None, None, &[file("a.png")]);
        l.add_message_to(conv, "jarvis", "agent", Some("seen"), None, None);
        let messages = l.conversation_messages(conv, 10);
        assert_eq!(messages[0].attachments, vec![file("a.png")]);
        assert!(messages[1].attachments.is_empty());
        assert_eq!(l.conversation_attachments(conv), vec![file("a.png")]);

        l.create_task(&NewTask {
            id: "t1",
            title: "t1",
            assignee: "jarvis",
            status: "todo",
            cwd: "/work/app",
            parent_id: None,
            requested_by: "you",
            prompt: "look",
        });
        assert!(l.task_attachments("t1").is_empty());
        l.set_task_attachments("t1", &[file("b.png")]);
        assert_eq!(l.task_attachments("t1"), vec![file("b.png")]);
        assert!(l.attachment_in_use("/kept/a.png") && l.attachment_in_use("/kept/b.png"));
        assert!(!l.attachment_in_use("/kept/c.png"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn deleting_a_chat_removes_its_messages_and_keeps_its_tasks() {
        let (l, p) = temp_db();
        let conv = l.create_conversation("jarvis", "/work/app", "Chat");
        let other = l.create_conversation("jarvis", "/work/app", "Other");
        l.add_message_to(conv, "jarvis", "user", Some("hello"), None, None);
        l.add_message_to(other, "jarvis", "user", Some("keep me"), None, None);
        l.create_task(&NewTask {
            id: "t1",
            title: "t1",
            assignee: "jarvis",
            status: "todo",
            cwd: "/work/app",
            parent_id: None,
            requested_by: "you",
            prompt: "",
        });
        l.begin_task("t1", Some(conv), "");
        l.open_conversation(conv);
        assert!(l.delete_conversation(conv));
        assert!(l.conversation(conv).is_none());
        assert!(l.conversation_messages(conv, 10).is_empty());
        assert_eq!(l.conversation_messages(other, 10).len(), 1, "other chats are untouched");
        let task = l.task("t1").expect("the task stays");
        assert_eq!(task.conversation_id, None);
        assert_ne!(l.current_conversation("jarvis"), Some(conv), "it's no longer the open chat");
        assert!(!l.delete_conversation(conv), "nothing left to delete");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn a_task_shows_its_own_part_of_a_shared_chat() {
        let (l, p) = temp_db();
        let tick = || std::thread::sleep(std::time::Duration::from_millis(3));
        let task = |id: &'static str| NewTask {
            id,
            title: id,
            assignee: "jarvis",
            status: "todo",
            cwd: "/work/app",
            parent_id: None,
            requested_by: "you",
            prompt: id,
        };
        let conv = l.create_conversation("jarvis", "/work/app", "Chat");
        l.add_message_to(conv, "jarvis", "user", Some("before any task"), None, None);
        tick();
        l.create_task(&task("first"));
        l.begin_task("first", Some(conv), "");
        tick();
        l.add_message_to(conv, "jarvis", "user", Some("first request"), None, None);
        l.add_message_to(conv, "jarvis", "agent", Some("first answer"), None, None);
        tick();
        l.create_task(&task("second"));
        l.begin_task("second", Some(conv), "");
        tick();
        l.add_message_to(conv, "jarvis", "user", Some("second request"), None, None);
        let texts = |id: &str| l.task_messages(&l.task(id).unwrap(), 50).into_iter().filter_map(|m| m.text).collect::<Vec<_>>();
        assert_eq!(texts("first"), vec!["first request", "first answer"]);
        assert_eq!(texts("second"), vec!["second request"]);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn requests_continue_the_developers_chat_in_that_project() {
        let (l, p) = temp_db();
        assert_eq!(l.chat_in("jarvis", "/work/app"), None, "no chat there yet");
        let older = l.create_conversation("jarvis", "/work/app", "First");
        let elsewhere = l.create_conversation("jarvis", "/work/api", "Other project");
        assert_eq!(l.chat_in("jarvis", "/work/app/"), Some(older), "the latest chat in that folder");
        // A delegation that ran in its own chat in the same folder never counts.
        let delegated = l.create_conversation("jarvis", "/work/app", "Delegated");
        l.create_task(&NewTask {
            id: "child",
            title: "Delegated",
            assignee: "jarvis",
            status: "doing",
            cwd: "/work/app",
            parent_id: Some("parent"),
            requested_by: "vision",
            prompt: "",
        });
        l.begin_task("child", Some(delegated), "");
        assert!(l.conversation(delegated).unwrap().delegated);
        assert_eq!(l.chat_in("jarvis", "/work/app"), Some(older));
        // The chat the developer has open wins while it's in that folder.
        let newer = l.create_conversation("jarvis", "/work/app", "Second");
        l.open_conversation(older);
        assert_eq!(l.chat_in("jarvis", "/work/app"), Some(older));
        l.open_conversation(elsewhere);
        assert_eq!(l.chat_in("jarvis", "/work/app"), Some(newer));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn delegated_children_and_events() {
        let (l, p) = temp_db();
        let new = |id: &'static str, parent: Option<&'static str>| NewTask {
            id,
            title: id,
            assignee: "friday",
            status: "doing",
            cwd: "/w",
            parent_id: parent,
            requested_by: "jarvis",
            prompt: "",
        };
        l.create_task(&new("parent", None));
        l.create_task(&new("child-a", Some("parent")));
        l.create_task(&new("child-b", Some("parent")));
        let kids: Vec<String> = l.child_tasks("parent").into_iter().map(|t| t.id).collect();
        assert_eq!(kids, vec!["child-a", "child-b"]);
        l.add_task_event("parent", "friday", "file", "Edited src/a.ts", "{\"path\":\"src/a.ts\"}");
        l.add_task_event("parent", "friday", "verification", "npm test passed", "");
        let events = l.task_events("parent", 10);
        assert_eq!(events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["file", "verification"]);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn reminders_round_trip_and_settle_their_notification() {
        let (l, p) = temp_db();
        let base = Reminder {
            id: 0,
            text: "Check the deploy".into(),
            agent_id: "veronica".into(),
            task_id: Some("t-1".into()),
            due: 2_000,
            repeat: Some(crate::schedule::Schedule::Weekdays { time: "09:30".into() }),
            status: "waiting".into(),
            fired: None,
            set_by: "you".into(),
            created: 0,
            updated: 0,
        };
        let saved = l.save_reminder(&base).expect("saved");
        let later = l.save_reminder(&Reminder { due: 1_000, repeat: None, task_id: None, ..base.clone() }).expect("saved");
        assert_eq!(l.reminders().iter().map(|r| r.id).collect::<Vec<_>>(), vec![later.id, saved.id], "soonest first");
        assert_eq!(saved.repeat, base.repeat);
        assert_eq!(saved.task_id.as_deref(), Some("t-1"));

        let fired = l.save_reminder(&Reminder { status: "due".into(), fired: Some(3_000), ..saved.clone() }).unwrap();
        assert_eq!((fired.status.as_str(), fired.fired, fired.text.as_str()), ("due", Some(3_000), "Check the deploy"));

        let n = l
            .add_notification(&NewNotification { kind: "reminder", urgency: "needs_you", agent_id: "veronica", title: "Check the deploy", reminder_id: Some(saved.id), ..Default::default() })
            .unwrap();
        assert_eq!(n.reminder_id, Some(saved.id));
        assert_eq!(l.handle_reminder_notifications(saved.id, "Done"), vec![n.id]);
        assert!(l.handle_reminder_notifications(saved.id, "Done").is_empty());
        assert_eq!(l.notification(n.id).unwrap().outcome.as_deref(), Some("Done"));

        l.delete_reminder(saved.id);
        assert!(l.reminder(saved.id).is_none());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn settling_returns_every_matching_id_once() {
        let l = Ledger::open(std::path::Path::new(":memory:")).unwrap();
        let notice = NewNotification { kind: "task_ready", task_id: Some("t1"), review_id: Some("r1"), ..Default::default() };
        let first = l.add_notification(&notice).unwrap();
        let second = l.add_notification(&notice).unwrap();
        let other = l.add_notification(&NewNotification { task_id: Some("t2"), review_id: Some("r2"), ..notice }).unwrap();
        let mut ids = l.handle_notifications(Some("r1"), Some("t1"), &["task_ready", "task_ready"], "Reviewed");
        ids.sort_unstable();
        assert_eq!(ids, vec![first.id, second.id]);
        assert!(l.handle_notifications(Some("r1"), Some("t1"), &["task_ready"], "Reviewed").is_empty());
        assert!(l.notification(other.id).unwrap().handled.is_none());
        for id in ids {
            let saved = l.notification(id).unwrap();
            assert!(saved.read && saved.handled.is_some());
            assert_eq!(saved.outcome.as_deref(), Some("Reviewed"));
        }
    }

    #[test]
    fn notifications_are_settled_by_review_or_task() {
        let (l, p) = temp_db();
        let base = |kind: &'static str, review: Option<&'static str>, task: Option<&'static str>| NewNotification {
            kind,
            urgency: "needs_you",
            agent_id: "friday",
            task_id: task,
            cwd: "/w",
            title: "t",
            body: "",
            review_id: review,
            automation_id: None,
            reminder_id: None,
        };
        let approval = l.add_notification(&base("approval", Some("rv-1"), Some("t1"))).unwrap();
        let ready = l.add_notification(&base("task_ready", None, Some("t1"))).unwrap();
        assert!(!approval.read && approval.handled.is_none());
        assert_eq!(l.handle_notifications(Some("rv-1"), None, &[], "Allowed once"), vec![approval.id]);
        assert!(l.handle_notifications(Some("rv-1"), None, &[], "Allowed once").is_empty());
        assert_eq!(l.notification(approval.id).unwrap().outcome.as_deref(), Some("Allowed once"));
        assert!(l.notification(ready.id).unwrap().handled.is_none(), "only the review's own notice is settled");
        assert_eq!(l.handle_notifications(None, Some("t1"), &["task_ready"], "Closed"), vec![ready.id]);
        assert!(l.handle_notifications(None, Some("t1"), &["task_ready"], "Closed").is_empty());
        let missed = l
            .add_notification(&NewNotification { kind: "automation_missed", urgency: "needs_you", agent_id: "jarvis", title: "Nightly review missed a run", automation_id: Some(7), ..Default::default() })
            .unwrap();
        assert_eq!(l.handle_automation_notifications(7, "Ran it now"), vec![missed.id]);
        assert!(l.handle_automation_notifications(7, "Ran it now").is_empty());
        assert_eq!(l.notification(missed.id).unwrap().outcome.as_deref(), Some("Ran it now"));
        let update = l.add_notification(&base("check_failed", None, None)).unwrap();
        let another = l.add_notification(&base("claim_refused", None, None)).unwrap();
        assert_eq!(l.mark_notifications_read(&[update.id, update.id, -1]), vec![update.id]);
        assert!(l.mark_notifications_read(&[update.id]).is_empty());
        assert_eq!(l.mark_all_notifications_read(), vec![another.id]);
        assert!(l.mark_all_notifications_read().is_empty());
        assert!(l.notifications(10).iter().all(|n| n.read));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rules_are_kept_and_revoked_not_deleted() {
        let (l, p) = temp_db();
        let key = crate::policy::RuleKey { tool: "Bash".into(), pattern: "npm install".into(), display: "`npm install` commands".into() };
        let rule = l.add_rule("project", None, Some("/w/app"), &key, "Install or update dependencies", "approval").unwrap();
        l.record_rule_use(rule.id);
        assert_eq!(l.rules(false)[0].uses, 1);
        assert!(l.revoke_rule(rule.id));
        assert!(l.rules(false).is_empty());
        assert_eq!(l.rules(true).len(), 1, "revoked rules stay in the record");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn automations_and_their_runs() {
        let (l, p) = temp_db();
        let draft = Automation {
            id: 0,
            name: "Nightly code review".into(),
            agent_id: "jarvis".into(),
            cwd: "/w/app".into(),
            instruction: "Review today's changes".into(),
            schedule: crate::schedule::Schedule::Weekdays { time: "02:00".into() },
            enabled: true,
            missed: "run_once".into(),
            notify: "failure".into(),
            max_minutes: 60,
            wake: false,
            created: 0,
            updated: 0,
            next_run: Some(1_000),
            last_run: None,
            last_status: None,
        };
        let saved = l.save_automation(&draft).unwrap();
        assert!(saved.id > 0);
        assert_eq!(saved.schedule, crate::schedule::Schedule::Weekdays { time: "02:00".into() });
        let run = l.add_automation_run(saved.id, 1_000, "you", "running", Some("task-1"), "").unwrap();
        assert_eq!(run.trigger, "you");
        assert!(run.started.is_some() && run.finished.is_none());
        assert_eq!(l.unfinished_runs().len(), 1);
        assert_eq!(l.run_for_task("task-1").map(|r| r.id), Some(run.id));
        l.finish_run(run.id, "succeeded", "Finished");
        assert!(l.unfinished_runs().is_empty());
        l.set_automation_schedule_state(saved.id, Some(2_000), Some(1_000), Some("succeeded"));
        let after = l.automation(saved.id).unwrap();
        assert_eq!((after.next_run, after.last_status.as_deref()), (Some(2_000), Some("succeeded")));
        let missed = l.add_automation_run(saved.id, 3_000, "schedule", "missed", None, "The Mac was asleep").unwrap();
        assert!(missed.started.is_none() && missed.finished.is_some());
        let failed = l.add_automation_run(saved.id, 4_000, "schedule", "failed", None, "Couldn't start").unwrap();
        assert!(failed.finished.is_some(), "a run that failed to start is over");
        assert!(l.unfinished_runs().is_empty());
        assert_eq!(l.automation_runs(saved.id, 10).len(), 3);
        l.delete_automation(saved.id);
        assert!(l.automation(saved.id).is_none() && l.automation_runs(saved.id, 10).is_empty());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn messages_can_go_to_a_conversation_that_is_not_active() {
        let (l, p) = temp_db();
        let main = l.active_conversation("friday");
        let side = l.create_conversation("friday", "/w", "Delegated");
        l.add_message_to(side, "friday", "agent", Some("side work"), None, None);
        l.add_message("friday", "agent", Some("main chat"), None, None);
        assert_eq!(l.active_conversation("friday"), main, "a side conversation doesn't take over");
        assert_eq!(l.conversation_messages(side, 10)[0].text.as_deref(), Some("side work"));
        assert_eq!(l.messages("friday", 10)[0].text.as_deref(), Some("main chat"));
        std::fs::remove_file(&p).ok();
    }
}
