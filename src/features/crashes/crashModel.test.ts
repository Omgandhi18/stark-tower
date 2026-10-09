import { describe, expect, it } from "vitest";
import type { Crash } from "../../lib/types";
import { crashTime, crashTimeLabel, newestFirst, presentStatus, promptTitle, unasked, undiagnosed } from "./crashModel";

const at = (iso: string) => new Date(iso).getTime();

const crash = (id: string, crashedAt: number, status: Crash["status"]): Crash => ({
  id,
  crashedAt,
  startedAt: null,
  version: "0.1.0",
  pid: 1,
  reason: "boom",
  place: null,
  status,
  taskId: null,
  incident: null,
  folder: "",
});

describe("crash log", () => {
  it("asks only about crashes nobody decided on, oldest first", () => {
    const crashes = [crash("b", 2, "new"), crash("a", 1, "new"), crash("c", 3, "later"), crash("d", 4, "diagnosing")];
    expect(unasked(crashes).map((c) => c.id)).toEqual(["a", "b"]);
    expect(undiagnosed(crashes).map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(newestFirst(crashes).map((c) => c.id)).toEqual(["d", "c", "b", "a"]);
  });

  it("says how many times it crashed", () => {
    expect(promptTitle(1)).toBe("Starkline quit unexpectedly");
    expect(promptTitle(3)).toBe("Starkline quit unexpectedly 3 times");
  });

  it("says when, relative to today", () => {
    // Times read in the Mac's own format; only the day is worded here.
    const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const date = (t: number) => new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const now = at("2026-10-09T15:00:00");
    const [today, lastNight, lastWeek] = [at("2026-10-09T00:10:00"), at("2026-10-08T22:40:00"), at("2026-10-01T09:05:00")];
    expect(crashTime(today, now)).toBe(`today at ${time(today)}`);
    expect(crashTime(lastNight, now)).toBe(`yesterday at ${time(lastNight)}`);
    expect(crashTime(lastWeek, now)).toBe(`${date(lastWeek)} at ${time(lastWeek)}`);
    expect(crashTimeLabel(today, now)).toBe(`Today at ${time(today)}`);
  });

  it("shows each crash's status", () => {
    expect(presentStatus(crash("a", 1, "new"), "DUM-E")).toEqual({ label: "Not looked at", tone: "attention" });
    expect(presentStatus(crash("a", 1, "later"), "DUM-E")).toEqual({ label: "Kept for later", tone: "neutral" });
    expect(presentStatus(crash("a", 1, "diagnosing"), "DUM-E")).toEqual({ label: "With DUM-E", tone: "accent" });
  });
});
