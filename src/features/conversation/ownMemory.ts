import type { ChatMessage } from "../../stores/chats";

/** Whether a file is the agent's own memory (`jarvis.md` for JARVIS). */
const isOwnMemory = (name: string, agentId: string) => name.toLowerCase() === `${agentId.toLowerCase()}.md`;

/**
 * The transcript without the agent's own memory among the files a turn made: it isn't something
 * the agent made for you. Starkline no longer saves it there, but older chats did. A file the
 * agent shared on purpose stays, and a turn's card goes when its memory was all it held.
 */
export function withoutOwnMemory(messages: readonly ChatMessage[], agentId: string): ChatMessage[] {
  return messages.flatMap((m) => {
    if (m.role !== "artifact" || m.detail === "shared" || !m.attachments?.some((f) => isOwnMemory(f.name, agentId))) return [m];
    const attachments = m.attachments.filter((f) => !isOwnMemory(f.name, agentId));
    return attachments.length ? [{ ...m, attachments }] : [];
  });
}
