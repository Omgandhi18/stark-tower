import { useState } from "react";
import { ArrowUpRight, Play, Trash2, X } from "lucide-react";
import { Button, Dialog, IconButton, SelectField, StatusPill, TextArea, TextField } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import type { Todo, TodoList } from "../../lib/types";
import { useAgents } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import { fromLocalInput, toLocalInput } from "../reminders/reminderModel";
import AgentPicker from "./AgentPicker";
import { removeTodo, startWork, toggleDone, updateTodo } from "./todoActions";
import { byWhom, deleteWarning, todoState } from "./todoModel";

interface TodoDetailProps {
  todo: Todo;
  lists: readonly TodoList[];
  now: number;
  onClose: () => void;
}

/** One to-do in full: its words and notes, who'll do it and by when, which list, and its work. */
export default function TodoDetail({ todo, lists, now, onClose }: TodoDetailProps) {
  const agents = useAgents((s) => s.agents);
  const task = useWorkspace((s) => (todo.task_id ? s.tasks.find((t) => t.id === todo.task_id) : undefined));
  const waitingOnYou = useAttention((s) => todo.task_id !== null && s.pending.some((r) => r.taskId === todo.task_id));
  const openTask = useNavigation((s) => s.openTask);
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const list = lists.find((l) => l.id === todo.list_id);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const state = todoState({ todo, task, list, agentName: todo.agent_id ? nameOf(todo.agent_id) : "", waitingOnYou });
  const done = todo.done !== null;
  const warning = deleteWarning(state, nameOf(task?.assignee ?? todo.agent_id ?? ""));

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
  const remove = () =>
    run(async () => {
      await removeTodo(todo.id);
      onClose();
    }, "That to-do couldn't be deleted.");
  const save = (change: Parameters<typeof updateTodo>[1]) => run(() => updateTodo(todo, change), "That change couldn't be saved.");

  return (
    <aside className="todo-detail" aria-label="To-do">
      <header className="todo-detail-head">
        <span className="todo-detail-kicker">To-do #{todo.number}</span>
        <IconButton icon={X} size="sm" label="Close" onClick={onClose} />
      </header>
      <TextField
        label="What needs doing"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => title.trim() && title !== todo.title && void save({ title })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      <TextArea
        label="Notes"
        value={notes}
        placeholder="Anything you, or the agent who does it, should know"
        onChange={(e) => setNotes(e.target.value)}
        onBlur={() => notes !== todo.notes && void save({ notes })}
      />
      <div className="todo-detail-row">
        <AgentPicker label="Who'll do it" hideLabel={false} value={todo.agent_id} disabled={busy || done || state.running} onChange={(agent) => void save({ agent_id: agent })} />
        <SelectField
          label="List"
          value={String(todo.list_id)}
          options={lists.map((l) => ({ value: String(l.id), label: l.name }))}
          disabled={busy}
          onChange={(id) => void save({ list_id: Number(id) })}
        />
      </div>
      <div className="todo-detail-due">
        <TextField
          label="Due"
          type="datetime-local"
          value={todo.due === null ? "" : toLocalInput(todo.due)}
          helper={todo.due === null ? "You're reminded when it's due." : undefined}
          onChange={(e) => {
            const at = fromLocalInput(e.target.value);
            if (at !== null || e.target.value === "") void save({ due: at });
          }}
        />
        {todo.due !== null && (
          <Button size="sm" variant="ghost" onClick={() => void save({ due: null })}>
            Clear
          </Button>
        )}
      </div>

      <section className="todo-detail-work" aria-label="Its work">
        {state.label && <StatusPill label={state.label} tone={state.tone} live={state.running} />}
        <div className="todo-detail-actions">
          {!done && state.canStart && todo.agent_id && (
            <Button icon={Play} variant="primary" disabled={busy} onClick={() => void run(() => startWork(todo), "That to-do couldn't be started.")}>
              {task ? "Start again" : `Start with ${nameOf(todo.agent_id)}`}
            </Button>
          )}
          {task && (
            <Button icon={ArrowUpRight} onClick={() => openTask(task.id)}>
              Open its work
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => toggleDone(todo), "That to-do couldn't be changed.")}>
            {done ? "Mark not done" : "Tick it off"}
          </Button>
        </div>
        {!todo.agent_id && !done && <p className="todo-detail-hint">Choose who'll do it to hand it to an agent.</p>}
      </section>

      {error && (
        <p className="todo-error" role="alert">
          {error}
        </p>
      )}
      <footer className="todo-detail-foot">
        <span>
          Added by {byWhom(todo.added_by, nameOf)} {formatRelative(todo.created, now)}
          {done && `, ticked off by ${byWhom(todo.done_by, nameOf)} ${formatRelative(todo.done ?? now, now)}`}
        </span>
        <Button size="sm" variant="ghost" icon={Trash2} disabled={busy} onClick={() => (warning ? setConfirmingDelete(true) : void remove())}>
          Delete
        </Button>
      </footer>
      <Dialog
        open={confirmingDelete}
        onClose={() => setConfirmingDelete(false)}
        icon={Trash2}
        tone="danger"
        title={warning ?? "Delete this to-do?"}
        description="If you delete it, they'll be told it was removed when they try to tick it off."
        actions={
          <>
            <Button variant="ghost" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmingDelete(false);
                void remove();
              }}
            >
              Delete anyway
            </Button>
          </>
        }
      />
    </aside>
  );
}
