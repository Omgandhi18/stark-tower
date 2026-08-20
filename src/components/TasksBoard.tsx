import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { Task } from "../lib/types";
import { getTasks, onTasksChanged } from "../lib/api";

/**
 * The durable task board — delegated work tracked across turns
 * (doing / blocked / done). Loads itself and refreshes on `tasks://changed`.
 */
export default function TasksBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const reload = () => {
      getTasks().then(setTasks).catch(() => {});
    };
    reload();
    const unsub = onTasksChanged(reload);
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  const active = tasks.filter(
    (t) => t.status === "doing" || t.status === "blocked",
  ).length;

  return (
    <div className={`ov ov-tasks glass ${open ? "open" : ""}`}>
      <button className="ov-roster-head" onClick={() => setOpen((o) => !o)}>
        <span className="label">Tasks</span>
        <span className="ov-roster-meta">
          <span className="label">{active} active</span>
          <span className="chev">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
      </button>
      {open && (
        <div className="tasks-list">
          {tasks.length === 0 && (
            <div className="tasks-empty">No delegated tasks yet.</div>
          )}
          {tasks.map((t) => (
            <div key={t.id} className={`task-row task-${t.status}`} title={t.detail ?? ""}>
              <span className={`task-dot task-dot-${t.status}`} />
              <span className="task-title">{t.title}</span>
              <span className="task-assignee">{t.assignee.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
