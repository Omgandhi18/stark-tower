// The developer's terminals: their tabs, the drawer's height and whether it's open.
// The shells themselves live in the backend, so they outlast this window.
import { create } from "zustand";
import { terminalClose, terminalList, terminalOpen } from "../lib/api";
import type { TerminalInfo } from "../lib/bindings";
import { DEFAULT_HEIGHT, MIN_HEIGHT } from "../features/terminal/terminalModel";

const KEY = "starkline.terminal.drawer";

function saved(): { open: boolean; height: number } {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}");
    const height = Number.isFinite(value.height) && value.height >= MIN_HEIGHT ? (value.height as number) : DEFAULT_HEIGHT;
    return { open: value.open === true, height };
  } catch {
    return { open: false, height: DEFAULT_HEIGHT };
  }
}

function persist(open: boolean, height: number) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open, height }));
  } catch {
    // Without storage it still applies for as long as this window is open.
  }
}

interface TerminalState {
  open: boolean;
  height: number;
  items: TerminalInfo[];
  selected: string | null;
  error: string | null;
  toggle: () => void;
  setHeight: (height: number) => void;
  select: (id: string) => void;
  refresh: () => Promise<TerminalInfo[]>;
  add: (folder: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  update: (id: string, patch: Partial<TerminalInfo>) => void;
  report: (message: string | null) => void;
}

export const useTerminal = create<TerminalState>((set, get) => ({
  ...saved(),
  items: [],
  selected: null,
  error: null,
  toggle: () => {
    const s = get();
    persist(!s.open, s.height);
    set({ open: !s.open });
  },
  setHeight: (height) => {
    persist(get().open, height);
    set({ height });
  },
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
}));
