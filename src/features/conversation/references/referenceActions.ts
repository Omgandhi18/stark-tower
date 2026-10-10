import { useChats, type ChatRef, type NewReference } from "../../../stores/chats";
import { tidyExcerpt } from "./referenceModel";

/** Put the caret in this chat's message box, whichever panels are open. */
export function focusComposer(chat: ChatRef) {
  window.requestAnimationFrame(() => {
    const inputs = document.querySelectorAll<HTMLTextAreaElement>("textarea[data-chat-key]");
    Array.from(inputs)
      .find((el) => el.dataset.chatKey === chat.key)
      ?.focus();
  });
}

/** Attach a quote or point to the message being written in this chat, and go back to typing. */
export function addReference(chat: ChatRef, reference: NewReference) {
  useChats.getState().addReference(chat.key, reference);
  focusComposer(chat);
}

/** Reply to part of a message: its words become a quote chip above the message box. */
export function addQuote(chat: ChatRef, selected: string) {
  const text = tidyExcerpt(selected);
  if (text) addReference(chat, { kind: "quote", text });
}
