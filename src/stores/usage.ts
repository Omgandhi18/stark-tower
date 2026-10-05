// The latest token and cost readings per agent, as reported by the provider at
// the end of each turn. Kept outside any screen so totals survive navigation.
import { create } from "zustand";
import type { UsageUpdate } from "../lib/types";

export interface UsageReading extends UsageUpdate {
  at: number;
}

interface UsageState {
  byAgent: Record<string, UsageReading>;
  record: (update: UsageUpdate, now?: number) => void;
}

export const useUsage = create<UsageState>((set) => ({
  byAgent: {},
  record: (update, now = Date.now()) => set((s) => ({ byAgent: { ...s.byAgent, [update.agentId]: { ...update, at: now } } })),
}));
