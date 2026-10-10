import { describe, expect, it } from "vitest";
import type { ShellPathHealth } from "../../lib/bindings";
import { clockTime, shellPathSummary } from "./diagnosticsModel";

const NOW = new Date(2026, 9, 10, 15, 30).getTime();
const READ_AT = new Date(2026, 9, 10, 14, 5).getTime();
const base: ShellPathHealth = { shell: "/bin/zsh", read: true, error: null, elapsedMs: 640, added: 12, readAt: READ_AT, reading: false };

describe("clockTime", () => {
  it("shows the time alone for today, and the date too for an earlier day", () => {
    const today = clockTime(READ_AT, NOW);
    expect(today).toMatch(/2:05|14:05/);
    expect(today).not.toMatch(/Oct/);
    const yesterday = new Date(2026, 9, 9, 14, 5).getTime();
    expect(clockTime(yesterday, NOW)).toMatch(/Oct.*9|9.*Oct/);
  });
});

describe("shellPathSummary", () => {
  it("says which shell was read, when, and how long it took", () => {
    const row = shellPathSummary(base, NOW);
    expect(row.value).toBe(`Read from /bin/zsh at ${clockTime(READ_AT, NOW)}, in 0.6s`);
    expect(row.tone).toBe("success");
  });

  it("keeps the last reading's time while it's read again", () => {
    const row = shellPathSummary({ ...base, reading: true }, NOW);
    expect(row.value).toBe("Reading it again…");
    expect(row.detail).toContain(`Last read at ${clockTime(READ_AT, NOW)}`);
    expect(row.tone).toBe("idle");
  });

  it("explains a shell that couldn't be read, and when it was tried", () => {
    const row = shellPathSummary({ ...base, read: false, error: "/bin/zsh took longer than 6s to start" }, NOW);
    expect(row.value).toBe("Couldn't be read");
    expect(row.detail).toContain("/bin/zsh took longer than 6s to start");
    expect(row.detail).toContain(clockTime(READ_AT, NOW));
    expect(row.detail).toContain("standard install folders");
    expect(row.tone).toBe("attention");
  });
});
