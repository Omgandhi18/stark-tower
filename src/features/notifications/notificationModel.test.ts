import { describe, expect, it } from "vitest";
import type { Notification } from "../../lib/types";
import { dayLabel, groupByDay, NO_FILTERS, presentKind, viewCounts, visibleNotifications } from "./notificationModel";

const NOW = new Date(2026, 9, 5, 15, 0).getTime();
const HOUR = 60 * 60 * 1000;

const note = (id: number, over: Partial<Notification>): Notification => ({
  id,
  ts: NOW - id * HOUR,
  kind: "approval",
  urgency: "needs_you",
  agent_id: "friday",
  task_id: null,
  cwd: "/w/app",
  title: `Item ${id}`,
  body: "",
  review_id: null,
  read: false,
  handled: null,
  outcome: null,
  automation_id: null,
  ...over,
});

const items = [
  note(1, {}),
  note(2, { kind: "task_ready", agent_id: "edith", cwd: "/w/api" }),
  note(3, { kind: "check_failed", urgency: "update", title: "Tests failed" }),
  note(4, { handled: NOW, outcome: "Allowed once" }),
  note(30, { kind: "rule_used", urgency: "update", read: true }),
];

describe("notification views", () => {
  it("splits what needs you from updates, with history holding everything", () => {
    const ids = (view: "needs-you" | "updates" | "history") => visibleNotifications(items, view, NO_FILTERS, "", "newest").map((n) => n.id);
    expect(ids("needs-you")).toEqual([1, 2]);
    expect(ids("updates")).toEqual([3, 30]);
    expect(ids("history")).toEqual([1, 2, 3, 4, 30]);
    expect(viewCounts(items)).toEqual({ "needs-you": 2, updates: 1, history: 0 });
  });

  it("filters by project, agent and type, and searches", () => {
    expect(visibleNotifications(items, "history", { ...NO_FILTERS, project: "/w/api" }, "", "newest").map((n) => n.id)).toEqual([2]);
    expect(visibleNotifications(items, "history", { ...NO_FILTERS, agent: "edith" }, "", "newest").map((n) => n.id)).toEqual([2]);
    expect(visibleNotifications(items, "history", { ...NO_FILTERS, kind: "check_failed" }, "", "newest").map((n) => n.id)).toEqual([3]);
    expect(visibleNotifications(items, "history", NO_FILTERS, "tests", "oldest").map((n) => n.id)).toEqual([3]);
  });

  it("groups by day", () => {
    expect(dayLabel(NOW - HOUR, NOW)).toBe("Today");
    expect(dayLabel(NOW - 24 * HOUR, NOW)).toBe("Yesterday");
    const groups = groupByDay(visibleNotifications(items, "history", NO_FILTERS, "", "newest"), NOW);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ["Today", 4],
      ["Yesterday", 1],
    ]);
  });

  it("names every kind", () => {
    expect(presentKind("task_blocked").verb).toBe("is blocked");
    expect(presentKind("mystery").label).toBe("Review");
  });
});
