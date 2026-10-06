import { useMemo, useState } from "react";
import { AlarmClock, Check, Plus, Repeat } from "lucide-react";
import { portraitKey, Button, IconButton, Portrait, SectionHeader, ICON_SIZE, ICON_STROKE } from "../../design";
import { completeReminder, snoozeReminder } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import { useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { useNotifications } from "../../stores/notifications";
import { useReminders } from "../../stores/reminders";
import { formatWhen } from "../automations/automationModel";
import { groupReminders } from "./reminderModel";
import SnoozeButton from "./SnoozeButton";
import "./reminders.css";

/** How many coming reminders the rail lists; the rest are on Reminders. */
const SHOWN = 4;

/** The rail's reminders: any that went off (with Done and Snooze), then the next few coming up. */
export default function UpcomingReminders({ now }: { now: number }) {
  const items = useReminders((s) => s.items);
  const notifications = useNotifications((s) => s.items);
  const agents = useAgents((s) => s.agents);
  const navigate = useNavigation((s) => s.navigate);
  const [error, setError] = useState<string | null>(null);

  const open = useMemo(
    () => new Set(notifications.filter((n) => n.reminder_id !== null && n.handled === null).map((n) => n.reminder_id as number)),
    [notifications],
  );
  const { due, coming } = groupReminders(items, open);
  const shown = coming.slice(0, SHOWN);
  const more = coming.length - shown.length;
  const agentOf = (id: string) => agents.find((a) => a.id === id);

  const act = (action: () => Promise<unknown>, failure: string) => {
    setError(null);
    action().catch((e) => setError(errorMessage(e, failure)));
  };

  return (
    <section className="rail-reminders" aria-label="Upcoming reminders">
      <SectionHeader
        title="Reminders"
        icon={AlarmClock}
        count={due.length + coming.length}
        actions={<IconButton icon={Plus} label="Set a reminder" size="sm" onClick={() => navigate("reminders")} />}
      />
      {due.length + coming.length === 0 ? (
        <p className="rail-reminders-empty">
          Nothing coming up.{" "}
          <button type="button" className="rail-reminders-link" onClick={() => navigate("reminders")}>
            Set a reminder
          </button>
        </p>
      ) : (
        <ul className="rail-reminder-list">
          {due.map((r) => {
            const agent = agentOf(r.agent_id);
            const name = agent?.name ?? r.agent_id;
            return (
              <li key={r.id} className="rail-reminder is-due">
                <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={24} />
                <div className="rail-reminder-main">
                  <span className="rail-reminder-text">{r.text}</span>
                  <span className="rail-reminder-when">
                    {name} reminded you {formatRelative(r.fired ?? now, now)}
                  </span>
                  <div className="rail-reminder-actions">
                    <Button size="sm" variant="primary" icon={Check} onClick={() => act(() => completeReminder(r.id), "The reminder couldn't be marked done.")}>
                      Done
                    </Button>
                    <SnoozeButton label={`Snooze “${r.text}”`} onSnooze={(until) => act(() => snoozeReminder(r.id, until), "The reminder couldn't be snoozed.")} />
                  </div>
                </div>
              </li>
            );
          })}
          {shown.map((r) => {
            const agent = agentOf(r.agent_id);
            const name = agent?.name ?? r.agent_id;
            return (
              <li key={r.id} className="rail-reminder">
                <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={24} />
                <div className="rail-reminder-main">
                  <span className="rail-reminder-text">{r.text}</span>
                  <span className="rail-reminder-when">
                    {r.repeat && <Repeat aria-label="Repeats" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />}
                    {formatWhen(r.due, now)} · {name}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {more > 0 && (
        <Button size="sm" variant="ghost" className="rail-reminders-more" onClick={() => navigate("reminders")}>
          {more} more on Reminders
        </Button>
      )}
    </section>
  );
}
