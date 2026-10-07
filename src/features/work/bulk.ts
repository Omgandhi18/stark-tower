// Acting on many tasks at once from Work: which rows can be picked, which of them
// an action applies to, and how much of a section is picked.
import type { Task } from "../../lib/types";
import type { Board, TaskRow } from "./board";

export type BulkAction = "review" | "close";

export type SelectionState = "none" | "some" | "all";

/** Only finished work can be marked reviewed. */
export const canReview = (task: Task) => task.status === "done";

/** The tasks an action applies to: closing takes them all, marking reviewed only the finished ones. */
export const bulkTargets = (action: BulkAction, tasks: readonly Task[]): Task[] => (action === "review" ? tasks.filter(canReview) : [...tasks]);

/** Rows that can be picked: work that's waiting, finished or stuck. Running work is stopped one at a time. */
export const selectableRows = (board: Board): TaskRow[] => [...board.queued, ...board.ready, ...board.blocked, ...board.answered];

/** How much of a group is picked, for its select-all box. */
export function selectionState(ids: readonly string[], selected: ReadonlySet<string>): SelectionState {
  const picked = ids.filter((id) => selected.has(id)).length;
  if (picked === 0) return "none";
  return picked === ids.length ? "all" : "some";
}

/** Closing work that hasn't started cancels it, as each row's own menu says. */
export const closeVerb = (tasks: readonly Task[]) => (tasks.length > 0 && tasks.every((t) => t.status === "todo") ? "Cancel" : "Close");

/** "1 task", "3 tasks". */
export const taskCount = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;
