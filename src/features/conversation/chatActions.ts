// What the conversation views can do, kept apart from how they look: each
// action updates the shared thread and talks to the backend.
import { activeConversation, chatSend, chatStop, newChat, openConversation, taskForChat } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Agent, Attachment, Conversation, ReviewRequest } from "../../lib/types";
import { useAttention } from "../../stores/attention";
import { conversationOfKey, selectThread, useChats, type ChatRef } from "../../stores/chats";
import { useWorkspace } from "../../stores/workspace";

/** The conversation a chat's messages go to: the one its key names, else the one its thread shows. */
const conversationOf = (chat: ChatRef) => conversationOfKey(chat.key) ?? selectThread(chat.key)(useChats.getState()).conversationId;

/** Send a message (and any files) into the chat. Resolves false (with the reason in the thread) if it failed. */
export async function sendMessage(chat: ChatRef, text: string, folder: string, attachments: Attachment[] = []): Promise<boolean> {
  const chats = useChats.getState();
  const key = chats.pushUser(chat.key, text, attachments);
  chats.setPending(chat.key, true);
  try {
    const storedId = await chatSend(chat.agentId, text, folder || undefined, attachments, conversationOf(chat));
    if (storedId !== null) useChats.getState().confirmStored(chat.key, key, storedId);
    return true;
  } catch (error) {
    chats.pushError(chat.key, errorMessage(error, "The message couldn't be sent."));
    return false;
  }
}

/** Answer a question the agent is blocked on; the question stays in the thread for context. */
export async function answerQuestion(chat: ChatRef, question: ReviewRequest, text: string): Promise<void> {
  const chats = useChats.getState();
  chats.push(chat.key, { role: "agent", text: question.body || question.title });
  chats.pushUser(chat.key, text);
  chats.setPending(chat.key, true);
  try {
    await useAttention.getState().respond(question.id, text);
  } catch (error) {
    chats.pushError(chat.key, errorMessage(error, "Your answer didn't reach the agent."));
  }
}

/** End the chat's live session. The transcript stays; the next message picks the chat back up. */
export async function stopChat(chat: ChatRef): Promise<void> {
  await chatStop(chat.agentId, conversationOf(chat));
  const chats = useChats.getState();
  chats.setPending(chat.key, false);
  chats.push(chat.key, { role: "system", text: "Stopped. Your next message continues this chat." });
}

/** Start a fresh chat (in `inFolder`, else where the agent works now); the agent's other chats carry on. Resolves to the new chat. */
export async function startNewChat(agentId: string, inFolder?: string): Promise<number> {
  const conversationId = await newChat(agentId, inFolder);
  const chats = useChats.getState();
  const folder = inFolder ?? selectThread(agentId)(chats).folder;
  chats.reset(agentId);
  if (folder) chats.setFolder(agentId, folder);
  await chats.hydrate(agentId, agentId);
  return conversationId;
}

/** Make a chat the one the agent is open in (where "Talk to" goes). Its other chats keep running. */
export async function reopenChat(agentId: string, conversationId: number): Promise<void> {
  await openConversation(conversationId);
  const chats = useChats.getState();
  chats.reset(agentId);
  await chats.hydrate(agentId, agentId);
}

// Every chat opens as its task: the backend gives a chat that never had one an idle task.

/** A fresh chat with the agent, as its task. The agent may be working elsewhere: it works in both. */
export async function startChatTask(agent: Agent, inFolder?: string): Promise<string> {
  return (await taskForChat(await startNewChat(agent.id, inFolder))).id;
}

/** An earlier chat, as its task, and the one the agent is now open in; you can talk in it at once. */
export async function openChatTask(chat: Conversation): Promise<string> {
  await reopenChat(chat.agent_id, chat.id);
  return (await taskForChat(chat.id)).id;
}

/** The chat the agent talks in now, as its task; one starts in the open project if they've never talked. */
export async function agentChatTask(agentId: string): Promise<string> {
  const conversation = await activeConversation(agentId);
  const chat = conversation?.id ?? (await startNewChat(agentId, useWorkspace.getState().activeProject || undefined));
  return (await taskForChat(chat)).id;
}
