// The roster and each agent's live status, plus when that status began (for
// "working for 12m" style elapsed times).
import { create } from "zustand";
import type { Agent, AgentStatus } from "../lib/types";

interface AgentsState {
  agents: Agent[];
  loaded: boolean;
  /** Unix ms at which each agent entered its current status. */
  since: Record<string, number>;
  replace: (list: Agent[], now?: number) => void;
  setStatus: (id: string, status: AgentStatus, now?: number) => void;
}

export const useAgents = create<AgentsState>((set) => ({
  agents: [],
  loaded: false,
  since: {},
  replace: (list, now = Date.now()) =>
    set((state) => {
      const previous = new Map(state.agents.map((a) => [a.id, a.status]));
      const since: Record<string, number> = {};
      for (const a of list) {
        since[a.id] = previous.get(a.id) === a.status ? (state.since[a.id] ?? now) : now;
      }
      return { agents: list, loaded: true, since };
    }),
  setStatus: (id, status, now = Date.now()) =>
    set((state) => {
      const current = state.agents.find((a) => a.id === id);
      if (!current || current.status === status) return state;
      return {
        agents: state.agents.map((a) => (a.id === id ? { ...a, status } : a)),
        since: { ...state.since, [id]: now },
      };
    }),
}));

export const selectAgent = (id: string | null | undefined) => (state: AgentsState) =>
  id ? state.agents.find((a) => a.id === id) : undefined;

/** The orchestrator, if the roster has one (JARVIS by default; names are the user's). */
export const selectOrchestrator = (state: AgentsState) => state.agents.find((a) => a.kind === "orchestrator");
