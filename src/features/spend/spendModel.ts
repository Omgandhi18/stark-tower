import type { Budget, SpendTotal } from "../../lib/bindings";
import { formatCost } from "../../lib/format";

export function budgetMeter(budget: Budget, spent: number) {
  const enabled = budget.limit_usd > 0;
  const percent = enabled ? Math.max(0, (spent / budget.limit_usd) * 100) : 0;
  return {
    enabled,
    percent,
    fill: Math.min(100, percent),
    left: Math.max(0, budget.limit_usd - spent),
    warning: (budget.limit_usd * budget.warn_percent) / 100,
    tone: enabled && percent >= 100 ? "danger" : enabled && percent >= budget.warn_percent ? "attention" : "quiet",
  };
}

export function reportedCost(total: SpendTotal): string {
  return total.turns > 0 && total.unpriced_turns === total.turns ? "No cost reported" : formatCost(total.cost_usd);
}

export function spendDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

export function folderName(path: string): string {
  return path.replace(/\/$/, "").split("/").pop() || "No project folder";
}

export function barPercent(cost: number, maximum: number): number {
  return maximum > 0 ? Math.max(0, Math.min(100, (cost / maximum) * 100)) : 0;
}
