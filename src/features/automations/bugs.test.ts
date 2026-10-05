import { describe, expect, it } from "vitest";
import type { Bug } from "../../lib/types";
import { bugCounts, nextStatuses, presentBugStatus } from "./bugs";

const bug = (status: string): Bug => ({ id: 1, reporter: "friday", title: "t", detail: "", status, created: 0, updated: 0 });

describe("bugs", () => {
  it("counts open and in-progress bugs", () => {
    expect(bugCounts([bug("open"), bug("open"), bug("doing"), bug("fixed")])).toEqual({ open: 2, fixing: 1 });
  });

  it("offers every other status", () => {
    expect(nextStatuses("open")).toEqual(["doing", "fixed", "wontfix"]);
  });

  it("reads unknown statuses as open", () => {
    expect(presentBugStatus("mystery").label).toBe("Open");
  });
});
