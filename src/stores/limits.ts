import { create } from "zustand";
import { refreshUsageLimits, usageLimits } from "../lib/api";
import type { UsageLimits } from "../lib/bindings";

/** Read limits again when the last reading is this old. */
export const LIMITS_MAX_AGE_SECS = 300;
/** After a turn, sooner: the turn used some of them. */
export const LIMITS_AFTER_TURN_SECS = 120;

interface LimitsState {
  limits: UsageLimits | null;
  /** Ask for the latest; anything older than `maxAgeSecs` is read again in the background. */
  load: (maxAgeSecs?: number) => Promise<void>;
  /** Read every provider again now. */
  refresh: () => Promise<void>;
}

export const useLimits = create<LimitsState>((set) => ({
  limits: null,
  load: async (maxAgeSecs = LIMITS_MAX_AGE_SECS) => {
    set({ limits: await usageLimits(maxAgeSecs) });
  },
  refresh: async () => {
    set({ limits: await refreshUsageLimits() });
  },
}));
