import { describe, expect, it } from "vitest";
import type { Task } from "../../lib/types";
import type { Board, TaskRow } from "./board";
import { bulkTargets, closeVerb, selectableRows, selectionState, taskCount } from "./bulk";

const task = (id: string, status: string): Task => ({
  id,
  ts: 0,
  updated: 0,
  title: `Task ${id}`,
  assignee: "jarvis",
  status,
  detail: null,
  cwd: "/w/app",
  conversation_id: null,
  parent_id: null,
  requested_by: "you",
  prompt: "",
  branch: "",
  request_url: null, request_host: null, request_number: null,
  started: 0,
  finished: null,
  plan_done: null,
  plan_total: null,
  workspace_kind: "checkout",
  project_folder: "/w/app",
});

const row = (id: string, status: string): TaskRow => ({ task: task(id, status), contributors: [], since: 0, state: { label: "", tone: "idle" } });

describe("bulkTargets", () => {
  const mixed = [task("a", "done"), task("b", "blocked"), task("c", "done"), task("d", "idle")];

  it("marks only finished work reviewed", () => {
    expect(bulkTargets("review", mixed).map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("closes everything it's given", () => {
    expect(bulkTargets("close", mixed).map((t) => t.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("selectableRows", () => {
  it("leaves running work and plain chats out", () => {
    const board: Board = {
      running: [row("run", "doing")],
      chats: [],
      queued: [row("q", "todo")],
      ready: [row("r", "done")],
      blocked: [row("b", "blocked")],
      answered: [row("an", "idle")],
      team: [],
    };
    expect(selectableRows(board).map((r) => r.task.id)).toEqual(["q", "r", "b", "an"]);
  });
});

describe("selectionState", () => {
  const ids = ["a", "b", "c"];

  it("reads none, some or all of a group", () => {
    expect(selectionState(ids, new Set())).toBe("none");
    expect(selectionState(ids, new Set(["b", "elsewhere"]))).toBe("some");
    expect(selectionState(ids, new Set(ids))).toBe("all");
  });
});

describe("closeVerb", () => {
  it("cancels work that hasn't started, and closes the rest", () => {
    expect(closeVerb([task("a", "todo"), task("b", "todo")])).toBe("Cancel");
    expect(closeVerb([task("a", "todo"), task("b", "done")])).toBe("Close");
    expect(closeVerb([])).toBe("Close");
  });
});

describe("taskCount", () => {
  it("counts tasks in words", () => {
    expect(taskCount(1)).toBe("1 task");
    expect(taskCount(3)).toBe("3 tasks");
  });
});
