import { useCallback, useEffect, useState } from "react";
import { CircleAlert, CircleCheck, OctagonX, ShieldOff, type LucideIcon } from "lucide-react";
import { Button, EmptyState, InlineCode, Tag, Toggle, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { listPermissionRules, onRulesChanged, revokePermissionRule } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import type { PermissionRule } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { folderName, useWorkspace } from "../../stores/workspace";

const CLOCK_MS = 60_000;

const DEFAULTS: ReadonlyArray<{ title: string; tone: string; icon: LucideIcon; items: string }> = [
  {
    title: "Runs on its own",
    tone: "success",
    icon: CircleCheck,
    items: "Reading and searching the project, editing its files, running its own build, lint, type-check and test commands, and temporary files.",
  },
  {
    title: "Asks you first",
    tone: "attention",
    icon: CircleAlert,
    items:
      "Installing or updating packages, creating or switching branches, files outside the project, database migrations, services others can reach, credentials, the network, and commands Starkline doesn't recognise.",
  },
  {
    title: "Never on its own",
    tone: "danger",
    icon: OctagonX,
    items:
      "Committing, pushing, deploying or publishing, deleting branches or worktrees, discarding, resetting, cleaning or stashing changes, acting on other machines, destructive commands, and changing Starkline's own safeguards.",
  },
];

function scopeText(rule: PermissionRule, taskTitle: string | undefined): string {
  if (rule.scope === "task") return taskTitle ? `For the task "${taskTitle}"` : "For one task";
  if (rule.scope === "project") return rule.project ? `In ${folderName(rule.project)}` : "In one project";
  return "In every project";
}

/** What agents may do on their own, and the exceptions the developer granted. */
export default function PermissionsSettings() {
  const tasks = useWorkspace((s) => s.tasks);
  const [rules, setRules] = useState<PermissionRule[] | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(CLOCK_MS);

  const load = useCallback(() => {
    listPermissionRules(true)
      .then(setRules)
      .catch((e) => setError(errorMessage(e, "The rules couldn't be loaded.")));
  }, []);

  useEffect(() => {
    load();
    const off = onRulesChanged(load);
    return () => {
      off.then((stop) => stop()).catch(() => undefined);
    };
  }, [load]);

  const revoke = (id: number) => {
    setError(null);
    revokePermissionRule(id)
      .then(load)
      .catch((e) => setError(errorMessage(e, "The rule couldn't be revoked.")));
  };

  const active = (rules ?? []).filter((r) => r.revoked === null);
  const revoked = (rules ?? []).filter((r) => r.revoked !== null);
  const shown = showRevoked ? [...active, ...revoked] : active;

  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">Permissions</h1>
        <p className="screen-subtitle">What agents can do on their own, and the exceptions you've allowed. Agents can't change any of this.</p>
      </header>

      <section className="settings-card">
        <h2 className="settings-card-title">Defaults</h2>
        <ul className="policy-tiers">
          {DEFAULTS.map(({ title, tone, icon: Icon, items }) => (
            <li key={title} className={cx("policy-tier", `tone-${tone}`)}>
              <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="policy-tier-icon" />
              <span className="policy-tier-text">
                <span className="policy-tier-title">{title}</span>
                <span className="policy-tier-items">{items}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="settings-card">
        <div className="settings-card-head">
          <h2 className="settings-card-title">Rules you've allowed</h2>
          {revoked.length > 0 && <Toggle label="Show revoked" checked={showRevoked} onChange={setShowRevoked} className="rules-toggle" />}
        </div>
        {rules && shown.length === 0 ? (
          <EmptyState
            compact
            icon={ShieldOff}
            title="No exceptions yet"
            body="When you choose Allow for this task or Always allow on a request, the rule shows up here."
          />
        ) : (
          <ul className="rule-list">
            {shown.map((rule) => (
              <li key={rule.id} className={cx("rule-row", rule.revoked !== null && "is-revoked")}>
                <span className="rule-text">
                  <span className="rule-title">
                    <InlineCode text={`Allow ${rule.display}`} />
                  </span>
                  <span className="rule-scope">{scopeText(rule, tasks.find((t) => t.id === rule.task_id)?.title)}</span>
                  <span className="rule-meta">
                    Instead of: {rule.rule}. Added {formatRelative(rule.created, now)}
                    {rule.uses > 0
                      ? `, used ${rule.uses === 1 ? "once" : `${rule.uses} times`}${rule.last_used ? `, last ${formatRelative(rule.last_used, now)}` : ""}`
                      : ", not used yet"}
                    .
                  </span>
                </span>
                {rule.tier === "never" && <Tag tone="danger">Normally never</Tag>}
                {rule.revoked === null ? (
                  <Button size="sm" variant="ghost" className="settings-remove" onClick={() => revoke(rule.id)}>
                    Revoke
                  </Button>
                ) : (
                  <Tag>{`Revoked ${formatRelative(rule.revoked, now)}`}</Tag>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
