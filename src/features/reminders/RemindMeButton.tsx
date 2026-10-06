import { useState } from "react";
import { AlarmClockPlus } from "lucide-react";
import { Button, Popover } from "../../design";
import { saveReminder } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Task } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useReminders } from "../../stores/reminders";
import { fromLocalInput, toLocalInput, whenChoices } from "./reminderModel";
import "./reminders.css";

const HOUR = 60 * 60_000;
const CLOCK_MS = 30_000;

function RemindMePanel({ task, ownerName, close }: { task: Task; ownerName: string; close: () => void }) {
  const apply = useReminders((s) => s.apply);
  const [text, setText] = useState(`Check on “${task.title}”`);
  const now = useNow(CLOCK_MS);
  const [custom, setCustom] = useState(() => toLocalInput(now + HOUR));
  const [error, setError] = useState<string | null>(null);

  const remind = (at: number | null) => {
    if (at === null) return;
    setError(null);
    saveReminder({ id: null, text, agent_id: task.assignee, task_id: task.id, due: at, repeat: null })
      .then((saved) => {
        apply(saved);
        close();
      })
      .catch((e) => setError(errorMessage(e, "The reminder couldn't be set.")));
  };

  return (
    <div className="remind-me">
      <input className="input" aria-label="What to remind you of" value={text} onChange={(e) => setText(e.target.value)} />
      <p className="remind-me-note">{ownerName} reminds you:</p>
      <div className="snooze-choices" role="group" aria-label="When">
        {whenChoices(now).map((c) => (
          <button key={c.id} type="button" className="menu-item" onClick={() => remind(whenChoices(Date.now()).find((w) => w.id === c.id)?.at ?? c.at)}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="remind-me-custom">
        <input type="datetime-local" className="input" aria-label="Date and time" value={custom} onChange={(e) => setCustom(e.target.value)} />
        <Button size="sm" onClick={() => remind(fromLocalInput(custom))}>
          Set
        </Button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** "Remind me" on a task: its owner reminds you to come back to it. */
export default function RemindMeButton({ task, ownerName }: { task: Task; ownerName: string }) {
  return (
    <Popover
      label={`Remind me about “${task.title}”`}
      align="end"
      className="remind-me-popover"
      trigger={(p) => (
        <Button {...p} icon={AlarmClockPlus} aria-haspopup="dialog">
          Remind me
        </Button>
      )}
    >
      {(close) => <RemindMePanel task={task} ownerName={ownerName} close={close} />}
    </Popover>
  );
}
