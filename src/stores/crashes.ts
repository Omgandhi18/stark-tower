// Starkline's own crash log, mirrored from the backend.
import { create } from "zustand";
import { diagnoseCrashes, keepCrashesForLater, listCrashes } from "../lib/api";
import type { Crash, Task } from "../lib/types";

interface CrashesState {
  items: Crash[];
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Hand crashes to the maintenance agent; resolves to the task it works on. */
  diagnose: (ids: string[]) => Promise<Task>;
  keepForLater: (ids: string[]) => Promise<void>;
}

export const useCrashes = create<CrashesState>((set, get) => ({
  items: [],
  loaded: false,
  refresh: async () => set({ items: await listCrashes(), loaded: true }),
  diagnose: async (ids) => {
    const task = await diagnoseCrashes(ids);
    // Not awaited: the caller shows what started first (the backend's change event refreshes too).
    get().refresh().catch(() => undefined);
    return task;
  },
  keepForLater: async (ids) => {
    await keepCrashesForLater(ids);
    await get().refresh();
  },
}));
