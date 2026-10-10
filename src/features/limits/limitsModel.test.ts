import { describe, expect, it } from "vitest";
import type { LimitWindow, ProviderLimits } from "../../lib/bindings";
import { chipText, percentLeft, providerTone, resetText, tightest, windowTone } from "./limitsModel";

const HOUR = 3_600_000;
const window = (id: string, used: number, patch: Partial<LimitWindow> = {}): LimitWindow => ({
  id,
  label: id,
  used_percent: used,
  resets_at: null,
  resets_text: null,
  ...patch,
});
const provider = (windows: LimitWindow[], patch: Partial<ProviderLimits> = {}): ProviderLimits => ({
  provider: "claude",
  name: "Claude",
  plan: null,
  windows,
  unavailable: null,
  limited: false,
  updated_at: null,
  checking: false,
  ...patch,
});

describe("usage limits", () => {
  it("counts what's left and picks the window that runs out first", () => {
    expect(percentLeft(window("a", 87.4))).toBe(13);
    expect(percentLeft(window("a", 120))).toBe(0);
    const claude = provider([window("five_hour", 34), window("seven_day", 88)]);
    expect(tightest(claude)?.id).toBe("seven_day");
    expect(chipText(claude)).toBe("Claude 12% left");
    expect(tightest(provider([]))).toBeNull();
    expect(chipText(provider([], { name: "Codex" }))).toBe("Codex unavailable");
  });

  it("warns when little is left and when a limit is reached", () => {
    expect(windowTone(window("a", 50))).toBe("quiet");
    expect(windowTone(window("a", 80))).toBe("attention");
    expect(windowTone(window("a", 100))).toBe("danger");
    expect(providerTone(provider([window("a", 10)], { limited: true }))).toBe("danger");
    expect(providerTone(provider([]))).toBe("quiet");
  });

  it("says when a window resets, or the provider's own words", () => {
    const now = new Date(2026, 9, 10, 12, 0).getTime();
    expect(resetText(window("a", 1, { resets_at: now + 3 * HOUR + 12 * 60_000 }), now)).toMatch(/^Resets in 3h 12m, /);
    expect(resetText(window("a", 1, { resets_at: now - 1 }), now)).toBe("Resets any moment");
    expect(resetText(window("a", 1, { resets_text: "shortly" }), now)).toBe("Resets shortly");
    expect(resetText(window("a", 1), now)).toBeNull();
  });
});
