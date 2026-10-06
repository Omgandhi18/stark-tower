import type { SelectOption } from "../../design";
import type { ProjectInfo, Worktree } from "../../lib/types";
import { folderName } from "../../stores/workspace";

/** Where a chat can run: every project, plus the chat's own folder if it isn't one. */
export function folderOptions(projects: readonly ProjectInfo[], current: string, worktrees: readonly Worktree[] = []): SelectOption[] {
  const options = projects.map((p) => ({ value: p.path, label: p.name || folderName(p.path) }));
  for (const w of worktrees.filter((w) => w.removed === null)) options.push({ value: w.path, label: `${folderName(w.project)} · ${w.branch}` });
  if (current && !options.some((p) => p.value === current)) {
    options.unshift({ value: current, label: folderName(current) });
  }
  return options.length ? options : [{ value: "", label: "No project folder yet", disabled: true }];
}
