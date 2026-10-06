import { create } from "zustand";
import { conversationSpend, setBudget, spendSummary } from "../lib/api";
import type { Budget, ConversationSpend, SpendSummary } from "../lib/bindings";

interface SpendState {
  summary: SpendSummary | null;
  error: string | null;
  revision: number;
  chats: Record<number, ConversationSpend>;
  refresh: () => Promise<void>;
  changed: () => Promise<void>;
  save: (budget: Budget) => Promise<void>;
  refreshChat: (id: number) => Promise<void>;
}

export const useSpend = create<SpendState>((set, get) => ({
  summary: null,
  error: null,
  revision: 0,
  chats: {},
  refresh: async () => {
    try {
      const summary = await spendSummary();
      set({ summary, error: null });
    } catch (e) {
      set({ error: "Spending couldn't be loaded. Try again." });
      throw e;
    }
  },
  changed: async () => {
    set((s) => ({ revision: s.revision + 1 }));
    await get().refresh();
  },
  save: async (budget) => {
    const summary = await setBudget(budget);
    set({ summary, error: null });
  },
  refreshChat: async (id) => {
    const chat = await conversationSpend(id);
    set((s) => ({ chats: { ...s.chats, [id]: chat } }));
  },
}));
