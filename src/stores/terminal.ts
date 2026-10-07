// The developer's terminals: their tabs, where they're shown, the drawer's height and
// whether they're open. The shells themselves live in the backend, so they outlast this window.
import { create } from "zustand";
import { terminalClose, terminalList, terminalOpen } from "../lib/api";
import type { TerminalInfo } from "../lib/bindings";
import { DEFAULT_HEIGHT, MIN_HEIGHT } from "../features/terminal/terminalModel";

const KEY = "starkline.terminal.drawer";

/** Where the terminal shows on a screen that has a side panel: a task's, say. Others always use the bottom. */
export type TerminalPlace = "bottom" | "side";

interface Layout {
  open: boolean;
  height: number;
  place: TerminalPlace;
}

function saved(): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    const height = Number.isFinite(value.height) && value.height >= MIN_HEIGHT ? (value.height as number) : DEFAULT_HEIGHT;
    return { open: value.open === true, height, place: value.place === "side" ? "side" : "bottom" };
  } catch {
    return { open: false, height: DEFAULT_HEIGHT, place: "bottom" };
  }
}

function persist(layout: Layout) {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Without storage it still applies for as long as this window is open.
  }
}

interface TerminalState extends Layout {
  items: TerminalInfo[];
  selected: string | null;
  error: string | null;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  /** Show the terminal there (and show it, if it was hidden). */
  moveTo: (place: TerminalPlace) => void;
  setHeight: (height: number) => void;
  select: (id: string) => void;
  refresh: () => Promise<TerminalInfo[]>;
  add: (folder: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  update: (id: string, patch: Partial<TerminalInfo>) => void;
  report: (message: string | null) => void;
}

export const useTerminal = create<TerminalState>((set, get) => {
  const layout = (change: Partial<Layout>) => {
    const { open, height, place } = { ...get(), ...change };
    persist({ open, height, place });
    set(change);
  };
  return {
    ...saved(),
    items: [],
    selected: null,
    error: null,
    toggle: () => layout({ open: !get().open }),
    setOpen: (open) => layout({ open }),
    moveTo: (place) => layout({ place, open: true }),
    setHeight: (height) => layout({ height }),
    select: (selected) => set({ selected }),
    report: (error) => set({ error }),
    refresh: async () => {
      const items = await terminalList();
      set({ items });
      return items;
    },
    add: async (folder) => {
      const item = await terminalOpen(folder, 80, 24);
      set((s) => ({ items: [...s.items, item], selected: item.id, error: null }));
    },
    remove: async (id) => {
      await terminalClose(id);
      set((s) => ({ items: s.items.filter((t) => t.id !== id), selected: s.selected === id ? null : s.selected }));
    },
    update: (id, patch) => set((s) => ({ items: s.items.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  };
});
