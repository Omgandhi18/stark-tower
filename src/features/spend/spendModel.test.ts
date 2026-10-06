import { describe, expect, it } from "vitest";
import { barPercent, budgetMeter, folderName, reportedCost, spendDate } from "./spendModel";
import type { SpendTotal } from "../../lib/bindings";

const total: SpendTotal = { cost_usd: 0, turns: 2, unpriced_turns: 2, input_tokens: 10, output_tokens: 5, context_tokens: 20 };

describe("spend presentation", () => {
  it("keeps unknown prices distinct from zero cost and mixed totals", () => {
    expect(reportedCost(total)).toBe("No cost reported");
    expect(reportedCost({ ...total, turns: 0, unpriced_turns: 0 })).toBe("$0.00");
    expect(reportedCost({ ...total, cost_usd: 1.234, unpriced_turns: 1 })).toBe("$1.23");
    expect(reportedCost({ ...total, cost_usd: 0.001, unpriced_turns: 0 })).toBe("<$0.01");
  });
  it("shows warning and exhaustion at the threshold and caps meter fill", () => {
    const budget = { period: "month" as const, limit_usd: 50, warn_percent: 80 };
    expect(budgetMeter(budget, 39).tone).toBe("quiet");
    expect(budgetMeter(budget, 40)).toMatchObject({ tone: "attention", fill: 80, left: 10, warning: 40 });
    expect(budgetMeter(budget, 51)).toMatchObject({ tone: "danger", fill: 100, percent: 102, left: 0 });
    expect(budgetMeter({ ...budget, limit_usd: 0 }, 51)).toMatchObject({ enabled: false, fill: 0, tone: "quiet" });
  });
  it("formats local calendar dates and folder names", () => {
    expect(spendDate("2026-10-04")).toBe("4 October");
    expect(folderName("/projects/my-app/")).toBe("my-app");
    expect(folderName("")).toBe("No project folder");
  });
  it("leaves empty chart bars at the baseline", () => {
    expect(barPercent(0, 0)).toBe(0);
    expect(barPercent(0, 5)).toBe(0);
    expect(barPercent(2, 5)).toBe(40);
  });
});
