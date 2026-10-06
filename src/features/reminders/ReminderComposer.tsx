import { useState, type FormEvent } from "react";
import { AlarmClockPlus } from "lucide-react";
import { Button, SelectField, cx } from "../../design";
import { saveReminder } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Agent, Reminder } from "../../lib/types";
import { formatWhen } from "../automations/automationModel";
import { REPEAT_OPTIONS, fromLocalInput, repeatFor, repeatKind, toLocalInput, whenChoices, type RepeatKind } from "./reminderModel";

interface ReminderComposerProps {
  agents: readonly Agent[];
  /** A reminder being changed; null to set a new one. */
  editing: Reminder | null;
  onSaved: (reminder: Reminder) => void;
  onCancel: () => void;
  now: number;
}

/** When the new reminder goes off: one of the quick times, or a date and time of your own. */
type When = { kind: "choice"; id: string } | { kind: "custom"; value: string };

const DEFAULT_CHOICE = "1h";

/** What to be reminded of, when, how often, and which agent does the reminding. */
export default function ReminderComposer({ agents, editing, onSaved, onCancel, now }: ReminderComposerProps) {
  const [text, setText] = useState(editing?.text ?? "");
  const [when, setWhen] = useState<When>(editing ? { kind: "custom", value: toLocalInput(editing.due) } : { kind: "choice", id: DEFAULT_CHOICE });
  const [repeat, setRepeat] = useState<RepeatKind>(repeatKind(editing?.repeat ?? null));
  const [agentId, setAgentId] = useState(editing?.agent_id ?? agents[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const choices = whenChoices(now);
  const at = when.kind === "custom" ? fromLocalInput(when.value) : (choices.find((c) => c.id === when.id)?.at ?? null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (at === null) {
      setError("Pick a date and time.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = await saveReminder({ id: editing?.id ?? null, text, agent_id: agentId, task_id: editing?.task_id ?? null, due: at, repeat: repeatFor(repeat, at) });
      onSaved(saved);
      if (!editing) {
        setText("");
        setWhen({ kind: "choice", id: DEFAULT_CHOICE });
        setRepeat("never");
      }
    } catch (err) {
      setError(errorMessage(err, "The reminder couldn't be saved."));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={cx("reminder-composer", editing && "is-editing")} onSubmit={submit} aria-label={editing ? "Change the reminder" : "New reminder"}>
      <input
        className="reminder-composer-text"
        value={text}
        placeholder="Remind me to…"
        aria-label="What to remind you of"
        maxLength={300}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="reminder-when" role="radiogroup" aria-label="When">
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={when.kind === "choice" && when.id === c.id}
            className="reminder-when-choice"
            onClick={() => setWhen({ kind: "choice", id: c.id })}
          >
            {c.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={when.kind === "custom"}
          className="reminder-when-choice"
          onClick={() => setWhen({ kind: "custom", value: toLocalInput(at ?? now + 60 * 60_000) })}
        >
          Pick a time
        </button>
        {when.kind === "custom" && (
          <input
            type="datetime-local"
            className="input reminder-when-input"
            aria-label="Date and time"
            value={when.value}
            onChange={(e) => setWhen({ kind: "custom", value: e.target.value })}
          />
        )}
      </div>
      <div className="reminder-composer-row">
        <SelectField label="Repeat" value={repeat} options={REPEAT_OPTIONS} onChange={(v) => setRepeat(v as RepeatKind)} />
        <SelectField label="Who reminds you" value={agentId} options={agents.map((a) => ({ value: a.id, label: a.name }))} onChange={setAgentId} />
        <span className="reminder-composer-at" aria-live="polite">
          {at === null ? "Pick a date and time" : repeat === "never" ? formatWhen(at, now) : `From ${formatWhen(at, now)}`}
        </span>
        <div className="reminder-composer-actions">
          {editing && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" icon={AlarmClockPlus} disabled={saving || !text.trim()}>
            {editing ? "Save changes" : "Set reminder"}
          </Button>
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
