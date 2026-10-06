import { Check, Pencil, Repeat, SquareArrowOutUpRight, Trash2 } from "lucide-react";
import { Button, OverflowMenu, Portrait, ICON_SIZE, ICON_STROKE, type MenuItem } from "../../design";
import type { Agent, Reminder, Task } from "../../lib/types";
import { formatRelative } from "../../lib/time";
import { describeWhen } from "./reminderModel";
import SnoozeButton from "./SnoozeButton";

interface ReminderRowProps {
  reminder: Reminder;
  agent: Agent | undefined;
  task: Task | undefined;
  /** Went off and waiting on the developer. */
  due: boolean;
  now: number;
  onDone: () => void;
  onSnooze: (until: number) => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
}

/** One reminder: what, when, who reminds you, and what you can do with it. */
export default function ReminderRow({ reminder: r, agent, task, due, now, onDone, onSnooze, onEdit, onDelete, onOpenTask }: ReminderRowProps) {
  const name = agent?.name ?? r.agent_id;
  const when = due
    ? `${name} reminded you ${formatRelative(r.fired ?? now, now)}`
    : r.status === "done"
      ? `Done ${formatRelative(r.updated, now)}`
      : `${describeWhen(r, now)} · ${name} reminds you`;
  const items: MenuItem[] = [
    ...(r.status !== "done" ? [{ id: "edit", label: "Change", icon: Pencil, onSelect: onEdit }] : []),
    { id: "delete", label: "Delete", icon: Trash2, danger: true, onSelect: onDelete },
  ];

  return (
    <li className="reminder-row">
      <Portrait name={name} figure={agent?.figure} accent={agent?.accent} size={32} />
      <div className="reminder-row-main">
        <span className="reminder-row-text">{r.text}</span>
        <span className="reminder-row-meta">
          {r.repeat && <Repeat aria-label="Repeats" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />}
          {when}
          {r.set_by !== "you" && r.set_by === r.agent_id && <span> · set in chat</span>}
        </span>
        {task && (
          <button type="button" className="reminder-row-task" onClick={() => onOpenTask(task.id)}>
            <SquareArrowOutUpRight aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            {task.title}
          </button>
        )}
      </div>
      <div className="reminder-row-actions">
        {due && (
          <>
            <Button size="sm" variant="primary" icon={Check} onClick={onDone}>
              Done
            </Button>
            <SnoozeButton label={`Snooze “${r.text}”`} onSnooze={onSnooze} />
          </>
        )}
        <OverflowMenu items={items} label={`More for “${r.text}”`} />
      </div>
    </li>
  );
}
