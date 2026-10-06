import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { portraitKey, Button, IconButton, Portrait, registerOverlay } from "../../design";
import { completeReminder, onReminderDue, snoozeReminder } from "../../lib/api";
import type { Reminder } from "../../lib/types";
import { useAgents } from "../../stores/agents";
import { useNotifications } from "../../stores/notifications";
import { useReminders } from "../../stores/reminders";
import SnoozeButton from "./SnoozeButton";
import "./reminders.css";

/** The newest few stay on screen; older ones are still in Notifications and on Reminders. */
const MAX_SHOWN = 3;

const report = (what: string) => (e: unknown) => console.error(`[reminders] couldn't ${what}`, e);

/**
 * A reminder that goes off while you're in Starkline pops up in the corner, from the
 * agent reminding you, until you deal with it or close it. (macOS shows the banner
 * when you're elsewhere.)
 */
export default function ReminderToasts() {
  const [shown, setShown] = useState<number[]>([]);
  const reminders = useReminders((s) => s.items);
  const notifications = useNotifications((s) => s.items);
  const agents = useAgents((s) => s.agents);

  useEffect(() => {
    const listening = onReminderDue(({ id }) => {
      setShown((ids) => [id, ...ids.filter((x) => x !== id)].slice(0, MAX_SHOWN));
      useReminders.getState().refresh().catch(report("load reminders"));
    });
    return () => {
      listening.then((stop) => stop()).catch(report("stop listening"));
    };
  }, []);

  // A toast goes once its reminder has been dealt with anywhere (here, Reminders, Notifications).
  const open = (id: number) => notifications.some((n) => n.reminder_id === id && n.handled === null) || reminders.some((r) => r.id === id && r.status === "due");
  const visible = shown.map((id) => reminders.find((r) => r.id === id)).filter((r): r is Reminder => r !== undefined && open(r.id));
  if (!visible.length) return null;

  const dismiss = (id: number) => setShown((ids) => ids.filter((x) => x !== id));

  return (
    <div ref={(el) => (el ? registerOverlay(el) : undefined)} className="reminder-toasts" role="region" aria-label="Reminders going off">
      {visible.map((r) => {
        const agent = agents.find((a) => a.id === r.agent_id);
        const name = agent?.name ?? r.agent_id;
        return (
          <div key={r.id} className="reminder-toast" role="alert">
            <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={40} />
            <div className="reminder-toast-main">
              <span className="reminder-toast-who">{name} reminds you</span>
              <span className="reminder-toast-text">{r.text}</span>
              <div className="reminder-toast-actions">
                <Button
                  size="sm"
                  variant="primary"
                  icon={Check}
                  onClick={() => {
                    dismiss(r.id);
                    completeReminder(r.id).catch(report("mark the reminder done"));
                  }}
                >
                  Done
                </Button>
                <SnoozeButton
                  label={`Snooze “${r.text}”`}
                  onSnooze={(until) => {
                    dismiss(r.id);
                    snoozeReminder(r.id, until).catch(report("snooze the reminder"));
                  }}
                />
              </div>
            </div>
            <IconButton icon={X} label="Close" size="sm" onClick={() => dismiss(r.id)} />
          </div>
        );
      })}
    </div>
  );
}
