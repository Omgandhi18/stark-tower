// What each agent is doing right now, in plain language, from its chat stream.
import { create } from "zustand";
import { presentTool } from "../lib/tools";
import type { ChatEvent } from "../lib/types";

export interface Activity {
  /** A short human sentence ("Editing src/App.tsx"). */
  summary: string;
  kind: "tool" | "text" | "thinking" | "error" | "system";
  at: number;
}

const SUMMARY_LIMIT = 140;

const clip = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT - 1)}…` : line;
};

/** Turn one chat event into an activity line, or null if it says nothing new. */
export function summarize(event: ChatEvent, now = Date.now()): Activity | null {
  switch (event.kind) {
    case "tool": {
      const { verb } = presentTool(event.tool);
      const detail = event.detail ? clip(event.detail) : "";
      return { summary: detail ? `${verb} ${detail}` : verb, kind: "tool", at: now };
    }
    case "text":
      return event.text ? { summary: clip(event.text), kind: "text", at: now } : null;
    case "thinking":
      return { summary: "Thinking it through", kind: "thinking", at: now };
    case "error":
      return event.text ? { summary: clip(event.text), kind: "error", at: now } : null;
    default:
      return null;
  }
}

/** The tools that start a temporary helper (a subagent) for the agent. */
const HELPER_TOOLS: readonly string[] = ["Task", "Agent"];
/** Events that end an agent's turn, and with it any helpers it started. */
const TURN_ENDS: readonly string[] = ["result", "exit", "init"];

/** How many helpers an agent has running after this event (they report back before its turn ends). */
export function helpersAfter(running: number, event: ChatEvent): number {
  if (TURN_ENDS.includes(event.kind)) return 0;
  if (event.kind === "tool" && event.tool && HELPER_TOOLS.includes(event.tool)) return running + 1;
  return running;
}

interface ActivityState {
  latest: Record<string, Activity>;
  /** Temporary helpers each agent has running in its current turn. */
  helpers: Record<string, number>;
  record: (event: ChatEvent, now?: number) => void;
}

export const useActivity = create<ActivityState>((set) => ({
  latest: {},
  helpers: {},
  record: (event, now) => {
    const activity = summarize(event, now);
    set((state) => {
      const running = state.helpers[event.agentId] ?? 0;
      const helpers = helpersAfter(running, event);
      if (!activity && helpers === running) return state;
      return {
        latest: activity ? { ...state.latest, [event.agentId]: activity } : state.latest,
        helpers: helpers === running ? state.helpers : { ...state.helpers, [event.agentId]: helpers },
      };
    });
  },
}));
