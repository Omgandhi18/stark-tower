import { AlarmClockOff, ChevronDown } from "lucide-react";
import { Button, Popover } from "../../design";
import { snoozeChoices } from "./reminderModel";
import "./reminders.css";

interface SnoozeButtonProps {
  /** Names what's being snoozed ("Snooze “Check the deploy”"). */
  label: string;
  onSnooze: (until: number) => void;
  size?: "sm" | "md";
}

const SNOOZE_LABELS = snoozeChoices(0).map(({ id, label }) => ({ id, label }));

/** "Snooze" with a choice of how long: 10 minutes, an hour, or tomorrow morning. */
export default function SnoozeButton({ label, onSnooze, size = "sm" }: SnoozeButtonProps) {
  return (
    <Popover
      label={label}
      align="end"
      className="snooze-popover"
      trigger={(p) => (
        <Button {...p} size={size} icon={AlarmClockOff} trailingIcon={ChevronDown} aria-haspopup="dialog">
          Snooze
        </Button>
      )}
    >
      {(close) => (
        <div className="snooze-choices" role="group" aria-label="Remind me again in">
          {SNOOZE_LABELS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="menu-item"
              onClick={() => {
                close();
                // Counted from the click, not from when the list opened.
                const at = snoozeChoices(Date.now()).find((s) => s.id === c.id)?.at;
                if (at !== undefined) onSnooze(at);
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}
