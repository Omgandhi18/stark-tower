// What the Work board shows, derived from the stores: tasks by state (running,
// waiting their turn, ready for review, blocked, answered), agents busy in a
// plain chat, and the team.
import type { Activity } from "../../stores/activity";
import type { Agent, Conversation, ReviewRequest, Task } from "../../lib/types";
import { askedByDeveloper } from "../../lib/requester";
import { AGENT_STATUS, type StateTone } from "../../lib/status";
import { inProject } from "./projects";

export type WorkTab = "all" | "mine";
export type WorkSort = "recent" | "longest";

export interface TaskRow {
  task: Task;
  owner?: Agent;
  /** Agents the task delegated to, in the order they joined. */
  contributors: Agent[];
  /** The owner's own plan, when it keeps one. */
  progress?: { done: number; total: number };
  /** What the owner is doing right now (running tasks only). */
  activity?: Activity;
  /** When the task entered its current state. */
  since: number;
  state: { label: string; tone: StateTone };
}

/** An agent working in a plain chat rather than on a task. */
export interface ChatRow {
  agent: Agent;
  title: string;
  cwd: string;
  project?: string;
  activity?: Activity;
  since: number;
  state: { label: string; tone: StateTone };
}

export interface Board {
  running: TaskRow[];
  chats: ChatRow[];
  queued: TaskRow[];
  ready: TaskRow[];
  blocked: TaskRow[];
  /** Asked and answered in the last day, with nothing to review. */
  answered: TaskRow[];
  team: Agent[];
}

interface BoardInput {
  agents: readonly Agent[];
  since: Readonly<Record<string, number>>;
  tasks: readonly Task[];
  conversations: readonly Conversation[];
  latest: Readonly<Record<string, Activity>>;
  pending: readonly ReviewRequest[];
  project: string | null;
  tab?: WorkTab;
  sort?: WorkSort;
  /** Now, for how long answered work stays on the board. */
  now?: number;
}

const DEFAULT_CHAT_TITLE = "New chat";
const RUNNING: readonly string[] = ["doing"];
/** How long answered work stays on the board; it stays with its chat after that. */
export const ANSWERED_FOR_MS = 24 * 60 * 60 * 1000;

function newestFirst<T>(items: readonly T[], key: (item: T) => number): T[] {
  return [...items].sort((a, b) => key(b) - key(a));
}

/** Tasks the developer is finished with: they leave the board and stay in history. */
const SETTLED: readonly string[] = ["closed", "reviewed"];

/** Asked and answered lately, with nothing to review. A chat that was opened and left alone has nothing to show. */
const recentlyAnswered = (t: Task, now: number) => t.status === "idle" && Boolean(t.prompt.trim()) && now - (t.finished ?? t.updated) < ANSWERED_FOR_MS;

const onBoard = (t: Task, now: number) => !SETTLED.includes(t.status) && (t.status !== "idle" || recentlyAnswered(t, now));

/** Tasks shown on their own: top-level ones, and delegations whose parent isn't shown. */
function shownOnBoard(tasks: readonly Task[], now: number): Task[] {
  const shown = new Set(tasks.filter((t) => onBoard(t, now)).map((t) => t.id));
  return tasks.filter((t) => onBoard(t, now) && !(t.parent_id && shown.has(t.parent_id)));
}

export function buildBoard({ agents, since, tasks, conversations, latest, pending, project, tab = "all", sort = "recent", now = Date.now() }: BoardInput): Board {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const waitingOnYou = new Set(pending.map((r) => r.agentId));
  const childrenOf = (id: string) => tasks.filter((t) => t.parent_id === id);

  const rowFor = (task: Task): TaskRow => {
    const owner = byId.get(task.assignee);
    const children = childrenOf(task.id);
    const contributors = [...new Set(children.map((c) => c.assignee))]
      .filter((id) => id !== task.assignee)
      .map((id) => byId.get(id))
      .filter((a): a is Agent => Boolean(a));
    const progress = task.plan_total ? { done: task.plan_done ?? 0, total: task.plan_total } : undefined;
    const running = RUNNING.includes(task.status);
    const state = taskState(task, owner, children, waitingOnYou);
    return {
      task,
      owner,
      contributors,
      progress,
      activity: running ? latest[task.assignee] : undefined,
      since: running ? (task.started ?? task.ts) : (task.finished ?? task.updated),
      state,
    };
  };

  const visible = shownOnBoard(tasks, now).filter((t) => inProject(t.project_folder || t.cwd, project) && (tab === "all" || askedByDeveloper(t.requested_by)));
  const ordered = sort === "longest" ? [...visible].sort((a, b) => (a.started ?? a.ts) - (b.started ?? b.ts)) : newestFirst(visible, (t) => t.updated);
  const withStatus = (status: string) => ordered.filter((t) => t.status === status).map(rowFor);

  // Agents busy outside any running task are in a plain chat.
  const onTask = new Set(tasks.filter((t) => RUNNING.includes(t.status)).map((t) => t.assignee));
  const chatOf = (agentId: string) =>
    newestFirst(
      conversations.filter((c) => c.agent_id === agentId),
      (c) => c.updated,
    )[0];
  const chats: ChatRow[] = [];
  if (tab === "all") {
    for (const agent of agents) {
      const presentation = AGENT_STATUS[agent.status];
      if ((!presentation.busy && agent.status !== "blocked") || onTask.has(agent.id)) continue;
      const chat = chatOf(agent.id);
      const cwd = chat?.cwd ?? "";
      if (!inProject(chat?.project_folder || cwd, project)) continue;
      const titled = chat && chat.title.trim() && chat.title !== DEFAULT_CHAT_TITLE ? chat.title : undefined;
      chats.push({
        agent,
        title: titled ?? `Chat with ${agent.name}`,
        cwd,
        project: chat?.project_folder,
        activity: latest[agent.id],
        since: since[agent.id] ?? Date.now(),
        state:
          agent.status === "blocked" && waitingOnYou.has(agent.id)
            ? { label: "Waiting on you", tone: "attention" }
            : { label: presentation.label, tone: presentation.tone },
      });
    }
    // Newest first; agents that changed state at the same moment keep roster order.
    chats.sort((a, b) => b.since - a.since || agents.indexOf(a.agent) - agents.indexOf(b.agent));
  }

  return {
    running: withStatus("doing"),
    chats,
    queued: withStatus("todo"),
    ready: withStatus("done"),
    blocked: withStatus("blocked"),
    answered: newestFirst(
      ordered.filter((t) => t.status === "idle"),
      (t) => t.finished ?? t.updated,
    ).map(rowFor),
    team: agents.filter((a) => a.kind !== "maintenance"),
  };
}

/** How a task's state reads: live from its owner while running, else its own status. */
export function taskState(
  task: Task,
  owner: Agent | undefined,
  children: readonly Task[],
  waitingOnYou: ReadonlySet<string>,
): { label: string; tone: StateTone } {
  if (!RUNNING.includes(task.status)) return stateForStopped(task);
  if (owner?.status === "blocked" && waitingOnYou.has(owner.id)) return { label: "Waiting on you", tone: "attention" };
  const ownerStatus = owner ? AGENT_STATUS[owner.status] : null;
  if (ownerStatus?.busy) return { label: ownerStatus.label, tone: ownerStatus.tone };
  if (children.some((c) => c.status === "doing")) return { label: "Waiting on teammates", tone: "running" };
  return { label: "Working", tone: "running" };
}

function stateForStopped(task: Task): TaskRow["state"] {
  switch (task.status) {
    case "todo":
      return { label: "Waiting its turn", tone: "idle" };
    case "done":
      return { label: "Ready for review", tone: "review" };
    case "blocked":
      return { label: "Blocked", tone: "danger" };
    case "reviewed":
      return { label: "Reviewed", tone: "success" };
    case "idle":
      return task.prompt.trim() ? { label: "Answered", tone: "idle" } : { label: "Idle", tone: "idle" };
    default:
      return { label: "Closed", tone: "idle" };
  }
}

/** "2 of 5 steps" for a plan, as a fraction for the bar. */
export const progressRatio = (progress: { done: number; total: number }) => (progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0);
