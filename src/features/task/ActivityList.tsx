import { History } from "lucide-react";
import { EmptyState, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { formatRelative } from "../../lib/time";
import type { Agent, TaskEvent } from "../../lib/types";
import { checkPassed, eventIcon } from "./taskPresentation";

/** Everything that happened in the task, newest first. */
export default function ActivityList({ events, agents, now }: { events: readonly TaskEvent[]; agents: readonly Agent[]; now: number }) {
  if (events.length === 0) {
    return <EmptyState icon={History} title="Nothing has happened yet" body="Files changed, commands run and checks appear here as the work goes on." />;
  }
  const nameOf = (id: string) => (id === "you" ? "You" : (agents.find((a) => a.id === id)?.name ?? id));
  return (
    <ol className="activity-list">
      {[...events].reverse().map((e) => {
        const Icon = eventIcon(e);
        const passed = checkPassed(e);
        return (
          <li key={e.id} className={cx("activity-item", passed === true && "tone-success", passed === false && "tone-danger")}>
            <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="activity-icon" />
            <span className="activity-summary selectable">{e.summary}</span>
            <span className="activity-meta">
              {nameOf(e.agent_id)}, {formatRelative(e.ts, now)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
