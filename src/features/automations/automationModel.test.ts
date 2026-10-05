import { describe, expect, it } from "vitest";
import type { Automation, AutomationRun } from "../../lib/types";
import {
  automationHealth,
  describeMissed,
  describeNotify,
  describeSchedule,
  draftFor,
  formatClock,
  formatMinutes,
  formatStamp,
  formatWhen,
  presentRun,
  presentTrigger,
  runDuration,
  runtimeChoices,
  visibleAutomations,
  withKind,
} from "./automationModel";

const automation = (over: Partial<Automation> = {}): Automation => ({
  id: 1,
  name: "Nightly code review",
  agent_id: "jarvis",
  cwd: "/w/stark-tower",
  instruction: "Pull the latest changes and review them",
  schedule: { kind: "weekdays", time: "02:00" },
  enabled: true,
  missed: "run_once",
  notify: "failure",
  max_minutes: 60,
  wake: false,
  created: 0,
  updated: 0,
  next_run: null,
  last_run: null,
  last_status: null,
  ...over,
});

// Monday 5 October 2026, 10:30 local time.
const NOW = new Date(2026, 9, 5, 10, 30).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

describe("schedules in words", () => {
  it("reads clock times the way the Mac shows them", () => {
    expect(formatClock("02:00")).toBe("2:00 AM");
    expect(formatClock("00:05")).toBe("12:05 AM");
    expect(formatClock("12:00")).toBe("12:00 PM");
    expect(formatClock("17:45")).toBe("5:45 PM");
  });

  it("describes every kind of schedule", () => {
    expect(describeSchedule({ kind: "daily", time: "09:30" })).toBe("Every day at 9:30 AM");
    expect(describeSchedule({ kind: "weekdays", time: "02:00" })).toBe("Every weekday at 2:00 AM");
    expect(describeSchedule({ kind: "weekly", day: 3, time: "17:00" })).toBe("Every Thursday at 5:00 PM");
    expect(describeSchedule({ kind: "everyHours", hours: 4 })).toBe("Every 4 hours");
    expect(describeSchedule({ kind: "everyHours", hours: 1 })).toBe("Every hour");
  });

  it("keeps the time when the kind of schedule changes", () => {
    expect(withKind({ kind: "daily", time: "07:15" }, "weekly")).toEqual({ kind: "weekly", day: 0, time: "07:15" });
    expect(withKind({ kind: "weekly", day: 4, time: "07:15" }, "weekdays")).toEqual({ kind: "weekdays", time: "07:15" });
    expect(withKind({ kind: "everyHours", hours: 6 }, "daily")).toEqual({ kind: "daily", time: "09:00" });
    expect(withKind({ kind: "daily", time: "07:15" }, "everyHours")).toEqual({ kind: "everyHours", hours: 4 });
  });

  it("says when the next run is, relative to today", () => {
    expect(formatWhen(at(5, 17), NOW)).toBe("Today at 5:00 PM");
    expect(formatWhen(at(6, 2), NOW)).toBe("Tomorrow at 2:00 AM");
    expect(formatWhen(at(8, 9), NOW)).toBe("Thursday at 9:00 AM");
    expect(formatWhen(at(20, 9), NOW)).toBe("Oct 20 at 9:00 AM");
    expect(formatWhen(at(4, 23), NOW)).toBe("Yesterday at 11:00 PM");
    expect(formatStamp(at(5, 2))).toBe("Oct 5, 2:00 AM");
  });

  it("words limits and settings", () => {
    expect(formatMinutes(45)).toBe("45 minutes");
    expect(formatMinutes(60)).toBe("1 hour");
    expect(formatMinutes(90)).toBe("1 hour 30 minutes");
    expect(formatMinutes(480)).toBe("8 hours");
    expect(runtimeChoices(60)).toEqual([15, 30, 60, 120, 240, 480]);
    expect(runtimeChoices(90)).toEqual([15, 30, 60, 90, 120, 240, 480]);
    expect(describeMissed("ask")).toBe("Asks you whether to run it");
    expect(describeNotify("failure")).toBe("When a run fails or stops");
  });
});

describe("runs and health", () => {
  const run = (over: Partial<AutomationRun>): AutomationRun => ({
    id: 1,
    automation_id: 1,
    scheduled_for: at(5, 2),
    started: at(5, 2),
    finished: at(5, 2, 42),
    status: "succeeded",
    task_id: "t1",
    summary: "",
    trigger: "schedule",
    ...over,
  });

  it("gives every run status a word, a tone and an icon", () => {
    expect(presentRun("succeeded").label).toBe("Finished");
    expect(presentRun("failed").tone).toBe("danger");
    expect(presentRun("missed").label).toBe("Missed");
    expect(presentRun("something new").label).toBe("Skipped");
  });

  it("says what started a run when it wasn't the schedule", () => {
    expect(presentTrigger("you")).toBe("Run by you");
    expect(presentTrigger("late")).toBe("Ran late");
    expect(presentTrigger("schedule")).toBeNull();
  });

  it("times runs that have both ends", () => {
    expect(runDuration(run({}))).toBe(42 * 60 * 1000);
    expect(runDuration(run({ finished: null, status: "running" }))).toBeNull();
    expect(runDuration(run({ started: null, status: "missed" }))).toBeNull();
  });

  it("says how an automation is doing", () => {
    expect(automationHealth(automation({ enabled: false, last_status: "failed" })).label).toBe("Paused");
    expect(automationHealth(automation({ last_status: "failed" })).tone).toBe("danger");
    expect(automationHealth(automation({ last_status: "succeeded" })).label).toBe("Healthy");
    expect(automationHealth(automation()).label).toBe("Waiting for its first run");
  });
});

describe("the list", () => {
  const items = [
    automation({ id: 1, name: "Weekly dependency audit", enabled: false }),
    automation({ id: 2, name: "Nightly code review" }),
    automation({ id: 3, name: "Docs reminder", cwd: "/w/docs", instruction: "Check the docs" }),
  ];

  it("filters by state and search, in name order", () => {
    expect(visibleAutomations(items, "all", "").map((a) => a.id)).toEqual([3, 2, 1]);
    expect(visibleAutomations(items, "active", "").map((a) => a.id)).toEqual([3, 2]);
    expect(visibleAutomations(items, "paused", "").map((a) => a.id)).toEqual([1]);
    expect(visibleAutomations(items, "all", "docs").map((a) => a.id)).toEqual([3]);
  });

  it("starts the editor from an automation, or from sensible defaults", () => {
    const draft = draftFor(items[1], { agentId: "friday", cwd: "/w/app" });
    expect(draft).toMatchObject({ id: 2, name: "Nightly code review", agent_id: "jarvis" });
    expect(draft).not.toHaveProperty("next_run");
    expect(draftFor(undefined, { agentId: "friday", cwd: "/w/app" })).toMatchObject({
      id: null,
      agent_id: "friday",
      cwd: "/w/app",
      enabled: true,
      missed: "run_once",
      notify: "failure",
    });
  });
});
