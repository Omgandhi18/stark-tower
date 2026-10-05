import { History, Pause, Play, SquareArrowOutUpRight } from "lucide-react";
import { Button, EmptyState, SkeletonRows, StatusPill, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { formatElapsed, formatRelative } from "../../lib/time";
import type { Automation, AutomationRun, PowerState } from "../../lib/types";
import { automationHealth, formatStamp, formatWhen, presentRun, presentTrigger, runDuration } from "./automationModel";

interface AutomationRailProps {
  automation: Automation;
  /** Undefined while they load. */
  runs: AutomationRun[] | undefined;
  power: PowerState | null;
  now: number;
  onOpenTask: (taskId: string) => void;
  onOpenPower: () => void;
  onRunNow: () => void;
  onToggle: (enabled: boolean) => void;
  busy: boolean;
}

const SHOWN_RUNS = 8;

/** When it runs and how it has gone: the schedule, recent runs, and what can be done about them. */
export default function AutomationRail({ automation: a, runs, power, now, onOpenTask, onOpenPower, onRunNow, onToggle, busy }: AutomationRailProps) {
  const health = automationHealth(a);
  const running = runs?.some((r) => r.finished === null) ?? a.last_status === "running";
  const latestTask = runs?.find((r) => r.task_id !== null)?.task_id ?? null;
  const shown = runs?.slice(0, SHOWN_RUNS);

  return (
    <aside className="automation-rail" aria-label={`${a.name}: schedule and runs`}>
      <section className="automation-panel" aria-labelledby="automation-health-title">
        <header className="automation-panel-head">
          <h2 id="automation-health-title" className="automation-panel-title">
            Schedule and health
          </h2>
          <StatusPill label={health.label} tone={health.tone} icon={health.icon} live={health.tone === "running"} />
        </header>
        <dl className="automation-health">
          <div>
            <dt>Next run</dt>
            <dd>{a.enabled && a.next_run !== null ? formatWhen(a.next_run, now) : "Paused"}</dd>
          </div>
          <div>
            <dt>Last run</dt>
            <dd>
              {a.last_run !== null
                ? `${formatRelative(a.last_run, now)}${a.last_status ? `, ${presentRun(a.last_status).label.toLowerCase()}` : ""}`
                : "Not yet"}
            </dd>
          </div>
          <div>
            <dt>Keep awake</dt>
            <dd>
              <button type="button" className="link-button" onClick={onOpenPower}>
                {power?.enabled ? "On while agents work" : "Off"}
              </button>
            </dd>
          </div>
          <div>
            <dt>Wake from sleep</dt>
            <dd className="automation-health-muted">Not in this build</dd>
          </div>
        </dl>
      </section>

      <section className="automation-panel automation-runs-panel" aria-labelledby="automation-runs-title">
        <header className="automation-panel-head">
          <h2 id="automation-runs-title" className="automation-panel-title">
            Recent runs
          </h2>
          {runs && runs.length > SHOWN_RUNS && (
            <span className="automation-panel-count">
              Latest {SHOWN_RUNS} of {runs.length}
            </span>
          )}
        </header>
        {!shown ? (
          <SkeletonRows rows={3} label="Loading runs" />
        ) : shown.length === 0 ? (
          <EmptyState compact icon={History} title="No runs yet" body="Each run lands here with how it went. Run it now to see one." />
        ) : (
          <ol className="automation-runs">
            {shown.map((r) => {
              const p = presentRun(r.status);
              const Icon = p.icon;
              const took = runDuration(r);
              const trigger = presentTrigger(r.trigger);
              const body = (
                <>
                  <Icon
                    aria-hidden
                    size={ICON_SIZE.md}
                    strokeWidth={ICON_STROKE}
                    className={cx("automation-run-icon", `tone-${p.tone}`, r.status === "running" && "spin-slow")}
                  />
                  <span className="automation-run-text">
                    <span className="automation-run-when">
                      {formatStamp(r.scheduled_for)}
                      {trigger && <span className="automation-run-trigger">{trigger}</span>}
                    </span>
                    <span className={cx("automation-run-status", `tone-${p.tone}`)}>{p.label}</span>
                    {r.summary && <span className="automation-run-summary">{r.summary}</span>}
                  </span>
                  <span className="automation-run-took">
                    {took !== null ? formatElapsed(took) : r.status === "running" && r.started !== null ? formatElapsed(now - r.started) : ""}
                  </span>
                </>
              );
              return (
                <li key={r.id}>
                  {r.task_id ? (
                    <button
                      type="button"
                      className="automation-run"
                      onClick={() => onOpenTask(r.task_id as string)}
                      aria-label={`${formatStamp(r.scheduled_for)}, ${p.label.toLowerCase()}. Open its task`}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="automation-run">{body}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <footer className="automation-rail-actions">
        <Button icon={SquareArrowOutUpRight} disabled={!latestTask} onClick={() => latestTask && onOpenTask(latestTask)}>
          Open task
        </Button>
        <Button icon={Play} disabled={busy || running} onClick={onRunNow}>
          {running ? "Running" : "Run now"}
        </Button>
        <Button variant={a.enabled ? "secondary" : "primary"} icon={a.enabled ? Pause : Play} onClick={() => onToggle(!a.enabled)}>
          {a.enabled ? "Pause" : "Resume"}
        </Button>
      </footer>
    </aside>
  );
}
