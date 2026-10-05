// What an agent may do in a project: Starkline's policy, tier by tier, with the
// rules the developer granted that let some of it through without asking.
// Agents can't loosen any of it.
import type { PermissionRule, PolicyRule } from "../../lib/types";
import { inProject } from "../work/projects";

export type PolicyTier = "automatic" | "approval" | "never";

export interface EffectivePermission {
  label: string;
  tier: PolicyTier;
  /** Standing rules that let some of these calls through in this project. */
  grants: PermissionRule[];
}

export interface PermissionGroup {
  tier: PolicyTier;
  title: string;
  items: EffectivePermission[];
}

const TIER_TITLES: Record<PolicyTier, string> = {
  automatic: "Runs on its own",
  approval: "Asks you first",
  never: "Never on its own",
};

const TIERS: readonly PolicyTier[] = ["automatic", "approval", "never"];

const asTier = (tier: string): PolicyTier => (TIERS.includes(tier as PolicyTier) ? (tier as PolicyTier) : "approval");

/** A standing rule that applies to every task in `project` (task-only rules don't). */
export const appliesInProject = (rule: PermissionRule, project: string) =>
  rule.revoked === null && (rule.scope === "everywhere" || (rule.scope === "project" && rule.project !== null && inProject(project, rule.project)));

export function effectivePermissions(policy: readonly PolicyRule[], rules: readonly PermissionRule[], project: string): PermissionGroup[] {
  const items: EffectivePermission[] = policy.map((p) => ({
    label: p.label,
    tier: asTier(p.tier),
    grants: rules.filter((r) => r.rule === p.label && appliesInProject(r, project)),
  }));
  return TIERS.map((tier) => ({ tier, title: TIER_TITLES[tier], items: items.filter((i) => i.tier === tier) }));
}
