import { describe, expect, it } from "vitest";
import type { Task } from "../../lib/types";
import { byAgent, stateSummary } from "./executionModel";

const task = (id: string, assignee: string) => ({ id, assignee }) as Task;

describe("byAgent", () => {
  it("lists each agent once, with all their tasks in order", () => {
    const groups = byAgent([task("a", "friday"), task("b", "karen"), task("c", "friday")]);
    expect(groups.map((g) => [g.agentId, g.tasks.map((t) => t.id)])).toEqual([
      ["friday", ["a", "c"]],
      ["karen", ["b"]],
    ]);
  });

  it("has nothing for no tasks", () => {
    expect(byAgent([])).toEqual([]);
  });
});

describe("stateSummary", () => {
  it("counts tasks by state, most pressing first, toned by it", () => {
    expect(
      stateSummary([
        { label: "Working", tone: "running" },
        { label: "Ready for review", tone: "review" },
        { label: "Ready for review", tone: "review" },
      ]),
    ).toEqual({ line: "2 ready for review · 1 working", tone: "review" });
    expect(
      stateSummary([
        { label: "Answered", tone: "idle" },
        { label: "Waiting on you", tone: "attention" },
      ]),
    ).toEqual({ line: "1 waiting on you · 1 answered", tone: "attention" });
  });

  it("reads one state plainly", () => {
    expect(stateSummary([{ label: "Ready for review", tone: "review" }])).toEqual({ line: "1 ready for review", tone: "review" });
  });
});
