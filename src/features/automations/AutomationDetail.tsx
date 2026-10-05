import type { ReactNode } from "react";
import { AlarmClockOff, Bell, CalendarClock, FolderOpen, ListChecks, MoonStar, Pencil, Play, ShieldCheck, Timer, Trash2, type LucideIcon } from "lucide-react";
import { OverflowMenu, Portrait, StatusPill, Toggle, ICON_SIZE, ICON_STROKE } from "../../design";
import type { Agent, Automation } from "../../lib/types";
import { folderName } from "../../stores/workspace";
import { automationHealth, describeMissed, describeNotify, describeSchedule, formatMinutes } from "./automationModel";

interface AutomationDetailProps {
  automation: Automation;
  agent: Agent | undefined;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onRunNow: () => void;
  onDelete: () => void;
  running: boolean;
}

function Fact({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="automation-fact">
      <dt>
        <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

/** One automation: who owns it, where it runs, what it does and the limits it runs within. */
export default function AutomationDetail({ automation: a, agent, onToggle, onEdit, onRunNow, onDelete, running }: AutomationDetailProps) {
  const health = automationHealth(a);
  const owner = agent?.name ?? a.agent_id;
  return (
    <article className="automation-detail" aria-labelledby="automation-detail-name">
      <header className="automation-detail-head">
        <StatusPill label={health.label} tone={health.tone} icon={health.icon} live={health.tone === "running"} />
        <div className="automation-detail-controls">
          <Toggle label="Enabled" checked={a.enabled} onChange={onToggle} />
          <OverflowMenu
            label={`More actions for ${a.name}`}
            items={[
              { id: "edit", label: "Edit", icon: Pencil, onSelect: onEdit },
              { id: "run", label: "Run now", icon: Play, onSelect: onRunNow, disabled: running },
              { id: "delete", label: "Delete", icon: Trash2, onSelect: onDelete, danger: true },
            ]}
          />
        </div>
      </header>

      <div className="automation-identity">
        <Portrait name={owner} figure={agent?.figure} accent={agent?.accent} size={64} />
        <div className="automation-identity-text">
          <h1 id="automation-detail-name" className="automation-name">
            {a.name}
          </h1>
          <dl className="automation-ownership">
            <div>
              <dt>Owned by</dt>
              <dd>
                <span className="automation-owner-name">{owner}</span>
                {agent?.role && <span className="automation-owner-role">{agent.role}</span>}
              </dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd title={a.cwd}>
                <FolderOpen aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
                {folderName(a.cwd)}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <dl className="automation-facts">
        <Fact icon={CalendarClock} label="Schedule">
          {describeSchedule(a.schedule)}
        </Fact>
        <Fact icon={ListChecks} label="Each run">
          <span className="automation-instruction selectable">{a.instruction}</span>
        </Fact>
        <Fact icon={ShieldCheck} label="Permissions">
          {owner}'s usual approvals. Anything risky waits for you in Notifications.
        </Fact>
        <Fact icon={Timer} label="Time limit">
          Stopped after {formatMinutes(a.max_minutes)}
        </Fact>
        <Fact icon={Bell} label="Tell me">
          {describeNotify(a.notify)}
        </Fact>
        <Fact icon={AlarmClockOff} label="Missed runs">
          {describeMissed(a.missed)}
        </Fact>
      </dl>

      <section className="automation-wake" aria-label="Waking the Mac">
        <MoonStar aria-hidden size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} className="automation-wake-icon" />
        <div className="automation-wake-text">
          <Toggle label="Wake this Mac to run" checked={false} disabled onChange={() => undefined} />
          <p className="automation-wake-note">
            Waking a sleeping Mac needs a signed system helper that this build of Starkline doesn't include yet. Until then, a run that comes due while the Mac
            sleeps counts as missed, and the missed-run setting above decides what happens. While the Mac is awake, runs start on time, even with the window
            closed.
          </p>
        </div>
      </section>
    </article>
  );
}
