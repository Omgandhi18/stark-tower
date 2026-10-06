import { describe, expect, it } from "vitest";
import type { CodeReviewItem } from "../../lib/types";
import { orderReviews, reviewCopy } from "./codeReviewModel";
const item = (reason: string, updated = "2026-10-06", host_kind: "github" | "gitlab" = "github"): CodeReviewItem => ({
  id: reason,
  reason,
  updated,
  host_kind,
  number: 128,
  title: "Fix login",
  cwd: "/w",
  url: "https://example.com",
  branch: "fix",
  head: "abc",
  failed_checks: [],
  agent_id: "friday",
  task_id: null,
});
describe("code review", () => {
  it("puts failed checks first, then feedback, then reviews; newest first within each", () => {
    const values = [item("review"), item("comments", "2026-10-05"), item("failed"), item("changes", "2026-10-06")];
    expect(orderReviews(values).map((i) => i.reason)).toEqual(["failed", "changes", "comments", "review"]);
    expect(values[0].reason).toBe("review");
  });
  it("names both hosts and each action", () => {
    expect(reviewCopy(item("failed")).title).toBe("Checks failed on #128 Fix login");
    expect(reviewCopy(item("comments", undefined, "gitlab")).title).toBe("New comments on !128 Fix login");
    expect(reviewCopy(item("changes")).action).toBe("address it");
    expect(reviewCopy(item("review")).title).toBe("Review requested: #128 Fix login");
    expect(reviewCopy(item("review")).tone).toBe("neutral");
  });
});
