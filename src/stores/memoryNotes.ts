import { create } from "zustand";

interface MemoryNotesState {
  /** Agents whose memory changed since you last looked at it. */
  updated: Record<string, true>;
  changed: (agentId: string) => void;
  seen: (agentId: string) => void;
}

/** Which agents have updated the notes they keep for themselves, for a quiet dot on their Memory button. */
export const useMemoryNotes = create<MemoryNotesState>((set) => ({
  updated: {},
  changed: (agentId) => set((s) => ({ updated: { ...s.updated, [agentId]: true } })),
  seen: (agentId) =>
    set((s) => {
      if (!s.updated[agentId]) return s;
      const { [agentId]: _seen, ...rest } = s.updated;
      return { updated: rest };
    }),
}));
