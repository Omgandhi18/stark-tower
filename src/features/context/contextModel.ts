import type { ContextSource } from "../../lib/types";

export const CONTEXT_GROUPS = [
  { id: 1, label: "Starkline and your rules" },
  { id: 2, label: "Project instructions" },
  { id: 3, label: "Agent identity and memory" },
  { id: 4, label: "This task and live state" },
] as const;

export function groupSources(sources: readonly ContextSource[]) {
  return CONTEXT_GROUPS.map((group) => ({ ...group, sources: sources.filter((s) => s.group === group.id) }));
}

export function contextSize(characters: number, tokens: number): string {
  return `${characters.toLocaleString()} characters · about ${tokens.toLocaleString()} tokens`;
}

export function totalSize(sources: readonly ContextSource[]) {
  const characters = sources.filter((s) => s.accepted && !s.conditional).reduce((sum, s) => sum + s.characters, 0);
  return contextSize(characters, Math.ceil(characters / 4));
}

export function emptyLabel(source: ContextSource): string {
  const filename = source.path?.split("/").pop();
  return `${filename || source.name} is empty`;
}
