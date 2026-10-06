import { describe, expect, it } from "vitest";
import type { ReviewRequest } from "../../lib/types";
import { choicesFor, decisionText, excerpt, presentReview } from "./presentation";

const review = (over: Partial<ReviewRequest> = {}): ReviewRequest => ({
  id: "rv-1",
  agentId: "friday",
  title: "Ship it?",
  body: "",
  kind: "plan",
  choices: [],
  command: null,
  cwd: null,
  rule: null,
  tier: null,
  taskId: null,
  conversationId: null,
  grant: null,
  project: null,
  created: 0,
  ...over,
});

describe("review presentation", () => {
  it("names each kind plainly, falling back to a decision", () => {
    expect(presentReview(review({ kind: "command" })).label).toBe("Approval needed");
    expect(presentReview(review({ kind: "questions" })).label).toBe("Question");
    expect(presentReview(review({ kind: "something-new" })).label).toBe("Decision needed");
  });

  it("offers the agent's own choices, or approve / request changes", () => {
    expect(choicesFor(review({ choices: ["A", "B"] }))).toEqual(["A", "B"]);
    expect(choicesFor(review())).toEqual(["Approve", "Request changes"]);
  });

  it("appends a note to the decision only when there is one", () => {
    expect(decisionText("Approve", "  ")).toBe("Approve");
    expect(decisionText("Request changes", " use the old API ")).toBe("Request changes: use the old API");
  });

  it("previews markdown as plain text", () => {
    const body = "## Plan\n\n1. **Read** `src/App.tsx`\n2. See [docs](http://x)\n```ts\nconst a = 1;\n```\nDone.";
    expect(excerpt(body)).toBe("Plan 1. Read src/App.tsx 2. See docs Done.");
    expect(excerpt("word ".repeat(100), 20)).toHaveLength(20);
  });
});

describe("permission requests", () => {
  it("names gate stops for tools other than the shell", async () => {
    const { presentReview, tierNote } = await import("./presentation");
    expect(presentReview({ kind: "permission" } as never).verb).toBe("needs your permission");
    expect(tierNote("never")).toBe("Never runs without you");
    expect(tierNote(null)).toBeNull();
  });
});
