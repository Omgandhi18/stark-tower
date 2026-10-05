// Task cards as moments in the room. When one agent hands work to another, the
// one asking walks over to brief them; when handed work is finished, whoever did
// it walks back to report; when work the developer asked for is finished, its
// agent hands it in at the room's review spot. Only changes count: what is on
// the board the first time the room looks is history, not news.
import { askedByDeveloper } from "../../lib/requester";
import type { Agent, Task } from "../../lib/types";
import type { LifeEvent } from "./types";

/** Where a task stood when the room last looked: still to do or under way, or finished. */
export type TaskMark = "open" | "done";

const OPEN: readonly string[] = ["todo", "doing"];

export function lifeEvents(
  previous: ReadonlyMap<string, TaskMark> | null,
  tasks: readonly Task[],
  agents: readonly Pick<Agent, "id">[],
): { events: LifeEvent[]; marks: Map<string, TaskMark> } {
  const team = new Set(agents.map((a) => a.id));
  const marks = new Map<string, TaskMark>();
  const events: LifeEvent[] = [];
  for (const task of tasks) {
    const mark: TaskMark | null = OPEN.includes(task.status) ? "open" : task.status === "done" ? "done" : null;
    if (!mark) continue;
    marks.set(task.id, mark);
    if (!previous || previous.get(task.id) === mark) continue;
    const asker = task.requested_by;
    const delegated = !askedByDeveloper(asker) && team.has(asker) && asker !== task.assignee;
    if (mark === "open" && !previous.has(task.id) && delegated) events.push({ kind: "brief", from: asker, to: task.assignee });
    if (mark === "done") events.push(delegated ? { kind: "report", from: task.assignee, to: asker } : { kind: "deliver", from: task.assignee });
  }
  return { events, marks };
}
