// How a task's parts read on screen: event icons, plan steps, file changes and diffs.
import {
  CircleCheck,
  CircleDot,
  CirclePlay,
  Clock,
  FileLock,
  FilePen,
  Forward,
  Hourglass,
  ListChecks,
  ShieldAlert,
  SquareTerminal,
  TriangleAlert,
  UserRoundPlus,
  type LucideIcon,
} from "lucide-react";
import type { FileChange, PlanItem, Task, TaskEvent } from "../../lib/types";

const EVENT_ICON: Record<string, LucideIcon> = {
  created: CircleDot,
  queued: Hourglass,
  started: CirclePlay,
  delegated: Forward,
  file: FilePen,
  command: SquareTerminal,
  verification: CircleCheck,
  plan: ListChecks,
  helper: UserRoundPlus,
  approval: ShieldAlert,
  status: Clock,
  claim_needed: FileLock,
  claim_refused: TriangleAlert,
  claim_overlap: TriangleAlert,
};

export const eventIcon = (event: Pick<TaskEvent, "kind">): LucideIcon => EVENT_ICON[event.kind] ?? CircleDot;

/** A clash with another agent over a file: refused before an edit, or found after one. */
const CONFLICTS: readonly string[] = ["claim_refused", "claim_overlap"];

/** Work that's over: a conflict that came up in it needs no one now. */
const SETTLED: readonly Task["status"][] = ["idle", "reviewed", "closed"];

/** What the agent was told, from before refusals were worded for people: steps it took itself, not clashes. */
const AGENT_INSTRUCTION = /Call claim_files|runs git here/;

/**
 * The conflict to show under someone in the execution tree: their latest clash with another agent
 * over a file, until their part of the work is over. Routine steps (claiming a shared file first,
 * leaving git to the owner) stay in the task's activity.
 */
export function openConflict(events: readonly Pick<TaskEvent, "agent_id" | "kind" | "summary">[], agentId: string, status: Task["status"]): string | undefined {
  if (SETTLED.includes(status)) return undefined;
  const latest = events.filter((e) => e.agent_id === agentId && CONFLICTS.includes(e.kind)).slice(-1)[0];
  return latest && !AGENT_INSTRUCTION.test(latest.summary) ? latest.summary : undefined;
}

/** A verification event's outcome, read from its data. */
export function checkPassed(event: Pick<TaskEvent, "kind" | "data">): boolean | null {
  if (event.kind !== "verification") return null;
  try {
    return Boolean((JSON.parse(event.data) as { passed?: boolean }).passed);
  } catch {
    return null;
  }
}

export type StepState = "done" | "doing" | "todo";

export function stepState(item: PlanItem): StepState {
  if (item.status === "completed") return "done";
  if (item.status === "in_progress") return "doing";
  return "todo";
}

/** The label to show for a plan step: what's happening now reads as it happens. */
export const stepLabel = (item: PlanItem) => (item.status === "in_progress" && item.active ? item.active : item.content);

const CHANGE_LETTER: Record<string, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" };

export const changeLetter = (change: Pick<FileChange, "status">) => CHANGE_LETTER[change.status] ?? "M";

export function changeSummary(changes: readonly FileChange[]) {
  const count = (statuses: readonly string[]) => changes.filter((c) => statuses.includes(c.status)).length;
  return {
    added: count(["added", "untracked"]),
    modified: count(["modified", "renamed"]),
    deleted: count(["deleted"]),
    linesAdded: changes.reduce((sum, c) => sum + (c.added ?? 0), 0),
    linesRemoved: changes.reduce((sum, c) => sum + (c.removed ?? 0), 0),
  };
}

export type DiffLineKind = "meta" | "hunk" | "add" | "remove" | "context";

/** Classify each line of a unified diff for display. */
export function diffLines(diff: string): Array<{ kind: DiffLineKind; text: string }> {
  return diff.split("\n").map((text) => {
    if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename (from|to)|Binary files)/.test(text)) {
      return { kind: "meta", text };
    }
    if (text.startsWith("@@")) return { kind: "hunk", text };
    if (text.startsWith("+")) return { kind: "add", text };
    if (text.startsWith("-")) return { kind: "remove", text };
    return { kind: "context", text };
  });
}

/** Files each agent touched in the task, from the task's history. */
export function filesByAgent(events: readonly TaskEvent[]): Record<string, number> {
  const seen: Record<string, Set<string>> = {};
  for (const e of events) {
    if (e.kind !== "file") continue;
    let path = e.summary;
    try {
      path = (JSON.parse(e.data) as { path?: string }).path ?? path;
    } catch {
      // Older events carry only the summary.
    }
    (seen[e.agent_id] ??= new Set()).add(path);
  }
  return Object.fromEntries(Object.entries(seen).map(([agent, paths]) => [agent, paths.size]));
}

export interface Helper {
  description: string;
  kind: string;
  at: number;
}

/** Temporary helpers (subagents) the owner started. */
export function helpersOf(events: readonly TaskEvent[]): Helper[] {
  return events
    .filter((e) => e.kind === "helper")
    .map((e) => {
      try {
        const data = JSON.parse(e.data) as { description?: string; type?: string };
        return { description: data.description || e.summary, kind: data.type ?? "", at: e.ts };
      } catch {
        return { description: e.summary, kind: "", at: e.ts };
      }
    });
}
