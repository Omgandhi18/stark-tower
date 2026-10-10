import { describe, expect, it } from "vitest";
import type { Task, Todo, TodoList } from "../../lib/types";
import { deleteWarning, listsFor, openCounts, overdue, splitTodos, todoState } from "./todoModel";

const todo = (patch: Partial<Todo> = {}): Todo => ({
  id: 1,
  list_id: 1,
  number: 1,
  title: "Build the APK",
  notes: "",
  agent_id: null,
  task_id: null,
  due: null,
  reminder_id: null,
  done: null,
  done_by: null,
  added_by: "you",
  position: 0,
  created: 0,
  updated: 0,
  ...patch,
});

const list = (start_mode: string, project = ""): TodoList => ({ id: 1, name: "Release", project, start_mode, position: 0, created: 0, updated: 0 });

const task = (status: string) => ({ id: "t1", status }) as Task;

describe("to-do model", () => {
  it("reads a to-do's state from its task, else from who'll do it", () => {
    const base = { list: list("manual"), agentName: "KAREN", waitingOnYou: false };
    expect(todoState({ ...base, todo: todo(), task: undefined }).label).toBe("");
    expect(todoState({ ...base, todo: todo({ agent_id: "karen" }), task: undefined })).toMatchObject({ label: "For KAREN", canStart: true });
    expect(todoState({ ...base, list: list("when_free"), todo: todo({ agent_id: "karen" }), task: undefined }).label).toBe("Waiting for KAREN");
    expect(todoState({ ...base, todo: todo({ agent_id: "karen", task_id: "t1" }), task: task("doing") })).toMatchObject({ label: "KAREN is on it", running: true, canStart: false });
    expect(todoState({ ...base, waitingOnYou: true, todo: todo({ task_id: "t1" }), task: task("doing") }).tone).toBe("attention");
    expect(todoState({ ...base, todo: todo({ task_id: "t1" }), task: task("done") }).label).toBe("Ready for review");
    expect(todoState({ ...base, todo: todo({ task_id: "t1" }), task: task("blocked") })).toMatchObject({ label: "Blocked", canStart: true });
    expect(todoState({ ...base, todo: todo({ done: 5, task_id: "t1" }), task: task("doing") }).label).toBe("Done");
  });

  it("warns before deleting a to-do an agent is working on, and only then", () => {
    const base = { list: list("manual"), agentName: "FRIDAY", waitingOnYou: false };
    const working = todoState({ ...base, todo: todo({ agent_id: "friday", task_id: "t1" }), task: task("doing") });
    expect(deleteWarning(working, "FRIDAY")).toBe("FRIDAY is working on this. Delete anyway?");
    const waiting = todoState({ ...base, waitingOnYou: true, todo: todo({ task_id: "t1" }), task: task("doing") });
    expect(deleteWarning(waiting, "FRIDAY")).not.toBeNull();
    for (const status of ["done", "blocked", "idle", "closed"]) {
      expect(deleteWarning(todoState({ ...base, todo: todo({ task_id: "t1" }), task: task(status) }), "FRIDAY")).toBeNull();
    }
    expect(deleteWarning(todoState({ ...base, todo: todo({ agent_id: "friday" }), task: undefined }), "FRIDAY")).toBeNull();
    expect(deleteWarning(todoState({ ...base, todo: todo({ done: 5, task_id: "t1" }), task: task("doing") }), "FRIDAY")).toBeNull();
  });

  it("keeps open to-dos in your order and done ones latest first", () => {
    const items = [todo({ id: 1, position: 2 }), todo({ id: 2, position: 0 }), todo({ id: 3, done: 10 }), todo({ id: 4, done: 20 })];
    const { open, done } = splitTodos(items);
    expect(open.map((t) => t.id)).toEqual([2, 1]);
    expect(done.map((t) => t.id)).toEqual([4, 3]);
  });

  it("finds a project's lists, counts what's open and spots what's overdue", () => {
    const lists = [list("manual", "/w/app"), { ...list("manual", "/w/app/web"), id: 2 }, { ...list("manual", "/w/apple"), id: 3 }, { ...list("manual"), id: 4 }];
    expect(listsFor(lists, "/w/app/").map((l) => l.id)).toEqual([1, 2]);
    expect([...openCounts([todo(), todo({ id: 2 }), todo({ id: 3, done: 1 }), todo({ id: 4, list_id: 2 })])]).toEqual([[1, 2], [2, 1]]);
    expect(overdue(todo({ due: 100 }), 200)).toBe(true);
    expect(overdue(todo({ due: 100, done: 150 }), 200)).toBe(false);
  });
});
