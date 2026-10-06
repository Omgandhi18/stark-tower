import { create } from "zustand";
import type { Look } from "../lib/bindings";
import { studioLooks } from "../lib/api";
interface LooksState {
  loaded: boolean;
  looks: Record<string, Look>;
  replace: (looks: Look[]) => void;
  put: (look: Look) => void;
  refresh: () => Promise<void>;
}
export const useLooks = create<LooksState>((set, get) => ({
  loaded: false,
  looks: {},
  replace: (looks) => set({ loaded: true, looks: Object.fromEntries(looks.map((look) => [look.id, look])) }),
  put: (look) => set((s) => ({ looks: { ...s.looks, [look.id]: look } })),
  refresh: async () => get().replace(await studioLooks()),
}));
