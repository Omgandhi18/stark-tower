// What marking a task reviewed can take with it: the delegated work that has finished.
import type { Task } from "../../lib/types";

/** Finished delegated work: with changes to review ("done"), or with an answer ("idle"). */
const FINISHED: readonly string[] = ["done", "idle"];
/** Delegated work that hasn't finished, and stays as it is. */
const UNFINISHED: readonly string[] = ["todo", "doing", "blocked"];

/** The delegated tasks that can be marked reviewed with their owner's, and how many are still going or stuck. */
export function delegatedToReview(children: readonly Task[]): { finished: Task[]; unfinished: number } {
  return {
    finished: children.filter((c) => FINISHED.includes(c.status)),
    unfinished: children.filter((c) => UNFINISHED.includes(c.status)).length,
  };
}

/** "1 finished delegated task" / "2 finished delegated tasks". */
export const finishedLabel = (count: number) => `${count} finished delegated ${count === 1 ? "task" : "tasks"}`;
