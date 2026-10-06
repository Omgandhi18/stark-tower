import type { Attachment } from "../../lib/types";
import { selectQuestionFor, useAttention } from "../../stores/attention";
import { useChats } from "../../stores/chats";
import { insertPoint } from "./pointModel";

/** Use the composer beside this panel, even when another thread opens during the request. */
export function addPoint(agentId: string, text: string, attachment?: Attachment | null, conversationId?: number | null) {
  if (selectQuestionFor(agentId)(useAttention.getState())) throw new Error("Answer the agent’s question first, then add this reference to the chat.");
  const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>("textarea[data-chat-agent]")).find((el) => el.dataset.chatAgent === agentId);
  const chats = useChats.getState();
  if (conversationId !== undefined && (chats.threads[agentId]?.conversationId ?? null) !== conversationId)
    throw new Error("That chat changed. Point at the element again to add it to this chat.");
  const draft = chats.threads[agentId]?.draft ?? "";
  const next = text
    ? insertPoint(draft, text, input?.selectionStart ?? draft.length, input?.selectionEnd ?? draft.length)
    : { text: draft, caret: input?.selectionStart ?? draft.length };
  chats.setDraft(agentId, next.text);
  if (attachment) chats.updateFiles(agentId, (files) => (files.some((file) => file.path === attachment.path) ? [...files] : [...files, attachment]));
  window.requestAnimationFrame(() => {
    input?.focus();
    input?.setSelectionRange(next.caret, next.caret);
  });
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
