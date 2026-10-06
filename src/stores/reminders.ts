// Reminders the developer set, mirrored from the backend.
import { create } from "zustand";
import { listReminders } from "../lib/api";
import type { Reminder } from "../lib/types";

interface RemindersState {
  items: Reminder[];
  loaded: boolean;
  refresh: () => Promise<void>;
  /** Show a saved reminder straight away, before the backend's change event. */
  apply: (reminder: Reminder) => void;
}

export const useReminders = create<RemindersState>((set) => ({
  items: [],
  loaded: false,
  refresh: async () => set({ items: await listReminders(), loaded: true }),
  apply: (reminder) =>
    set((s) => ({
      items: (s.items.some((r) => r.id === reminder.id) ? s.items.map((r) => (r.id === reminder.id ? reminder : r)) : [...s.items, reminder]).sort(
        (a, b) => a.due - b.due || a.id - b.id,
      ),
    })),
}));
