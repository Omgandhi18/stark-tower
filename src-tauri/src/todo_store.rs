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
    updated    INTEGER NOT NULL
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
    updated     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS todos_by_list ON todos (list_id, position);
CREATE INDEX IF NOT EXISTS todos_by_task ON todos (task_id);
";

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

const LIST_COLUMNS: &str = "id, name, project, start_mode, position, created, updated";
const TODO_COLUMNS: &str = "id, list_id, title, notes, agent_id, task_id, due, reminder_id, done, done_by, added_by, position, created, updated";

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
    })
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
            if t.id > 0 {
                conn.execute(
                    "UPDATE todos SET list_id = ?2, title = ?3, notes = ?4, agent_id = ?5, task_id = ?6, due = ?7, reminder_id = ?8, \
                     done = ?9, done_by = ?10, position = ?11, updated = ?12 WHERE id = ?1",
                    rusqlite::params![t.id, t.list_id, t.title, t.notes, t.agent_id, t.task_id, t.due, t.reminder_id, t.done, t.done_by, t.position, ts],
                )
                .ok()?;
                t.id
            } else {
                let position: i64 = conn
                    .query_row("SELECT COALESCE(MAX(position), -1) + 1 FROM todos WHERE list_id = ?1", [t.list_id], |r| r.get(0))
                    .ok()?;
                conn.execute(
                    "INSERT INTO todos (list_id, title, notes, agent_id, task_id, due, reminder_id, done, done_by, added_by, position, created, updated) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
                    rusqlite::params![t.list_id, t.title, t.notes, t.agent_id, t.task_id, t.due, t.reminder_id, t.done, t.done_by, t.added_by, position, ts],
                )
                .ok()?;
                conn.last_insert_rowid()
            }
        };
        self.todo(id)
    }

    pub fn delete_todo(&self, id: i64) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM todos WHERE id = ?1", [id]);
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
        let dir = std::env::temp_dir().join(format!("stark-todos-{}-{}", std::process::id(), crate::ledger::now_ms()));
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
}
