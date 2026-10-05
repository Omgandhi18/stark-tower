/** The folder a project lives in, shown under its name ("~/Documents"). */
export function parentFolder(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  parts.pop();
  const parent = parts.join("/") || "/";
  return parent.replace(/^\/Users\/[^/]+/, "~");
}

/** Whether `cwd` is inside the project folder (or no filter is set). */
const trimSlashes = (path: string) => path.replace(/\/+$/, "");

export function inProject(cwd: string | null | undefined, project: string | null): boolean {
  if (!project) return true;
  if (!cwd) return false;
  const folder = trimSlashes(project);
  const at = trimSlashes(cwd);
  return at === folder || at.startsWith(`${folder}/`);
}
