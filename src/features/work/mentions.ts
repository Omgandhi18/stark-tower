// Who a composer message goes to: "@name rest" goes to that agent, anything
// else to the orchestrator. Names are matched case-insensitively, by name or id.
import type { Agent } from "../../lib/types";

export type Routing =
  | { ok: true; agentId: string; message: string }
  | { ok: false; reason: string };

const MENTION = /^@(\S+)(?:\s+([\s\S]*))?$/;
const LEADING_MENTION = /^@(\S+)\s+/;

export function findAgent(agents: readonly Agent[], token: string): Agent | undefined {
  const t = token.toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === t || a.id.toLowerCase() === t);
}

export function routeMessage(text: string, agents: readonly Agent[], fallbackId: string | undefined): Routing {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "Write a message first." };
  const mention = MENTION.exec(trimmed);
  if (mention) {
    const agent = findAgent(agents, mention[1]);
    if (!agent) return { ok: false, reason: `No agent is called ${mention[1]}.` };
    const message = (mention[2] ?? "").trim();
    if (!message) return { ok: false, reason: `Add a message for ${agent.name}.` };
    return { ok: true, agentId: agent.id, message };
  }
  if (!fallbackId) return { ok: false, reason: "There's no orchestrator to ask. Mention an agent with @." };
  return { ok: true, agentId: fallbackId, message: trimmed };
}

/**
 * The agent a message opens with ("@friday /review the diff") and the text from "@friday " on, which
 * the "/" menu leaves alone: its command is what comes after.
 */
export function leadingAgent(text: string, agents: readonly Agent[]): { agent: Agent; prefix: string } | null {
  const mention = LEADING_MENTION.exec(text);
  const agent = mention && findAgent(agents, mention[1]);
  return mention && agent ? { agent, prefix: mention[0] } : null;
}

/** Agents to suggest while the developer is typing "@par…" (no space yet). */
export function mentionSuggestions(text: string, agents: readonly Agent[]): Agent[] {
  const m = /^@(\S*)$/.exec(text);
  if (!m) return [];
  const q = m[1].toLowerCase();
  return agents.filter((a) => a.name.toLowerCase().startsWith(q) || a.id.toLowerCase().startsWith(q));
}
