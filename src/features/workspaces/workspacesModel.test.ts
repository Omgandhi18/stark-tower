import { expect, it } from "vitest";
import type { Worktree } from "../../lib/types";
import { projectFolder } from "./workspacesModel";

it("maps live and removed worktrees to their project without matching a sibling path", () => {
  const tree: Worktree = { path: "/home/dev/.starkline/worktrees/app/fix", project: "/w/app", branch: "starkline/fix", base: "main", base_commit: "abc", task_id: "task", created: 0, removed: null };
  expect(projectFolder(`${tree.path}/src`, [tree])).toBe("/w/app");
  expect(projectFolder(tree.path, [{ ...tree, removed: 1 }])).toBe("/w/app");
  expect(projectFolder(`${tree.path}-other/src`, [tree])).toBe(`${tree.path}-other/src`);
  expect(projectFolder("/w/site", [tree])).toBe("/w/site");
});
