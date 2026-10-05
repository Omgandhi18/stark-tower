import { describe, expect, it } from "vitest";
import { formatElapsed, formatRelative } from "./time";

describe("formatElapsed", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [12 * 60_000, "12m"],
    [72 * 60_000, "1h 12m"],
    [2 * 3_600_000, "2h"],
    [76 * 3_600_000, "3d 4h"],
  ])("%i ms is %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });

  it("never shows a negative duration", () => {
    expect(formatElapsed(-5000)).toBe("0s");
  });
});

describe("formatRelative", () => {
  const now = Date.UTC(2026, 9, 5, 12, 0, 0);
  it("reads like a person would say it", () => {
    expect(formatRelative(now - 20_000, now)).toBe("just now");
    expect(formatRelative(now - 12 * 60_000, now)).toBe("12m ago");
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatRelative(now - 30 * 3_600_000, now)).toBe("yesterday");
  });
});
