import { useState } from "react";
import { ArrowUpRight, CalendarClock, Check, Play } from "lucide-react";
import { Button, IconButton, StatusPill, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";
import type { Todo, TodoList } from "../../lib/types";
import { useAgents } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import { formatWhen } from "../automations/automationModel";
import AgentPicker from "./AgentPicker";
import { startWork, toggleDone, updateTodo } from "./todoActions";
import { byWhom, overdue, todoState } from "./todoModel";

interface TodoRowProps {
  todo: Todo;
  list: TodoList | undefined;
  now: number;
  /** Open it in full; left out where a row can't be opened. */
  onSelect?: () => void;
  selected?: boolean;
  /** Name its list (where rows from several lists are shown together). */
  showList?: boolean;
}

/** One to-do: tick it off, see how it stands, choose who'll do it, and hand it over. */
export default function TodoRow({ todo, list, now, onSelect, selected = false, showList = false }: TodoRowProps) {
  const agents = useAgents((s) => s.agents);
  const task = useWorkspace((s) => (todo.task_id ? s.tasks.find((t) => t.id === todo.task_id) : undefined));
  const waitingOnYou = useAttention((s) => todo.task_id !== null && s.pending.some((r) => r.taskId === todo.task_id));
  const openTask = useNavigation((s) => s.openTask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const state = todoState({ todo, task, list, agentName: todo.agent_id ? nameOf(todo.agent_id) : "", waitingOnYou });
  const done = todo.done !== null;

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={cx("todo-row", done && "is-done", selected && "is-selected")} aria-label={todo.title}>
      <label className="todo-check">
        <input
          type="checkbox"
          checked={done}
          disabled={busy}
          aria-label={done ? `Mark “${todo.title}” not done` : `Tick off “${todo.title}”`}
          onChange={() => void run(() => toggleDone(todo), "That to-do couldn't be changed.")}
        />
        <span className="todo-check-box" aria-hidden>
          {done && <Check size={ICON_SIZE.sm} strokeWidth={2.5} />}
        </span>
      </label>
      <div className="todo-main">
        {onSelect ? (
          <button type="button" className="todo-title" aria-pressed={selected} onClick={onSelect}>
            {todo.title}
          </button>
        ) : (
          <span className="todo-title">{todo.title}</span>
        )}
        <span className="todo-meta">
          {showList && list && <Tag>{list.name}</Tag>}
          {todo.due !== null && !done && (
            <span className={cx("todo-due", overdue(todo, now) && "is-overdue")}>
              <CalendarClock aria-hidden size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
              {overdue(todo, now) ? `Overdue, ${formatWhen(todo.due, now)}` : formatWhen(todo.due, now)}
            </span>
          )}
          {todo.notes && <span className="todo-has-notes">Notes</span>}
          {todo.added_by !== "you" && <span>Added by {nameOf(todo.added_by)}</span>}
          {done && <span>Ticked off by {byWhom(todo.done_by, nameOf)}</span>}
        </span>
        {error && (
          <span className="todo-error" role="alert">
            {error}
          </span>
        )}
      </div>
      {state.label && !done && <StatusPill label={state.label} tone={state.tone} live={state.running} className="todo-state" />}
      {!done && (
        <AgentPicker
          value={todo.agent_id}
          label={`Who'll do “${todo.title}”`}
          disabled={busy || state.running}
          onChange={(agent) => void run(() => updateTodo(todo, { agent_id: agent }), "That to-do couldn't be assigned.")}
          className="todo-agent"
        />
      )}
      {!done && state.canStart && todo.agent_id && (
        <Button size="sm" icon={Play} disabled={busy} onClick={() => void run(() => startWork(todo), "That to-do couldn't be started.")}>
          {task ? "Start again" : "Start"}
        </Button>
      )}
      {task && <IconButton icon={ArrowUpRight} size="sm" label={`Open the work on “${todo.title}”`} onClick={() => openTask(task.id)} />}
    </li>
  );
}
