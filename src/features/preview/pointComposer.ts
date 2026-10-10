import type { Attachment } from "../../lib/types";
import { selectQuestionFor, useAttention } from "../../stores/attention";
import { useChats, type ChatRef } from "../../stores/chats";
import { addReference, focusComposer } from "../conversation/references/referenceActions";

/**
 * Add a point to the composer beside this panel, even when another thread opens during the
 * request: a chip above the message box (with its marked screenshot) holding `text`, which the
 * agent receives in full. With no text it just attaches the file (a recording).
 */
export function addPoint(chat: ChatRef, text: string, attachment?: Attachment | null, conversationId?: number | null) {
  const chats = useChats.getState();
  const thread = chats.threads[chat.key];
  if (selectQuestionFor(chat.agentId, thread?.conversationId ?? null)(useAttention.getState()))
    throw new Error("Answer the agent’s question first, then add this reference to the chat.");
  if (conversationId !== undefined && (thread?.conversationId ?? null) !== conversationId)
    throw new Error("That chat changed. Point at the element again to add it to this chat.");
  if (text) {
    addReference(chat, { kind: "point", text, ...(attachment ? { image: attachment } : {}) });
    return;
  }
  if (attachment) chats.updateFiles(chat.key, (files) => (files.some((file) => file.path === attachment.path) ? [...files] : [...files, attachment]));
  focusComposer(chat);
}

/** Draw on a copy so pointing leaves the live frame untouched. */
export function markedFrame(image: HTMLImageElement, x: number, y: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("The screen picture couldn't be marked. Try again.");
  g.drawImage(image, 0, 0);
  const radius = Math.max(12, canvas.width / 40);
  g.beginPath();
  g.arc(x, y, radius, 0, Math.PI * 2);
  const tokens = getComputedStyle(document.documentElement);
  g.strokeStyle = tokens.getPropertyValue("--text-on-strong").trim();
  g.lineWidth = Math.max(4, canvas.width / 150);
  g.stroke();
  g.strokeStyle = tokens.getPropertyValue("--state-danger").trim();
  g.lineWidth /= 2;
  g.stroke();
  return canvas.toDataURL("image/png").split(",")[1];
}
