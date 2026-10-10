import type { LimitWindow, ProviderLimits } from "../../lib/bindings";
import { formatElapsed } from "../../lib/time";

/** At or under this much left, a limit is worth a glance. */
export const LOW_LEFT_PERCENT = 20;
const FULL = 100;

export type LimitTone = "quiet" | "attention" | "danger";

/** How much of a window is left, 0–100. */
export function percentLeft(window: LimitWindow): number {
  return Math.max(0, Math.min(FULL, Math.round(FULL - window.used_percent)));
}

/** The window with the least left: the one that stops work first. */
export function tightest(limits: ProviderLimits): LimitWindow | null {
  return limits.windows.reduce<LimitWindow | null>((worst, w) => (!worst || w.used_percent > worst.used_percent ? w : worst), null);
}

export function windowTone(window: LimitWindow, limited = false): LimitTone {
  const left = percentLeft(window);
  if (left <= 0 || limited) return "danger";
  return left <= LOW_LEFT_PERCENT ? "attention" : "quiet";
}

export function providerTone(limits: ProviderLimits): LimitTone {
  const worst = tightest(limits);
  if (limits.limited) return "danger";
  return worst ? windowTone(worst) : "quiet";
}

/** "Resets in 3h 12m, Sat 4:30 AM", "Resets any moment", or the CLI's own words. */
export function resetText(window: LimitWindow, now = Date.now()): string | null {
  if (window.resets_at !== null) {
    const wait = window.resets_at - now;
    if (wait <= 0) return "Resets any moment";
    const when = new Date(window.resets_at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
    return `Resets in ${formatElapsed(wait)}, ${when}`;
  }
  return window.resets_text ? `Resets ${window.resets_text}` : null;
}

/** The top bar's words for one provider: its tightest window's share left. */
export function chipText(limits: ProviderLimits): string {
  const worst = tightest(limits);
  if (!worst) return `${limits.name} unavailable`;
  return `${limits.name} ${percentLeft(worst)}% left`;
}
