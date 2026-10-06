import { useMemo, useState } from "react";
import { AlarmClock } from "lucide-react";
import { EmptyState } from "../../design";
import { completeReminder, deleteReminder, snoozeReminder } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Reminder } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { useNotifications } from "../../stores/notifications";
import { useReminders } from "../../stores/reminders";
import { useWorkspace } from "../../stores/workspace";
import ReminderComposer from "./ReminderComposer";
import ReminderRow from "./ReminderRow";
import { groupReminders } from "./reminderModel";
import "./reminders.css";

const CLOCK_MS = 30_000;
const DONE_SHOWN = 20;

/** Reminders: set one, see what went off and what's coming, and deal with each. */
export default function RemindersScreen() {
  const items = useReminders((s) => s.items);
  const loaded = useReminders((s) => s.loaded);
  const apply = useReminders((s) => s.apply);
  const notifications = useNotifications((s) => s.items);
  const agents = useAgents((s) => s.agents);
  const tasks = useWorkspace((s) => s.tasks);
  const openTask = useNavigation((s) => s.openTask);
  const [editing, setEditing] = useState<Reminder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(CLOCK_MS);

  const open = useMemo(
    () => new Set(notifications.filter((n) => n.reminder_id !== null && n.handled === null).map((n) => n.reminder_id as number)),
    [notifications],
  );
  const groups = groupReminders(items, open);

  const act = (action: () => Promise<unknown>, failure: string) => {
    setError(null);
    action().catch((e) => setError(errorMessage(e, failure)));
  };

  const section = (title: string, list: Reminder[], due: boolean) => (
    <section className="reminder-section" aria-label={title}>
      <h2 className="reminder-section-title">{title}</h2>
      <ul className="reminder-list">
        {list.map((r) => (
          <ReminderRow
            key={r.id}
            reminder={r}
            agent={agents.find((a) => a.id === r.agent_id)}
            task={r.task_id ? tasks.find((t) => t.id === r.task_id) : undefined}
            due={due}
            now={now}
            onDone={() => act(() => completeReminder(r.id), "The reminder couldn't be marked done.")}
            onSnooze={(until) => act(() => snoozeReminder(r.id, until), "The reminder couldn't be snoozed.")}
            onEdit={() => setEditing(r)}
            onDelete={() => act(() => deleteReminder(r.id), "The reminder couldn't be deleted.")}
            onOpenTask={openTask}
          />
        ))}
      </ul>
    </section>
  );

  return (
    <div className="reminders-screen">
      <div className="reminders-page">
        <header className="screen-header">
          <h1 className="screen-title">Reminders</h1>
          <p className="screen-subtitle">
            Set a reminder and the agent you pick reminds you when it's time. You can also ask any agent in chat: “remind me at 5 to check the deploy.”
          </p>
        </header>

        <ReminderComposer
          key={editing?.id ?? "new"}
          agents={agents}
          editing={editing}
          now={now}
          onSaved={(saved) => {
            apply(saved);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        {groups.due.length > 0 && section("Due now", groups.due, true)}
        {groups.coming.length > 0
          ? section("Coming up", groups.coming, false)
          : loaded && (
              <EmptyState
                compact
                icon={AlarmClock}
                title="Nothing coming up"
                body="Set a reminder above, or on a task with “Remind me”."
              />
            )}
        {groups.done.length > 0 && (
          <details className="reminder-done">
            <summary>Done ({groups.done.length})</summary>
            {section("Done", groups.done.slice(0, DONE_SHOWN), false)}
          </details>
        )}
      </div>
    </div>
  );
}
