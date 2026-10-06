import { create } from "zustand";
import { autoMode, setAutoMode } from "../lib/api";

interface AutoModeState {
  /** Conversation id → whether it's in auto mode; missing until it has been read. */
  on: Record<number, boolean>;
  load: (conversationId: number) => Promise<void>;
  /** Change it; the backend announces every conversation the change reached. */
  set: (conversationId: number, on: boolean) => Promise<void>;
  apply: (conversationId: number, on: boolean) => void;
}

/** Which conversations are in auto mode, where what would ask goes ahead on its own. */
export const useAutoMode = create<AutoModeState>((set) => ({
  on: {},
  load: async (conversationId) => {
    const on = await autoMode(conversationId);
    set((s) => ({ on: { ...s.on, [conversationId]: on } }));
  },
  set: async (conversationId, on) => {
    await setAutoMode(conversationId, on);
    set((s) => ({ on: { ...s.on, [conversationId]: on } }));
  },
  apply: (conversationId, on) => set((s) => ({ on: { ...s.on, [conversationId]: on } })),
}));
