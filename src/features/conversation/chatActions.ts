// What the conversation views can do, kept apart from how they look: each
// action updates the shared thread and talks to the backend.
import { chatSend, chatStop, newChat, openConversation } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { ReviewRequest } from "../../lib/types";
import { useAttention } from "../../stores/attention";
import { selectThread, useChats } from "../../stores/chats";

/** Send a message into the agent's thread. Resolves false (with the reason in the thread) if it failed. */
export async function sendMessage(agentId: string, text: string, folder: string): Promise<boolean> {
  const chats = useChats.getState();
  const key = chats.pushUser(agentId, text);
  chats.setPending(agentId, true);
  try {
    const storedId = await chatSend(agentId, text, folder || undefined);
    if (storedId !== null) useChats.getState().confirmStored(agentId, key, storedId);
    return true;
  } catch (error) {
    chats.pushError(agentId, errorMessage(error, "The message couldn't be sent."));
    return false;
  }
}

/** Answer a question the agent is blocked on; the question stays in the thread for context. */
export async function answerQuestion(agentId: string, question: ReviewRequest, text: string): Promise<void> {
  const chats = useChats.getState();
  chats.push(agentId, { role: "agent", text: question.body || question.title });
  chats.pushUser(agentId, text);
  chats.setPending(agentId, true);
  try {
    await useAttention.getState().respond(question.id, text);
  } catch (error) {
    chats.pushError(agentId, errorMessage(error, "Your answer didn't reach the agent."));
  }
}

/** End the live session. The transcript stays; the next message picks the chat back up. */
export async function stopChat(agentId: string): Promise<void> {
  await chatStop(agentId);
  const chats = useChats.getState();
  chats.setPending(agentId, false);
  chats.push(agentId, { role: "system", text: "Stopped. Your next message continues this chat." });
}

/** Start over in a fresh chat; the current one stays in earlier chats. */
export async function startNewChat(agentId: string): Promise<void> {
  await newChat(agentId);
  const chats = useChats.getState();
  const { folder } = selectThread(agentId)(chats);
  chats.reset(agentId);
  if (folder) chats.setFolder(agentId, folder);
  await chats.hydrate(agentId);
}

export async function reopenChat(agentId: string, conversationId: number): Promise<void> {
  await openConversation(conversationId);
  const chats = useChats.getState();
  chats.reset(agentId);
  await chats.hydrate(agentId);
}
