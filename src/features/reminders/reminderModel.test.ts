import { describe, expect, it } from "vitest";
import type { Reminder } from "../../lib/types";
import { describeWhen, fromLocalInput, groupReminders, repeatFor, repeatKind, snoozeChoices, toLocalInput, whenChoices } from "./reminderModel";

const at = (text: string) => new Date(text).getTime();
const NOW = at("2026-10-06T16:00:00");

const reminder = (id: number, over: Partial<Reminder> = {}): Reminder => ({
  id,
  text: `Reminder ${id}`,
  agent_id: "friday",
  task_id: null,
  due: NOW + id * 60_000,
  repeat: null,
  status: "waiting",
  fired: null,
  set_by: "you",
  created: NOW,
  updated: NOW,
  ...over,
});

describe("when a reminder goes off", () => {
  it("offers quick times, this evening only while it's still to come", () => {
    expect(whenChoices(NOW).map((c) => c.label)).toEqual(["In 30 minutes", "In 1 hour", "This evening", "Tomorrow morning"]);
    expect(whenChoices(NOW).find((c) => c.id === "evening")?.at).toBe(at("2026-10-06T18:00:00"));
    expect(whenChoices(NOW).find((c) => c.id === "morning")?.at).toBe(at("2026-10-07T09:00:00"));
    expect(whenChoices(at("2026-10-06T17:30:00")).map((c) => c.id)).not.toContain("evening");
    expect(snoozeChoices(NOW)[0].at).toBe(NOW + 10 * 60_000);
  });

  it("repeats at the chosen time of day, weekly on its day", () => {
    const wednesday = at("2026-10-07T09:00:00");
    expect(repeatFor("never", wednesday)).toBeNull();
    expect(repeatFor("weekdays", wednesday)).toEqual({ kind: "weekdays", time: "09:00" });
    expect(repeatFor("weekly", wednesday)).toEqual({ kind: "weekly", day: 2, time: "09:00" });
    expect(repeatKind({ kind: "daily", time: "09:00" })).toBe("daily");
    expect(repeatKind(null)).toBe("never");
  });

  it("reads and writes the date and time field in local time", () => {
    expect(toLocalInput(at("2026-10-07T09:05:00"))).toBe("2026-10-07T09:05");
    expect(fromLocalInput("2026-10-07T09:05")).toBe(at("2026-10-07T09:05:00"));
    expect(fromLocalInput("")).toBeNull();
  });

  it("says when, and how it repeats", () => {
    expect(describeWhen(reminder(1, { due: at("2026-10-06T18:00:00") }), NOW)).toBe("Today at 6:00 PM");
    expect(describeWhen(reminder(1, { due: at("2026-10-07T09:00:00"), repeat: { kind: "weekdays", time: "09:00" } }), NOW)).toBe(
      "Tomorrow at 9:00 AM · Every weekday at 9:00 AM",
    );
  });
});

describe("the Reminders screen", () => {
  it("puts what went off first, then what's coming, then what's done", () => {
    const items = [
      reminder(3),
      reminder(1),
      reminder(2, { status: "due", fired: NOW }),
      reminder(4, { status: "waiting", repeat: { kind: "daily", time: "09:00" }, fired: NOW - 1000 }),
      reminder(5, { status: "done", updated: NOW + 5 }),
    ];
    const groups = groupReminders(items, new Set([4]));
    expect(groups.due.map((r) => r.id)).toEqual([2, 4]);
    expect(groups.coming.map((r) => r.id)).toEqual([1, 3]);
    expect(groups.done.map((r) => r.id)).toEqual([5]);
  });
});
