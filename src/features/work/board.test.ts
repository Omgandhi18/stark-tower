import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus, Conversation, ReviewRequest, Task } from "../../lib/types";
import { buildBoard } from "./board";

const agent = (id: string, status: AgentStatus, kind: Agent["kind"] = "worker"): Agent => ({
  id,
  name: id.toUpperCase(),
  role: "",
  kind,
  engine: "claude-code",
  accent: "#fff",
  figure: "engineer",
  home_x: 0,
  home_y: 0,
  status,
});

const task = (id: string, assignee: string, status: string, updated: number, cwd = "/w/app", over: Partial<Task> = {}): Task => ({
  id,
  ts: updated,
  updated,
  title: `Task ${id}`,
  assignee,
  status,
  detail: null,
  cwd,
  conversation_id: null,
  parent_id: null,
  requested_by: "you",
  prompt: "",
  branch: "",
  request_url: null, request_host: null, request_number: null,
  started: updated,
  finished: null,
  plan_done: null,
  plan_total: null,
  workspace_kind: "checkout",
  project_folder: cwd,
  ...over,
});

const chat = (agentId: string, title: string, updated: number, cwd = "/w/app"): Conversation => ({
  id: updated,
  agent_id: agentId,
  title,
  cwd,
  created: updated,
  updated,
  delegated: false,
  project_folder: cwd,
  branch: "",
});

const review = (agentId: string): ReviewRequest => ({
  id: `rv-${agentId}`,
  agentId,
  title: "Run a command?",
  body: "",
  kind: "command",
  choices: [],
  command: "npm install",
  cwd: null,
  rule: null,
  tier: null,
  taskId: null,
  conversationId: null,
  grant: null,
  project: null,
  created: 1,
});

const base = {
  agents: [] as Agent[],
  since: {},
  tasks: [] as Task[],
  conversations: [] as Conversation[],
  latest: {},
  pending: [] as ReviewRequest[],
  project: null as string | null,
};

describe("buildBoard", () => {
  it("shows running tasks with their owner's live state, newest first", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "working"), agent("b", "idle")],
      tasks: [task("t1", "a", "doing", 1), task("t2", "b", "doing", 2)],
    });
    expect(board.running.map((r) => [r.task.id, r.state.label])).toEqual([
      ["t2", "Working"],
      ["t1", "Working"],
    ]);
  });

  it("folds delegated tasks into their parent as contributors", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("jarvis", "idle", "orchestrator"), agent("friday", "working"), agent("karen", "working")],
      tasks: [
        task("parent", "jarvis", "doing", 1),
        task("c1", "friday", "doing", 2, "/w/app", { parent_id: "parent", requested_by: "jarvis" }),
        task("c2", "karen", "done", 3, "/w/app", { parent_id: "parent", requested_by: "jarvis" }),
        task("c3", "friday", "doing", 4, "/w/app", { parent_id: "parent", requested_by: "jarvis" }),
      ],
    });
    expect(board.running.map((r) => r.task.id)).toEqual(["parent"]);
    expect(board.running[0].contributors.map((a) => a.id)).toEqual(["friday", "karen"]);
    expect(board.running[0].state.label).toBe("Waiting on teammates");
    expect(board.ready).toEqual([]);
  });

  it("shows plan progress only when the owner keeps a plan", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "working")],
      tasks: [task("t1", "a", "doing", 1, "/w/app", { plan_done: 2, plan_total: 5 }), task("t2", "a", "done", 2)],
    });
    expect(board.running[0].progress).toEqual({ done: 2, total: 5 });
    expect(board.ready[0].progress).toBeUndefined();
  });

  it("lists agents busy in a plain chat separately", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "working"), agent("b", "working"), agent("c", "thinking")],
      since: { b: 50, c: 50 },
      tasks: [task("t1", "a", "doing", 5)],
      conversations: [chat("b", "Fix login", 3), chat("c", "New chat", 4)],
    });
    expect(board.chats.map((r) => [r.agent.id, r.title])).toEqual([
      ["b", "Fix login"],
      ["c", "Chat with C"],
    ]);
  });

  it("says an agent is waiting on you only when a review is pending", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "blocked"), agent("b", "blocked")],
      tasks: [task("t1", "a", "doing", 1)],
      pending: [review("a")],
    });
    expect(board.running[0].state.label).toBe("Waiting on you");
    expect(board.chats.map((r) => [r.agent.id, r.state.label])).toEqual([["b", "Blocked"]]);
  });

  it("filters to the selected project and to your own requests", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "idle")],
      tasks: [
        task("t1", "a", "done", 1, "/w/app"),
        task("t2", "a", "done", 2, "/w/other"),
        task("t3", "a", "done", 3, "/w/app", { requested_by: "jarvis" }),
      ],
      project: "/w/app",
    });
    expect(board.ready.map((r) => r.task.id)).toEqual(["t3", "t1"]);
    const mine = buildBoard({ ...base, agents: [agent("a", "idle")], tasks: [task("t1", "a", "done", 1), task("t3", "a", "done", 3, "/w/app", { requested_by: "jarvis" })], tab: "mine" });
    expect(mine.ready.map((r) => r.task.id)).toEqual(["t1"]);
  });

  it("separates queued, ready and blocked tasks and hides closed ones", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "idle")],
      tasks: [task("t1", "a", "done", 1), task("t2", "a", "blocked", 2), task("t3", "a", "closed", 3), task("t4", "a", "done", 4), task("t5", "a", "todo", 5)],
    });
    expect(board.ready.map((r) => r.task.id)).toEqual(["t4", "t1"]);
    expect(board.blocked.map((r) => r.task.id)).toEqual(["t2"]);
    expect(board.queued.map((r) => r.state.label)).toEqual(["Waiting its turn"]);
    expect(board.ready[0].owner?.id).toBe("a");
  });

  it("sorts by longest running when asked", () => {
    const board = buildBoard({
      ...base,
      agents: [agent("a", "working")],
      tasks: [task("new", "a", "doing", 9, "/w/app", { started: 9 }), task("old", "a", "doing", 2, "/w/app", { started: 1 })],
      sort: "longest",
    });
    expect(board.running.map((r) => r.task.id)).toEqual(["old", "new"]);
  });

  it("keeps maintenance bots off the team", () => {
    const board = buildBoard({ ...base, agents: [agent("a", "idle"), agent("dum-e", "idle", "maintenance")] });
    expect(board.team.map((a) => a.id)).toEqual(["a"]);
  });
});

it("filters a worktree task by its main project", () => {
  const board = buildBoard({ ...base, tasks: [task("worktree", "a", "doing", 1, "/home/dev/.starkline/worktrees/app/fix", { project_folder: "/w/app", workspace_kind: "worktree" })], agents: [agent("a", "working")], project: "/w/app" });
  expect(board.running).toHaveLength(1);
});
