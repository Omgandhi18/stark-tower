import { useEffect, useState } from "react";
import { Lock, ShieldCheck } from "lucide-react";
import { Button, InlineCode, SkeletonRows, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { listPermissionRules, onRulesChanged, permissionPolicy } from "../../lib/api";
import type { PermissionRule } from "../../lib/types";
import { useOnce } from "../../lib/useOnce";
import { useNavigation } from "../../stores/navigation";
import { folderName, useWorkspace } from "../../stores/workspace";
import { effectivePermissions, type PolicyTier } from "./permissionsModel";

const TONES: Record<PolicyTier, string> = { automatic: "tone-success", approval: "tone-attention", never: "tone-danger" };

/** What an agent may do in the current project, and which of your rules loosen it. */
export default function AgentPermissions({ name }: { name: string }) {
  const policy = useOnce("permission-policy", permissionPolicy);
  const project = useWorkspace((s) => s.activeProject);
  const openSettings = useNavigation((s) => s.openSettings);
  const [rules, setRules] = useState<PermissionRule[] | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      listPermissionRules(false).then(
        (r) => live && setRules(r),
        () => live && setRules([]),
      );
    load();
    const off = onRulesChanged(load);
    return () => {
      live = false;
      void off.then((stop) => stop()).catch(() => undefined);
    };
  }, []);

  if (!policy || !rules) return <SkeletonRows rows={4} label="Loading permissions" />;
  const groups = effectivePermissions(policy, rules, project);
  const where = project ? folderName(project) : "this project";

  return (
    <div className="agent-permissions">
      <p className="agent-permissions-intro">
        What {name} may do in {where}. One policy covers every agent on every provider, and rules you grant let more through without asking.
      </p>
      <div className="permission-groups">
        {groups.map((group) => (
          <section key={group.tier} className={cx("permission-group", TONES[group.tier])} aria-labelledby={`perm-${group.tier}`}>
            <h3 id={`perm-${group.tier}`} className="permission-group-title">
              <span className="permission-group-dot" aria-hidden />
              {group.title}
            </h3>
            <ul className="permission-items">
              {group.items.map((item) => (
                <li key={item.label} className="permission-item">
                  <span className="permission-label">{item.label}</span>
                  {item.grants.length > 0 ? (
                    <span className="permission-grants">
                      {item.grants.map((g) => (
                        <span key={g.id} className="permission-grant">
                          <ShieldCheck aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                          <InlineCode text={`Allowed: ${g.display}${g.scope === "everywhere" ? ", everywhere" : ""}`} />
                        </span>
                      ))}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="agent-permissions-foot">
        <Lock aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        Rules come from your approvals ("Always allow") and can be taken back.
        <Button size="sm" variant="ghost" onClick={() => openSettings("permissions")}>
          Review rules
        </Button>
      </p>
    </div>
  );
}
