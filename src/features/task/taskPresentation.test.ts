import { describe, expect, it } from "vitest";
import type { FileChange, TaskEvent } from "../../lib/types";
import { changeLetter, changeSummary, checkPassed, diffLines, filesByAgent, helpersOf, stepLabel, stepState } from "./taskPresentation";

const event = (kind: string, agent: string, data: unknown, summary = ""): TaskEvent => ({
  id: 1,
  task_id: "t",
  ts: 1,
  agent_id: agent,
  kind,
  summary,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

describe("task presentation", () => {
  it("reads plan steps", () => {
    expect(stepState({ content: "a", status: "completed", active: null })).toBe("done");
    expect(stepState({ content: "a", status: "in_progress", active: null })).toBe("doing");
    expect(stepLabel({ content: "Run tests", status: "in_progress", active: "Running tests" })).toBe("Running tests");
    expect(stepLabel({ content: "Run tests", status: "pending", active: "Running tests" })).toBe("Run tests");
  });

  it("summarises changes", () => {
    const changes: FileChange[] = [
      { path: "a", status: "added", added: 10, removed: 0 },
      { path: "b", status: "modified", added: 3, removed: 2 },
      { path: "c", status: "untracked", added: null, removed: null },
      { path: "d", status: "deleted", added: 0, removed: 7 },
    ];
    expect(changeSummary(changes)).toEqual({ added: 2, modified: 1, deleted: 1, linesAdded: 13, linesRemoved: 9 });
    expect(changes.map(changeLetter)).toEqual(["A", "M", "U", "D"]);
  });

  it("classifies diff lines", () => {
    const kinds = diffLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n same").map((l) => l.kind);
    expect(kinds).toEqual(["meta", "meta", "meta", "hunk", "remove", "add", "context"]);
  });

  it("counts files per agent and lists helpers", () => {
    const events = [
      event("file", "friday", { path: "src/a.ts" }),
      event("file", "friday", { path: "src/a.ts" }),
      event("file", "friday", { path: "src/b.ts" }),
      event("file", "karen", "not json", "Edited src/c.ts"),
      event("helper", "friday", { description: "Find usages", type: "Explore" }),
    ];
    expect(filesByAgent(events)).toEqual({ friday: 2, karen: 1 });
    expect(helpersOf(events)).toEqual([{ description: "Find usages", kind: "Explore", at: 1 }]);
  });

  it("reads check outcomes", () => {
    expect(checkPassed(event("verification", "f", { passed: true }))).toBe(true);
    expect(checkPassed(event("verification", "f", { passed: false }))).toBe(false);
    expect(checkPassed(event("file", "f", {}))).toBeNull();
  });
});
