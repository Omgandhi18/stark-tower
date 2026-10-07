// How a to-do stands (from the task it started, and its agent), and how lists are read.
import type { StateTone } from "../../lib/status";
import type { Task, Todo, TodoList } from "../../lib/types";

/** What assigning an agent does, as a list's `start_mode`. */
export type StartMode = "manual" | "now" | "when_free";

export const START_MODES: ReadonlyArray<{ value: StartMode; label: string; hint: string }> = [
  { value: "manual", label: "Wait for Start", hint: "Assigning sets who'll do it. Nothing runs until you press Start." },
  { value: "now", label: "Start right away", hint: "Assigning an agent starts the work at once, in their chat for the project." },
  { value: "when_free", label: "Start when they're free", hint: "Each agent picks up its next to-do here when it has nothing running." },
];

export interface TodoState {
  /** What to show beside it; "" for a to-do nobody's on. */
  label: string;
  tone: StateTone;
  /** An agent's working on it now. */
  running: boolean;
  /** Start (again) hands it to its agent. */
  canStart: boolean;
}

interface StateInput {
  todo: Todo;
  /** The task it started, if it did. */
  task: Task | undefined;
  list: TodoList | undefined;
  agentName: string;
  /** Its task's agent is waiting on you for it. */
  waitingOnYou: boolean;
}

/** How a to-do stands: done, its task's state while an agent's on it, or who'll do it. */
export function todoState({ todo, task, list, agentName, waitingOnYou }: StateInput): TodoState {
  const state = (label: string, tone: StateTone, running = false, canStart = false): TodoState => ({ label, tone, running, canStart });
  if (todo.done !== null) return state("Done", "success");
  if (task) {
    if (waitingOnYou) return state("Waiting on you", "attention", true);
    switch (task.status) {
      case "doing":
      case "todo":
        return state(`${agentName} is on it`, "running", true);
      case "done":
        return state("Ready for review", "review");
      case "idle":
        return state("Finished, nothing to review", "idle");
      case "blocked":
        return state("Blocked", "danger", false, true);
      case "closed":
        return state("Closed", "idle", false, true);
      default:
        return state("Reviewed", "success");
    }
  }
  if (!todo.agent_id) return state("", "idle");
  if (list?.start_mode === "when_free") return state(`Waiting for ${agentName}`, "idle", false, true);
  return state(`For ${agentName}`, "idle", false, true);
}

/** A list's to-dos: open ones in your order, then done ones, latest first. */
export function splitTodos(todos: readonly Todo[]): { open: Todo[]; done: Todo[] } {
  const open = todos.filter((t) => t.done === null).sort((a, b) => a.position - b.position || a.id - b.id);
  const done = todos.filter((t) => t.done !== null).sort((a, b) => (b.done ?? 0) - (a.done ?? 0));
  return { open, done };
}

const trimmed = (path: string) => path.replace(/\/+$/, "");

/** The lists tied to a project (or anything inside it). */
export const listsFor = (lists: readonly TodoList[], project: string) =>
  lists.filter((l) => l.project !== "" && (trimmed(l.project) === trimmed(project) || trimmed(l.project).startsWith(`${trimmed(project)}/`)));

/** How many to-dos are still open on each list. */
export function openCounts(todos: readonly Todo[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const t of todos) if (t.done === null) counts.set(t.list_id, (counts.get(t.list_id) ?? 0) + 1);
  return counts;
}

/** Overdue: open, with a due time that's passed. */
export const overdue = (todo: Todo, now: number) => todo.done === null && todo.due !== null && todo.due < now;

/** Who did something to a to-do, as it reads: "you", or the agent's name. */
export const byWhom = (who: string | null, nameOf: (id: string) => string) => (who === null || who === "you" ? "you" : nameOf(who));
