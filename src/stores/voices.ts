import { create } from "zustand";
import { voiceStatus } from "../lib/api";
import type { VoiceStatus } from "../lib/types";

interface VoicesState {
  status: VoiceStatus | null;
  viewing: Partial<Record<"environment" | "task", string | null>>;
  viewChat: (screen: "environment" | "task", agentId: string | null) => void;
  apply: (status: VoiceStatus) => void;
  refresh: () => Promise<void>;
}
export const useVoices = create<VoicesState>((set) => ({
  status: null,
  viewing: {},
  viewChat: (screen, agentId) => set((s) => ({ viewing: { ...s.viewing, [screen]: agentId } })),
  apply: (status) => set({ status }),
  refresh: async () => set({ status: await voiceStatus() }),
}));
