import type { SelectOption } from "../../design";
import type { ProjectInfo } from "../../lib/types";
import { folderName } from "../../stores/workspace";

/** Where a chat can run: every project, plus the chat's own folder if it isn't one. */
export function folderOptions(projects: readonly ProjectInfo[], current: string): SelectOption[] {
  const options = projects.map((p) => ({ value: p.path, label: p.name || folderName(p.path) }));
  if (current && !projects.some((p) => p.path === current)) {
    options.unshift({ value: current, label: folderName(current) });
  }
  return options.length ? options : [{ value: "", label: "No project folder yet", disabled: true }];
}
