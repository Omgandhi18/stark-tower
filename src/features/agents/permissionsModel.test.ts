import { describe, expect, it } from "vitest";
import type { PermissionRule, PolicyRule } from "../../lib/types";
import { effectivePermissions } from "./permissionsModel";

const policy: PolicyRule[] = [
  { label: "Work inside the project", tier: "automatic" },
  { label: "Install or update dependencies", tier: "approval" },
  { label: "Commit, push, deploy or publish", tier: "never" },
];

const rule = (over: Partial<PermissionRule>): PermissionRule => ({
  id: 1,
  created: 0,
  scope: "project",
  task_id: null,
  project: "/w/app",
  tool: "Bash",
  pattern: "npm install",
  display: "`npm install` commands",
  rule: "Install or update dependencies",
  tier: "approval",
  uses: 0,
  last_used: null,
  revoked: null,
  ...over,
});

describe("effective permissions", () => {
  it("groups the policy by tier", () => {
    const groups = effectivePermissions(policy, [], "/w/app");
    expect(groups.map((g) => [g.title, g.items.map((i) => i.label)])).toEqual([
      ["Runs on its own", ["Work inside the project"]],
      ["Asks you first", ["Install or update dependencies"]],
      ["Never on its own", ["Commit, push, deploy or publish"]],
    ]);
  });

  it("shows the standing rules that apply in this project only", () => {
    const rules = [
      rule({ id: 1 }),
      rule({ id: 2, project: "/w/other" }),
      rule({ id: 3, scope: "everywhere", project: null, display: "`pnpm add` commands" }),
      rule({ id: 4, scope: "task", task_id: "t1", project: null }),
      rule({ id: 5, revoked: 10 }),
    ];
    const deps = effectivePermissions(policy, rules, "/w/app/packages/web")[1].items[0];
    expect(deps.grants.map((g) => g.id)).toEqual([1, 3]);
  });
});
