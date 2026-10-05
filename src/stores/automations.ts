// Scheduled work, mirrored from the backend, with the runs of each automation
// the developer has looked at.
import { create } from "zustand";
import { listAutomationRuns, listAutomations } from "../lib/api";
import type { Automation, AutomationRun } from "../lib/types";

interface AutomationsState {
  items: Automation[];
  loaded: boolean;
  /** Runs by automation, newest first; loaded when an automation is opened. */
  runs: Record<number, AutomationRun[]>;
  refresh: () => Promise<void>;
  refreshRuns: (id: number) => Promise<void>;
  /** After a change: the list, and the runs already on screen. */
  refreshAll: () => Promise<void>;
  /** Show a saved automation straight away, before the backend's change event. */
  apply: (automation: Automation) => void;
}

export const useAutomations = create<AutomationsState>((set, get) => ({
  items: [],
  loaded: false,
  runs: {},
  refresh: async () => set({ items: await listAutomations(), loaded: true }),
  refreshRuns: async (id) => {
    const runs = await listAutomationRuns(id);
    set((s) => ({ runs: { ...s.runs, [id]: runs } }));
  },
  refreshAll: async () => {
    const seen = Object.keys(get().runs).map(Number);
    await Promise.all([get().refresh(), ...seen.map((id) => get().refreshRuns(id))]);
  },
  apply: (automation) =>
    set((s) => ({
      items: s.items.some((a) => a.id === automation.id)
        ? s.items.map((a) => (a.id === automation.id ? automation : a))
        : [...s.items, automation].sort((a, b) => a.name.localeCompare(b.name)),
    })),
}));
