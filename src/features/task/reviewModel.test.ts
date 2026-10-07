import { describe, expect, it } from "vitest";
import type { Task } from "../../lib/types";
import { delegatedToReview, finishedLabel } from "./reviewModel";

const part = (id: string, status: string) => ({ id, status, parent_id: "owner" }) as Task;

describe("delegatedToReview", () => {
  it("takes finished work, with changes or an answer, and counts what's still going or stuck", () => {
    const children = [part("a", "done"), part("b", "idle"), part("c", "blocked"), part("d", "doing"), part("e", "reviewed"), part("f", "closed")];
    const { finished, unfinished } = delegatedToReview(children);
    expect(finished.map((t) => t.id)).toEqual(["a", "b"]);
    expect(unfinished).toBe(2);
  });

  it("says how many", () => {
    expect(finishedLabel(1)).toBe("1 finished delegated task");
    expect(finishedLabel(2)).toBe("2 finished delegated tasks");
  });
});
