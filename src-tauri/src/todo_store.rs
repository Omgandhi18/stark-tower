//! Where to-do lists and their to-dos are kept, in the ledger's database.

use rusqlite::Row;
use serde::{Deserialize, Serialize};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS todo_lists (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    project    TEXT    NOT NULL DEFAULT '',
    start_mode TEXT    NOT NULL DEFAULT 'manual',
    position   INTEGER NOT NULL DEFAULT 0,
    created    INTEGER NOT NULL,
    updated    INTEGER NOT NULL,
    -- The number the next to-do on this list gets. Only ever goes up, so a number is never reused.
    next_number INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS todos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id     INTEGER NOT NULL,
    title       TEXT    NOT NULL,
    notes       TEXT    NOT NULL DEFAULT '',
    agent_id    TEXT,
    task_id     TEXT,
    due         INTEGER,
    reminder_id INTEGER,
    done        INTEGER,
    done_by     TEXT,
    added_by    TEXT    NOT NULL DEFAULT 'you',
    position    INTEGER NOT NULL DEFAULT 0,
    created     INTEGER NOT NULL,
    updated     INTEGER NOT NULL,
    number      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS todos_by_list ON todos (list_id, position);
CREATE INDEX IF NOT EXISTS todos_by_task ON todos (task_id);
-- Which list a whole-list handoff gave a task, so its `complete_todo` numbers mean that list.
CREATE TABLE IF NOT EXISTS todo_handoffs (
    task_id TEXT    PRIMARY KEY,
    list_id INTEGER NOT NULL
);
";

/// What became of a number that no longer has a to-do: deleted, or moved to another list (where
/// it's found again through `todo_id`). Kept so an agent holding "#5" can be told the truth.
const TOMBSTONES: &str = "
CREATE TABLE IF NOT EXISTS todo_tombstones (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id INTEGER NOT NULL,
    number  INTEGER NOT NULL,
    todo_id INTEGER NOT NULL,
    title   TEXT    NOT NULL,
    task_id TEXT,
    fate    TEXT    NOT NULL,
    at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS todo_tombstones_by_number ON todo_tombstones (list_id, number);
CREATE INDEX IF NOT EXISTS todo_tombstones_by_todo ON todo_tombstones (todo_id);
";

const DELETED: &str = "deleted";
const MOVED: &str = "moved";

/// Bring a database from before per-list numbers up to date: add the columns, number every
/// to-do that has none (1, 2, 3… in the order it was made, within its list), keep a list
/// from ever holding one number twice, and set each list's counter past every number it has
/// used. Safe to run on every start: it only touches to-dos without a number, and the counter
/// only ever goes up (to one past the list's highest number, or its tombstones').
pub fn migrate(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(TOMBSTONES)?;
    let has_counter = conn.prepare("SELECT 1 FROM pragma_table_info('todo_lists') WHERE name = 'next_number'")?.exists([])?;
    if !has_counter {
        conn.execute("ALTER TABLE todo_lists ADD COLUMN next_number INTEGER NOT NULL DEFAULT 1", [])?;
    }
    let has_number = conn.prepare("SELECT 1 FROM pragma_table_info('todos') WHERE name = 'number'")?.exists([])?;
    if !has_number {
        conn.execute("ALTER TABLE todos ADD COLUMN number INTEGER NOT NULL DEFAULT 0", [])?;
    }
    let tx = conn.unchecked_transaction()?;
    let unnumbered: Vec<(i64, i64)> = {
        let mut stmt = tx.prepare("SELECT id, list_id FROM todos WHERE number = 0 ORDER BY list_id, created, id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        rows
    };
    let mut next: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for (id, list_id) in unnumbered {
        if !next.contains_key(&list_id) {
            let top: i64 = tx.query_row("SELECT COALESCE(MAX(number), 0) FROM todos WHERE list_id = ?1", [list_id], |r| r.get(0))?;
            next.insert(list_id, top);
        }
        let n = next.get_mut(&list_id).unwrap();
        *n += 1;
        tx.execute("UPDATE todos SET number = ?2 WHERE id = ?1", [id, *n])?;
    }
    tx.execute(
        "UPDATE todo_lists SET next_number = MAX(next_number, \
         COALESCE((SELECT MAX(number) FROM todos WHERE list_id = todo_lists.id), 0) + 1, \
         COALESCE((SELECT MAX(number) FROM todo_tombstones WHERE list_id = todo_lists.id), 0) + 1)",
        [],
    )?;
    tx.commit()?;
    // A safety net only: the numbers above are already distinct, so a failure here mustn't stop the app opening.
    let _ = conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS todos_number_per_list ON todos (list_id, number)", []);
    Ok(())
}

/// A named list of to-dos, tied to a project or not.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct TodoList {
    pub id: i64,
    pub name: String,
    /// The project folder its agent work runs in; "" for a list that isn't about one.
    pub project: String,
    /// What assigning an agent does: "manual" (it waits for Start), "now" (it starts at once)
    /// or "when_free" (it starts when the agent has nothing running).
    pub start_mode: String,
    pub position: i64,
    pub created: i64,
    pub updated: i64,
}

/// One thing to do, done by you or by the agent it's assigned to.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, PartialEq)]
pub struct Todo {
    pub id: i64,
    pub list_id: i64,
    /// Its number on its list: #1, #2, … Fixed when it's added, so ticking or reordering never
    /// renumbers anything; a to-do moved to another list takes that list's next number.
    pub number: i64,
    pub title: String,
    pub notes: String,
    /// Who'll do it.
    pub agent_id: Option<String>,
    /// The task it started, once an agent's on it.
    pub task_id: Option<String>,
    /// When it's due (Unix ms); you're reminded then.
    pub due: Option<i64>,
    /// The reminder for its due time.
    pub reminder_id: Option<i64>,
    /// When it was ticked off.
    pub done: Option<i64>,
    /// Who ticked it off: "you", or an agent.
    pub done_by: Option<String>,
    /// Who added it: "you", or an agent.
    pub added_by: String,
    pub position: i64,
    pub created: i64,
    pub updated: i64,
}

/// Where a number on a list stands now: what an agent holding it needs to know before it acts.
#[derive(Debug, Clone, PartialEq)]
pub enum Standing {
    /// The to-do is there, open or done.
    Found(Todo),
    /// It was moved to another list, where it is now `number`.
    Moved { title: String, task_id: Option<String>, list_id: i64, number: i64 },
    /// It was deleted.
    Deleted { title: String, task_id: Option<String>, at: i64 },
    /// No record: it never existed, or it was deleted before deletions were kept.
    Missing,
}

const LIST_COLUMNS: &str = "id, name, project, start_mode, position, created, updated";
const TODO_COLUMNS: &str = "id, list_id, title, notes, agent_id, task_id, due, reminder_id, done, done_by, added_by, position, created, updated, number";

fn list_from_row(r: &Row) -> rusqlite::Result<TodoList> {
    Ok(TodoList { id: r.get(0)?, name: r.get(1)?, project: r.get(2)?, start_mode: r.get(3)?, position: r.get(4)?, created: r.get(5)?, updated: r.get(6)? })
}

fn todo_from_row(r: &Row) -> rusqlite::Result<Todo> {
    Ok(Todo {
        id: r.get(0)?,
        list_id: r.get(1)?,
        title: r.get(2)?,
        notes: r.get(3)?,
        agent_id: r.get(4)?,
        task_id: r.get(5)?,
        due: r.get(6)?,
        reminder_id: r.get(7)?,
        done: r.get(8)?,
        done_by: r.get(9)?,
        added_by: r.get(10)?,
        position: r.get(11)?,
        created: r.get(12)?,
        updated: r.get(13)?,
        number: r.get(14)?,
    })
}

/// The number a new to-do on this list gets, and the counter moved past it. Never lower than one
/// past any number the list has had, so even a stale counter can't hand a number out twice.
fn take_number(conn: &rusqlite::Connection, list_id: i64) -> rusqlite::Result<i64> {
    let number: i64 = conn.query_row(
        "SELECT MAX(next_number, COALESCE((SELECT MAX(number) FROM todos WHERE list_id = ?1), 0) + 1, \
         COALESCE((SELECT MAX(number) FROM todo_tombstones WHERE list_id = ?1), 0) + 1) FROM todo_lists WHERE id = ?1",
        [list_id],
        |r| r.get(0),
    )?;
    conn.execute("UPDATE todo_lists SET next_number = ?2 WHERE id = ?1", [list_id, number + 1])?;
    Ok(number)
}

/// Remember that this to-do no longer has this number on its list.
fn leave_tombstone(conn: &rusqlite::Connection, todo_id: i64, fate: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO todo_tombstones (list_id, number, todo_id, title, task_id, fate, at) \
         SELECT list_id, number, id, title, task_id, ?2, ?3 FROM todos WHERE id = ?1",
        rusqlite::params![todo_id, fate, crate::ledger::now_ms()],
    )?;
    Ok(())
}

fn standing_of(conn: &rusqlite::Connection, tomb: Tomb) -> Standing {
    let live = conn.query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"), [tomb.todo_id], todo_from_row).ok();
    match (tomb.fate.as_str(), live) {
        (MOVED, Some(now)) => Standing::Moved { title: tomb.title, task_id: now.task_id, list_id: now.list_id, number: now.number },
        _ => Standing::Deleted { title: tomb.title, task_id: tomb.task_id, at: tomb.at },
    }
}

struct Tomb {
    todo_id: i64,
    title: String,
    task_id: Option<String>,
    fate: String,
    at: i64,
}

const TOMB_COLUMNS: &str = "todo_id, title, task_id, fate, at";

fn tomb_from_row(r: &Row) -> rusqlite::Result<Tomb> {
    Ok(Tomb { todo_id: r.get(0)?, title: r.get(1)?, task_id: r.get(2)?, fate: r.get(3)?, at: r.get(4)? })
}

impl crate::ledger::Ledger {
    /// Every list, in the order you keep them.
    pub fn todo_lists(&self) -> Vec<TodoList> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(&format!("SELECT {LIST_COLUMNS} FROM todo_lists ORDER BY position, id")) else { return vec![] };
        stmt.query_map([], list_from_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn todo_list(&self, id: i64) -> Option<TodoList> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {LIST_COLUMNS} FROM todo_lists WHERE id = ?1"), [id], list_from_row).ok()
    }

    /// Create a list (id 0, at the end) or change one.
    pub fn save_todo_list(&self, list: &TodoList) -> Option<TodoList> {
        let ts = crate::ledger::now_ms();
        let id = {
            let conn = self.conn.lock().unwrap();
            if list.id > 0 {
                conn.execute(
                    "UPDATE todo_lists SET name = ?2, project = ?3, start_mode = ?4, updated = ?5 WHERE id = ?1",
                    rusqlite::params![list.id, list.name, list.project, list.start_mode, ts],
                )
                .ok()?;
                list.id
            } else {
                let position: i64 = conn.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM todo_lists", [], |r| r.get(0)).ok()?;
                conn.execute(
                    "INSERT INTO todo_lists (name, project, start_mode, position, created, updated) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                    rusqlite::params![list.name, list.project, list.start_mode, position, ts],
                )
                .ok()?;
                conn.last_insert_rowid()
            }
        };
        self.todo_list(id)
    }

    /// A list goes, with its to-dos. Tasks they started stay in history.
    pub fn delete_todo_list(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM todos WHERE list_id = ?1", [id]);
        let _ = conn.execute("DELETE FROM todo_handoffs WHERE list_id = ?1", [id]);
        let _ = conn.execute("DELETE FROM todo_tombstones WHERE list_id = ?1", [id]);
        let _ = conn.execute("DELETE FROM todo_lists WHERE id = ?1", [id]);
    }

    /// Every to-do, list by list, in the order you keep them.
    pub fn todos(&self) -> Vec<Todo> {
        let conn = self.conn.lock().unwrap();
        let Ok(mut stmt) = conn.prepare(&format!("SELECT {TODO_COLUMNS} FROM todos ORDER BY list_id, position, id")) else { return vec![] };
        stmt.query_map([], todo_from_row).map(|rows| rows.filter_map(Result::ok).collect()).unwrap_or_default()
    }

    pub fn todo(&self, id: i64) -> Option<Todo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"), [id], todo_from_row).ok()
    }

    /// The to-do with this number on this list.
    pub fn todo_numbered(&self, list_id: i64, number: i64) -> Option<Todo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE list_id = ?1 AND number = ?2"), [list_id, number], todo_from_row).ok()
    }

    /// Where a number on a list stands: there, moved (and to where), deleted, or unknown.
    pub fn standing(&self, list_id: i64, number: i64) -> Standing {
        let conn = self.conn.lock().unwrap();
        if let Ok(todo) = conn.query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE list_id = ?1 AND number = ?2"), [list_id, number], todo_from_row) {
            return Standing::Found(todo);
        }
        conn.query_row(&format!("SELECT {TOMB_COLUMNS} FROM todo_tombstones WHERE list_id = ?1 AND number = ?2"), [list_id, number], tomb_from_row)
            .map_or(Standing::Missing, |tomb| standing_of(&conn, tomb))
    }

    /// Where a to-do stands by its global id (the old way agents pointed at one).
    pub fn standing_by_id(&self, id: i64) -> Standing {
        let conn = self.conn.lock().unwrap();
        if let Ok(todo) = conn.query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE id = ?1"), [id], todo_from_row) {
            return Standing::Found(todo);
        }
        conn.query_row(&format!("SELECT {TOMB_COLUMNS} FROM todo_tombstones WHERE todo_id = ?1 ORDER BY id DESC LIMIT 1"), [id], tomb_from_row)
            .map_or(Standing::Missing, |tomb| Standing::Deleted { title: tomb.title, task_id: tomb.task_id, at: tomb.at })
    }

    /// Tick off a to-do only if it is still exactly the one seen: same list, number and title, and
    /// still open. One statement, so nothing can change between the check and the tick.
    pub fn tick_if_unchanged(&self, seen: &Todo, by: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE todos SET done = ?5, done_by = ?6, updated = ?5 WHERE id = ?1 AND list_id = ?2 AND number = ?3 AND title = ?4 AND done IS NULL",
            rusqlite::params![seen.id, seen.list_id, seen.number, seen.title, crate::ledger::now_ms(), by],
        )
        .is_ok_and(|rows| rows == 1)
    }

    /// Remember that a task was given a whole list to work through.
    pub fn record_list_handoff(&self, task_id: &str, list_id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("INSERT OR REPLACE INTO todo_handoffs (task_id, list_id) VALUES (?1, ?2)", rusqlite::params![task_id, list_id]);
    }

    /// The list a task was handed whole, if it was.
    pub fn list_handed_for_task(&self, task_id: &str) -> Option<i64> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT list_id FROM todo_handoffs WHERE task_id = ?1", [task_id], |r| r.get(0)).ok()
    }

    /// The to-do a task was started for, if one was.
    pub fn todo_for_task(&self, task_id: &str) -> Option<Todo> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {TODO_COLUMNS} FROM todos WHERE task_id = ?1 ORDER BY id DESC LIMIT 1"), [task_id], todo_from_row).ok()
    }

    /// Create a to-do (id 0, at the end of its list) or change one.
    pub fn save_todo(&self, t: &Todo) -> Option<Todo> {
        let ts = crate::ledger::now_ms();
        let id = {
            let conn = self.conn.lock().unwrap();
            let tx = conn.unchecked_transaction().ok()?;
            let id = if t.id > 0 {
                // Moved to another list, it takes that list's next number and leaves its old one behind.
                let (was_list, was_number): (i64, i64) = tx.query_row("SELECT list_id, number FROM todos WHERE id = ?1", [t.id], |r| Ok((r.get(0)?, r.get(1)?))).ok()?;
                let number = if was_list == t.list_id {
                    was_number
                } else {
                    leave_tombstone(&tx, t.id, MOVED).ok()?;
                    take_number(&tx, t.list_id).ok()?
                };
                tx.execute(
                    "UPDATE todos SET list_id = ?2, title = ?3, notes = ?4, agent_id = ?5, task_id = ?6, due = ?7, reminder_id = ?8, \
                     done = ?9, done_by = ?10, position = ?11, updated = ?12, number = ?13 WHERE id = ?1",
                    rusqlite::params![t.id, t.list_id, t.title, t.notes, t.agent_id, t.task_id, t.due, t.reminder_id, t.done, t.done_by, t.position, ts, number],
                )
                .ok()?;
                t.id
            } else {
                let position: i64 = tx.query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE list_id = ?1", [t.list_id], |r| r.get(0)).ok()?;
                let number = take_number(&tx, t.list_id).ok()?;
                tx.execute(
                    "INSERT INTO todos (list_id, title, notes, agent_id, task_id, due, reminder_id, done, done_by, added_by, position, created, updated, number) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)",
                    rusqlite::params![t.list_id, t.title, t.notes, t.agent_id, t.task_id, t.due, t.reminder_id, t.done, t.done_by, t.added_by, position, ts, number],
                )
                .ok()?;
                tx.last_insert_rowid()
            };
            tx.commit().ok()?;
            id
        };
        self.todo(id)
    }

    pub fn delete_todo(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let Ok(tx) = conn.unchecked_transaction() else { return };
        let _ = leave_tombstone(&tx, id, DELETED);
        let _ = tx.execute("DELETE FROM todos WHERE id = ?1", [id]);
        let _ = tx.commit();
    }

    /// Put a list's to-dos in this order; any not named keep their place after them.
    pub fn reorder_todos(&self, list_id: i64, ids: &[i64]) {
        let conn = self.conn.lock().unwrap();
        for (position, id) in ids.iter().enumerate() {
            let _ = conn.execute("UPDATE todos SET position = ?3 WHERE id = ?1 AND list_id = ?2", rusqlite::params![id, list_id, position as i64]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::Ledger;

    fn ledger() -> Ledger {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("stark-todos-{}-{}-{n}", std::process::id(), crate::ledger::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        Ledger::open(&dir.join("ledger.db")).unwrap()
    }

    fn list(name: &str) -> TodoList {
        TodoList { id: 0, name: name.into(), project: "/w/app".into(), start_mode: "manual".into(), position: 0, created: 0, updated: 0 }
    }

    fn todo(list_id: i64, title: &str) -> Todo {
        Todo {
            id: 0,
            list_id,
            number: 0,
            title: title.into(),
            notes: String::new(),
            agent_id: None,
            task_id: None,
            due: None,
            reminder_id: None,
            done: None,
            done_by: None,
            added_by: "you".into(),
            position: 0,
            created: 0,
            updated: 0,
        }
    }

    #[test]
    fn lists_and_todos_keep_their_order_and_go_together() {
        let l = ledger();
        let release = l.save_todo_list(&list("Release")).unwrap();
        let personal = l.save_todo_list(&list("Personal")).unwrap();
        assert_eq!(l.todo_lists().iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), ["Release", "Personal"]);

        let a = l.save_todo(&todo(release.id, "Bump the version")).unwrap();
        let b = l.save_todo(&todo(release.id, "Build the APK")).unwrap();
        l.save_todo(&todo(personal.id, "Call the bank")).unwrap();
        assert_eq!((a.position, b.position), (0, 1), "new ones go at the end of their list");

        l.reorder_todos(release.id, &[b.id, a.id]);
        let order: Vec<String> = l.todos().into_iter().filter(|t| t.list_id == release.id).map(|t| t.title).collect();
        assert_eq!(order, ["Build the APK", "Bump the version"]);

        l.save_todo(&Todo { task_id: Some("task-1".into()), ..b.clone() }).unwrap();
        assert_eq!(l.todo_for_task("task-1").map(|t| t.id), Some(b.id));

        l.delete_todo_list(release.id);
        assert!(l.todo(a.id).is_none(), "a list's to-dos go with it");
        assert_eq!(l.todos().len(), 1);
    }

    fn numbers(l: &Ledger, list_id: i64) -> Vec<(String, i64)> {
        l.todos().into_iter().filter(|t| t.list_id == list_id).map(|t| (t.title, t.number)).collect()
    }

    #[test]
    fn numbers_count_from_one_on_each_list_and_never_change() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        let b = l.save_todo_list(&list("B")).unwrap();
        // Made across both lists, so the global ids interleave: that must not show.
        let a1 = l.save_todo(&todo(a.id, "a one")).unwrap();
        let b1 = l.save_todo(&todo(b.id, "b one")).unwrap();
        let a2 = l.save_todo(&todo(a.id, "a two")).unwrap();
        let b2 = l.save_todo(&todo(b.id, "b two")).unwrap();
        assert_eq!([a1.number, a2.number, b1.number, b2.number], [1, 2, 1, 2]);
        assert_eq!(a2.id, 3, "the global id is not the number");

        // Ticking, reordering and editing leave every number where it was.
        l.save_todo(&Todo { done: Some(5), done_by: Some("you".into()), ..a1.clone() }).unwrap();
        l.reorder_todos(a.id, &[a2.id, a1.id]);
        l.save_todo(&Todo { title: "a two, reworded".into(), ..l.todo(a2.id).unwrap() }).unwrap();
        assert_eq!(numbers(&l, a.id), [("a two, reworded".to_string(), 2), ("a one".to_string(), 1)]);

        // A new one takes the list's highest + 1, even when it is not the last in order.
        let a3 = l.save_todo(&todo(a.id, "a three")).unwrap();
        assert_eq!(a3.number, 3);
        l.delete_todo(a1.id);
        assert_eq!(l.save_todo(&todo(a.id, "a four")).unwrap().number, 4, "a gap is not filled");
        assert_eq!(l.todo_numbered(a.id, 2).map(|t| t.id), Some(a2.id));
        assert_eq!(l.todo_numbered(b.id, 2).map(|t| t.id), Some(b2.id), "the same number on another list is another to-do");
        assert!(l.todo_numbered(a.id, 1).is_none());
    }

    #[test]
    fn a_todo_moved_to_another_list_takes_that_lists_next_number() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        let b = l.save_todo_list(&list("B")).unwrap();
        l.save_todo(&todo(a.id, "a one")).unwrap();
        let a2 = l.save_todo(&todo(a.id, "a two")).unwrap();
        l.save_todo(&todo(b.id, "b one")).unwrap();
        l.save_todo(&todo(b.id, "b two")).unwrap();
        let moved = l.save_todo(&Todo { list_id: b.id, ..a2 }).unwrap();
        assert_eq!((moved.list_id, moved.number), (b.id, 3));
        assert_eq!(numbers(&l, a.id), [("a one".to_string(), 1)]);
    }

    #[test]
    fn deleting_the_newest_todo_never_lets_the_next_one_take_its_number() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        l.save_todo(&todo(a.id, "one")).unwrap();
        let two = l.save_todo(&todo(a.id, "two")).unwrap();
        l.delete_todo(two.id);
        let three = l.save_todo(&todo(a.id, "three")).unwrap();
        assert_eq!(three.number, 3, "#2 is not handed out again");
        // Even deleting everything leaves the counter where it was.
        for t in l.todos() {
            l.delete_todo(t.id);
        }
        assert_eq!(l.save_todo(&todo(a.id, "four")).unwrap().number, 4);
        // The old #2 now answers as deleted, with its words, not as the new to-do.
        assert!(matches!(l.standing(a.id, 2), Standing::Deleted { ref title, .. } if title == "two"));
        assert!(matches!(l.standing(a.id, 3), Standing::Deleted { ref title, .. } if title == "three"));
        assert!(matches!(l.standing(a.id, 4), Standing::Found(ref t) if t.title == "four"));
        assert_eq!(l.standing(a.id, 99), Standing::Missing);
    }

    #[test]
    fn a_moved_todo_is_traced_and_its_old_number_is_never_handed_out_again() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        let b = l.save_todo_list(&list("B")).unwrap();
        let c = l.save_todo_list(&list("C")).unwrap();
        l.save_todo(&todo(a.id, "a one")).unwrap();
        let a2 = l.save_todo(&Todo { task_id: Some("task-7".into()), ..todo(a.id, "a two") }).unwrap();
        l.save_todo(&todo(b.id, "b one")).unwrap();
        let moved = l.save_todo(&Todo { list_id: b.id, ..a2.clone() }).unwrap();
        assert_eq!((moved.list_id, moved.number), (b.id, 2));
        assert_eq!(
            l.standing(a.id, 2),
            Standing::Moved { title: "a two".into(), task_id: Some("task-7".into()), list_id: b.id, number: 2 }
        );
        // The next new to-do on A is #3, not the vacated #2.
        assert_eq!(l.save_todo(&todo(a.id, "a three")).unwrap().number, 3);
        // Moved on again, the first trail still leads to where it is now.
        l.save_todo(&Todo { list_id: c.id, ..moved }).unwrap();
        assert!(matches!(l.standing(a.id, 2), Standing::Moved { list_id, number: 1, .. } if list_id == c.id));
        assert!(matches!(l.standing(b.id, 2), Standing::Moved { list_id, number: 1, .. } if list_id == c.id));
        // Moved back to A, it is a new number there (#4), and #2 on A still says it moved (to #4 on A).
        l.save_todo(&Todo { list_id: a.id, ..l.todo(a2.id).unwrap() }).unwrap();
        assert!(matches!(l.standing(a.id, 2), Standing::Moved { list_id, number: 4, .. } if list_id == a.id));
        // And once deleted, every old place says deleted.
        l.delete_todo(a2.id);
        assert!(matches!(l.standing(a.id, 2), Standing::Deleted { .. }));
        assert!(matches!(l.standing(b.id, 2), Standing::Deleted { .. }));
        assert!(matches!(l.standing_by_id(a2.id), Standing::Deleted { .. }));
    }

    #[test]
    fn a_tick_only_lands_on_the_todo_that_was_seen() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        let b = l.save_todo_list(&list("B")).unwrap();
        let seen = l.save_todo(&todo(a.id, "seen")).unwrap();

        // Reworded meanwhile: not the same to-do any more.
        l.save_todo(&Todo { title: "reworded".into(), ..seen.clone() }).unwrap();
        assert!(!l.tick_if_unchanged(&seen, "karen"));
        assert!(l.todo(seen.id).unwrap().done.is_none());
        let seen = l.todo(seen.id).unwrap();

        // Moved meanwhile.
        l.save_todo(&Todo { list_id: b.id, ..seen.clone() }).unwrap();
        assert!(!l.tick_if_unchanged(&seen, "karen"));
        let seen = l.todo(seen.id).unwrap();

        assert!(l.tick_if_unchanged(&seen, "karen"));
        assert_eq!(l.todo(seen.id).unwrap().done_by.as_deref(), Some("karen"));
        assert!(!l.tick_if_unchanged(&seen, "karen"), "already done: not ticked twice");

        // Deleted meanwhile.
        let gone = l.save_todo(&todo(a.id, "gone")).unwrap();
        l.delete_todo(gone.id);
        assert!(!l.tick_if_unchanged(&gone, "karen"));
    }

    #[test]
    fn deleting_a_list_clears_its_tombstones() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        let t = l.save_todo(&todo(a.id, "x")).unwrap();
        l.delete_todo(t.id);
        l.delete_todo_list(a.id);
        assert_eq!(l.standing(a.id, 1), Standing::Missing);
    }

    #[test]
    fn a_list_handoff_is_remembered_until_the_list_goes() {
        let l = ledger();
        let a = l.save_todo_list(&list("A")).unwrap();
        l.record_list_handoff("task-9", a.id);
        assert_eq!(l.list_handed_for_task("task-9"), Some(a.id));
        assert_eq!(l.list_handed_for_task("task-10"), None);
        l.delete_todo_list(a.id);
        assert_eq!(l.list_handed_for_task("task-9"), None);
    }

    /// The tables as they were before numbers: two lists whose ids interleave, one with a
    /// to-do made out of id order, and one list left empty.
    fn old_database() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        fill_old(&conn);
        conn
    }

    fn fill_old(conn: &rusqlite::Connection) {
        conn.execute_batch(
            "CREATE TABLE todo_lists (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', start_mode TEXT NOT NULL DEFAULT 'manual', position INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
             CREATE TABLE todos (id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', agent_id TEXT, task_id TEXT, due INTEGER, reminder_id INTEGER, done INTEGER, done_by TEXT, added_by TEXT NOT NULL DEFAULT 'you', position INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, updated INTEGER NOT NULL);
             CREATE INDEX todos_by_list ON todos (list_id, position);
             INSERT INTO todo_lists (id, name, created, updated) VALUES (1, 'Inbox', 0, 0), (2, 'Release', 0, 0), (3, 'Empty', 0, 0);
             INSERT INTO todos (id, list_id, title, position, created, updated, done) VALUES
                 (1, 1, 'inbox one',    0, 100, 100, NULL),
                 (2, 2, 'release one',  0, 110, 110, 1),
                 (3, 1, 'inbox two',    1, 120, 120, NULL),
                 (4, 2, 'release two',  2, 130, 130, NULL),
                 (5, 2, 'release made first but reordered last', 5, 105, 105, NULL);",
        )
        .unwrap();
    }

    fn numbered(conn: &rusqlite::Connection) -> Vec<(i64, i64, i64)> {
        let mut stmt = conn.prepare("SELECT id, list_id, number FROM todos ORDER BY id").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn migrating_an_old_database_numbers_each_list_by_creation_order() {
        let conn = old_database();
        migrate(&conn).unwrap();
        // (id, list, number): list 2 by `created` is 5 (105), 2 (110), 4 (130) - not by id, position or done.
        assert_eq!(numbered(&conn), [(1, 1, 1), (2, 2, 2), (3, 1, 2), (4, 2, 3), (5, 2, 1)]);
    }

    #[test]
    fn migrating_twice_changes_nothing_and_continues_after_new_ones() {
        let conn = old_database();
        migrate(&conn).unwrap();
        let first = numbered(&conn);
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(numbered(&conn), first, "running it again renumbers nothing");

        // A to-do added after the first run, then another run (the next start-up): still untouched.
        conn.execute("INSERT INTO todos (list_id, title, created, updated, number) VALUES (2, 'later', 200, 200, 4)", []).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(numbered(&conn).last(), Some(&(6, 2, 4)));

        // Anything left without a number (e.g. a half-finished earlier run) goes after the list's highest.
        conn.execute("INSERT INTO todos (list_id, title, created, updated) VALUES (2, 'stray', 50, 50)", []).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(numbered(&conn).last(), Some(&(7, 2, 5)));
        assert_eq!(numbered(&conn)[..5], first[..], "the earlier ones keep theirs");
    }

    #[test]
    fn migrating_a_new_database_and_an_empty_one_is_harmless() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        // The duplicate guard is in place.
        conn.execute("INSERT INTO todos (list_id, title, created, updated, number) VALUES (1, 'x', 0, 0, 1)", []).unwrap();
        assert!(conn.execute("INSERT INTO todos (list_id, title, created, updated, number) VALUES (1, 'y', 0, 0, 1)", []).is_err());
        assert!(conn.execute("INSERT INTO todos (list_id, title, created, updated, number) VALUES (2, 'y', 0, 0, 1)", []).is_ok());
    }

    fn counters(conn: &rusqlite::Connection) -> Vec<(i64, i64)> {
        let mut stmt = conn.prepare("SELECT id, next_number FROM todo_lists ORDER BY id").unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().map(Result::unwrap).collect()
    }

    #[test]
    fn migrating_sets_each_lists_counter_past_its_highest_number_and_never_lowers_it() {
        let conn = old_database();
        migrate(&conn).unwrap();
        // Inbox has 1-2, Release 1-3, the empty list none.
        assert_eq!(counters(&conn), [(1, 3), (2, 4), (3, 1)]);
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(counters(&conn), [(1, 3), (2, 4), (3, 1)], "running it again changes nothing");

        // A counter that is already ahead (numbers were handed out and then deleted) stays ahead.
        conn.execute("UPDATE todo_lists SET next_number = 10 WHERE id = 1", []).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(counters(&conn)[0], (1, 10));

        // A tombstone above the counter pulls it up, so a number that was used is never offered.
        conn.execute("INSERT INTO todo_tombstones (list_id, number, todo_id, title, fate, at) VALUES (3, 6, 99, 'old', 'deleted', 0)", []).unwrap();
        migrate(&conn).unwrap();
        assert_eq!(counters(&conn)[2], (3, 7));
    }

    #[test]
    fn migrating_an_old_database_keeps_every_existing_number_and_the_data_it_had() {
        let conn = old_database();
        migrate(&conn).unwrap();
        let before = numbered(&conn);
        migrate(&conn).unwrap();
        assert_eq!(numbered(&conn), before);
        let titles: i64 = conn.query_row("SELECT COUNT(*) FROM todos", [], |r| r.get(0)).unwrap();
        assert_eq!(titles, 5);
        let tombstones: i64 = conn.query_row("SELECT COUNT(*) FROM todo_tombstones", [], |r| r.get(0)).unwrap();
        assert_eq!(tombstones, 0, "nothing is invented for what was deleted before");
    }

    #[test]
    fn opening_the_ledger_on_an_old_database_file_numbers_it_once() {
        let dir = std::env::temp_dir().join(format!("stark-todos-old-{}-{}", std::process::id(), crate::ledger::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("ledger.db");
        fill_old(&rusqlite::Connection::open(&path).unwrap());

        let numbers_of = |l: &Ledger| l.todos().into_iter().map(|t| (t.id, t.list_id, t.number)).collect::<Vec<_>>();
        let l = Ledger::open(&path).unwrap();
        let expected = vec![(1, 1, 1), (2, 2, 2), (3, 1, 2), (4, 2, 3), (5, 2, 1)];
        let mut got = numbers_of(&l);
        got.sort();
        assert_eq!(got, expected);
        // Their other fields survive, and a new one carries on from the list's highest.
        assert_eq!(l.todo(2).unwrap().done, Some(1));
        assert_eq!(l.save_todo(&todo(2, "release three")).unwrap().number, 4);
        drop(l);

        // The next start-up changes nothing.
        let again = Ledger::open(&path).unwrap();
        let mut got = numbers_of(&again);
        got.sort();
        assert_eq!(got, [expected.clone(), vec![(6, 2, 4)]].concat());
    }
}
