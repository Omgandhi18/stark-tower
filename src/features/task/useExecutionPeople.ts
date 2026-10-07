// Everyone working on a task, as the execution tree and its collapsed rail both show them.
import type { StateTone } from "../../lib/status";
import type { Agent, Task, TaskDetail } from "../../lib/types";
import { useActivity } from "../../stores/activity";
import { useAgents } from "../../stores/agents";
import { taskState } from "../work/board";
import { byAgent, stateSummary } from "./executionModel";
import { filesByAgent, helpersOf, openConflict, type Helper } from "./taskPresentation";

/** One of someone's tasks, listed under them when they have more than one in this work. */
export interface PersonTask {
  id: string;
  title: string;
  state: string;
  tone: StateTone;
  /** The task this page shows. */
  current: boolean;
}

export interface ExecutionPerson {
  agentId: string;
  agent: Agent | undefined;
  role: "Asked by" | "Owner" | "Delegated";
  line: string;
  tone: StateTone;
  /** Files they changed in this task; left out for someone who isn't working on it. */
  files?: number;
  claims: string[];
  /** A clash with another agent over a file, while it still matters. */
  conflict?: string;
  /** The owner, whose task this page shows. */
  current: boolean;
  /** The one task that opens from them, if there's just one. */
  opens: string | null;
  /** Their tasks in this work. */
  tasks: PersonTask[];
}

/**
 * The owner, teammates it delegated to, and temporary helpers. Each person shows once, with their
 * tasks when they have more than one. A delegated task starts with the task it came from.
 */
export function useExecutionPeople(detail: TaskDetail, waitingOnYou: ReadonlySet<string>): { people: ExecutionPerson[]; helpers: Helper[] } {
  const agents = useAgents((s) => s.agents);
  const latest = useActivity((s) => s.latest);
  const { task, parent, siblings, children, events } = detail;
  const files = filesByAgent(events);
  const claimsFor = (id: string) => detail.claims.filter((c) => c.agent_id === id).map((c) => `${c.path || "Whole workspace"} (${c.reason})`);
  const find = (id: string) => agents.find((a) => a.id === id);
  const owner = find(task.assignee);
  const ownerState = taskState(task, owner, children, waitingOnYou);
  const ownerLine = task.status === "doing" && latest[task.assignee] ? latest[task.assignee].summary : ownerState.label;
  // All the owner was asked to do in the same work, this task among them.
  const ownerTasks = [task, ...siblings.filter((s) => s.assignee === task.assignee)].sort((a, b) => a.ts - b.ts);

  const stateOf = (other: Task) => taskState(other, find(other.assignee), [], waitingOnYou);
  const summaryOf = (other: Task) => {
    const state = stateOf(other);
    return { line: `${state.label}: ${other.title}`, tone: state.tone };
  };
  const listed = (other: Task): PersonTask => {
    const state = stateOf(other);
    return { id: other.id, title: other.title, state: state.label, tone: state.tone, current: other.id === task.id };
  };

  const people: ExecutionPerson[] = [];
  if (parent) {
    people.push({
      agentId: parent.assignee,
      agent: find(parent.assignee),
      role: "Asked by",
      ...summaryOf(parent),
      claims: [],
      current: false,
      opens: parent.id,
      tasks: [],
    });
  }
  people.push({
    agentId: task.assignee,
    agent: owner,
    role: "Owner",
    line: ownerLine,
    tone: ownerState.tone,
    files: files[task.assignee] ?? 0,
    claims: claimsFor(task.assignee),
    conflict: openConflict(events, task.assignee, [task]),
    current: true,
    opens: null,
    tasks: ownerTasks.map(listed),
  });
  for (const { agentId, tasks } of byAgent(children)) {
    const only = tasks.length === 1 ? tasks[0] : null;
    people.push({
      agentId,
      agent: find(agentId),
      role: "Delegated",
      ...(only ? summaryOf(only) : stateSummary(tasks.map(stateOf))),
      files: files[agentId] ?? 0,
      claims: claimsFor(agentId),
      conflict: openConflict(events, agentId, tasks),
      current: false,
      opens: only?.id ?? null,
      tasks: tasks.map(listed),
    });
  }
  return { people, helpers: helpersOf(events) };
}
