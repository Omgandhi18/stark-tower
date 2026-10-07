// How the execution tree groups the work: one entry per person, however many of its tasks are theirs.
import type { StateTone } from "../../lib/status";
import type { Task } from "../../lib/types";

/** Someone's tasks in this work, in the order they were asked of them. */
export interface AgentWork {
  agentId: string;
  tasks: Task[];
}

/** Tasks by agent: someone asked for two things shows once, with both. Agents keep the order they were first asked in. */
export function byAgent(tasks: readonly Task[]): AgentWork[] {
  const groups: AgentWork[] = [];
  for (const task of tasks) {
    const group = groups.find((g) => g.agentId === task.assignee);
    if (group) group.tasks.push(task);
    else groups.push({ agentId: task.assignee, tasks: [task] });
  }
  return groups;
}

/** Most pressing first: what needs you, what's stuck, what's ready for you, then what's moving or done. */
const URGENCY: readonly StateTone[] = ["attention", "danger", "review", "running", "idle", "success"];

/** Several tasks' states as one line ("1 working · 2 ready for review"), most pressing first and toned by it. */
export function stateSummary(states: readonly { label: string; tone: StateTone }[]): { line: string; tone: StateTone } {
  const ordered = [...states].sort((a, b) => URGENCY.indexOf(a.tone) - URGENCY.indexOf(b.tone));
  const counts = new Map<string, number>();
  for (const state of ordered) counts.set(state.label, (counts.get(state.label) ?? 0) + 1);
  return {
    line: [...counts].map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · "),
    tone: ordered[0]?.tone ?? "idle",
  };
}
