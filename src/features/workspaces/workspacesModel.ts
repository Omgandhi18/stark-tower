import type { Worktree } from "../../lib/types";

/** Keep project identity for worktree folders, including chats in removed worktrees. */
export function projectFolder(cwd: string, worktrees: readonly Worktree[]): string {
  const tree = worktrees.filter((w) => cwd === w.path || cwd.startsWith(`${w.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
  return tree?.project ?? cwd;
}
