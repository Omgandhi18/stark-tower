import { useState } from "react";
import { AlarmClock, CalendarClock, Check, CheckCheck, Play, RotateCcw, SkipForward, SquareArrowOutUpRight, X } from "lucide-react";
import { Button, InlineCode, Portrait, StatusPill } from "../../design";
import { closeTask, completeReminder, resumeTask, reviewTask, runAutomationNow, skipMissedRun, snoozeReminder, startTask } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import type { Agent, Notification } from "../../lib/types";
import { useAutomations } from "../../stores/automations";
import { useNavigation } from "../../stores/navigation";
import { folderName, useWorkspace } from "../../stores/workspace";
import SnoozeButton from "../reminders/SnoozeButton";
import { presentKind } from "./notificationModel";

interface NotificationSummaryProps {
  notification: Notification;
  agent: Agent | undefined;
  now: number;
}

/** A notification with nothing left to decide: what happened, and where to go from here. */
export default function NotificationSummary({ notification: n, agent, now }: NotificationSummaryProps) {
  const openSettings = useNavigation((s) => s.openSettings);
  const openTask = useNavigation((s) => s.openTask);
  const openAutomation = useNavigation((s) => s.openAutomation);
  const navigate = useNavigation((s) => s.navigate);
  const task = useWorkspace((s) => s.tasks.find((t) => t.id === n.task_id));
  const automation = useAutomations((s) => s.items.find((a) => a.id === n.automation_id));
  const [error, setError] = useState<string | null>(null);
  const kind = presentKind(n.kind);
  const name = agent?.name ?? n.agent_id;
  const open = n.handled === null;

  const run = (action: () => Promise<unknown>, failure: string) => {
    setError(null);
    action().catch((e) => setError(errorMessage(e, failure)));
  };

  return (
    <article className={`notification-detail tone-${kind.tone}`} aria-labelledby={`notification-${n.id}`}>
      <header className="notification-detail-head">
        <StatusPill label={kind.label} tone={kind.tone} icon={kind.icon} />
        <time>{formatRelative(n.ts, now)}</time>
      </header>
      <h1 id={`notification-${n.id}`} className="notification-detail-title">
        <InlineCode text={n.title} />
      </h1>
      {n.body && (
        <p className="notification-detail-body selectable">
          <InlineCode text={n.body} />
        </p>
      )}
      <dl className="notification-facts">
        <div>
          <dt>From</dt>
          <dd>
            <Portrait name={name} figure={agent?.figure} accent={agent?.accent} size={24} />
            {name}
          </dd>
        </div>
        {n.cwd && (
          <div>
            <dt>Project</dt>
            <dd title={n.cwd}>{folderName(n.cwd)}</dd>
          </div>
        )}
        {automation && (
          <div>
            <dt>Automation</dt>
            <dd>
              <button type="button" className="link-button" onClick={() => openAutomation(automation.id)}>
                {automation.name}
              </button>
            </dd>
          </div>
        )}
        {task && (
          <div>
            <dt>Task</dt>
            <dd>
              <button type="button" className="link-button" onClick={() => openTask(task.id)}>
                {task.title}
              </button>
            </dd>
          </div>
        )}
        {n.outcome && (
          <div>
            <dt>Outcome</dt>
            <dd>
              {n.outcome}
              {n.handled !== null && <span className="notification-when">, {formatRelative(n.handled, now)}</span>}
            </dd>
          </div>
        )}
      </dl>
      {error && (
        <p className="review-detail-error" role="alert">
          {error}
        </p>
      )}
      {n.kind === "budget" && (
        <div className="notification-actions">
          <Button onClick={() => openSettings("spend")}>Review budget</Button>
        </div>
      )}
      {n.reminder_id !== null && (
        <div className="notification-actions">
          {open && (
            <>
              <Button variant="primary" icon={Check} onClick={() => run(() => completeReminder(n.reminder_id as number), "The reminder couldn't be marked done.")}>
                Done
              </Button>
              <SnoozeButton
                size="md"
                label={`Snooze “${n.title}”`}
                onSnooze={(until) => run(() => snoozeReminder(n.reminder_id as number, until), "The reminder couldn't be snoozed.")}
              />
            </>
          )}
          <Button variant="ghost" icon={AlarmClock} onClick={() => navigate("reminders")}>
            Open Reminders
          </Button>
        </div>
      )}
      {automation && (
        <div className="notification-actions">
          {open && (
            <Button variant="primary" icon={Play} onClick={() => run(() => runAutomationNow(automation.id), "The run couldn't start.")}>
              Run it now
            </Button>
          )}
          {open && n.kind === "automation_missed" && (
            <Button icon={SkipForward} onClick={() => run(() => skipMissedRun(automation.id), "The missed run couldn't be skipped.")}>
              Skip this run
            </Button>
          )}
          <Button variant={open ? "ghost" : "secondary"} icon={CalendarClock} onClick={() => openAutomation(automation.id)}>
            Open automation
          </Button>
        </div>
      )}
      {task && (
        <div className="notification-actions">
          <Button variant={open && n.kind === "task_ready" ? "review" : "secondary"} icon={SquareArrowOutUpRight} onClick={() => openTask(task.id)}>
            {n.kind === "task_ready" ? "Review the task" : "Open the task"}
          </Button>
          {open && n.kind === "task_blocked" && task.status === "blocked" && task.conversation_id !== null && !task.parent_id && (
            <Button icon={Play} onClick={() => run(() => resumeTask(task.id), "The task couldn't continue.")}>
              Continue
            </Button>
          )}
          {open && n.kind === "task_blocked" && (
            <Button
              icon={RotateCcw}
              onClick={() => run(() => startTask(task.assignee, task.prompt || task.title, task.cwd || undefined), "The task couldn't be started again.")}
            >
              Start over
            </Button>
          )}
          {task.status === "done" ? (
            <Button variant="ghost" icon={CheckCheck} onClick={() => run(() => reviewTask(task.id), "The task couldn't be marked reviewed.")}>
              Mark as reviewed
            </Button>
          ) : (
            open &&
            !["closed", "reviewed"].includes(task.status) && (
              <Button variant="ghost" icon={X} onClick={() => run(() => closeTask(task.id), "The task couldn't be closed.")}>
                Close task
              </Button>
            )
          )}
        </div>
      )}
    </article>
  );
}
