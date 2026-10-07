// What the conversation views can do, kept apart from how they look: each
// action updates the shared thread and talks to the backend.
import { activeConversation, chatSend, chatStop, newChat, openConversation, taskForChat } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent, Attachment, Conversation, ReviewRequest } from "../../lib/types";
import { useAttention } from "../../stores/attention";
import { selectThread, useChats } from "../../stores/chats";
import { useWorkspace } from "../../stores/workspace";

/** Send a message (and any files) into the agent's thread. Resolves false (with the reason in the thread) if it failed. */
export async function sendMessage(agentId: string, text: string, folder: string, attachments: Attachment[] = []): Promise<boolean> {
  const chats = useChats.getState();
  const key = chats.pushUser(agentId, text, attachments);
  chats.setPending(agentId, true);
  try {
    const storedId = await chatSend(agentId, text, folder || undefined, attachments);
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

/** Start over in a fresh chat (in `inFolder`, else where the agent works now); the current one stays in earlier chats. Resolves to the new chat. */
export async function startNewChat(agentId: string, inFolder?: string): Promise<number> {
  const conversationId = await newChat(agentId, inFolder);
  const chats = useChats.getState();
  const folder = inFolder ?? selectThread(agentId)(chats).folder;
  chats.reset(agentId);
  if (folder) chats.setFolder(agentId, folder);
  await chats.hydrate(agentId);
  return conversationId;
}

export async function reopenChat(agentId: string, conversationId: number): Promise<void> {
  await openConversation(conversationId);
  const chats = useChats.getState();
  chats.reset(agentId);
  await chats.hydrate(agentId);
}

// Every chat opens as its task: the backend gives a chat that never had one an idle task.

/** A fresh chat with the agent, as its task. Refused while they work: starting it would end their session. */
export async function startChatTask(agent: Agent, inFolder?: string): Promise<string> {
  if (AGENT_STATUS[agent.status].busy) throw new Error(`${agent.name} is working right now. Start a new chat when they're done.`);
  return (await taskForChat(await startNewChat(agent.id, inFolder))).id;
}

/**
 * An earlier chat, as its task. It becomes the agent's chat when they're free, so you can talk in
 * it at once; switching ends their session, so never mid-task: then the page shows it until you pick it back up.
 */
export async function openChatTask(chat: Conversation, agent: Agent | undefined): Promise<string> {
  const current = selectThread(chat.agent_id)(useChats.getState()).conversationId;
  if (chat.id !== current && !(agent && AGENT_STATUS[agent.status].busy)) await reopenChat(chat.agent_id, chat.id);
  return (await taskForChat(chat.id)).id;
}

/** The chat the agent talks in now, as its task; one starts in the open project if they've never talked. */
export async function agentChatTask(agentId: string): Promise<string> {
  const conversation = await activeConversation(agentId);
  const chat = conversation?.id ?? (await startNewChat(agentId, useWorkspace.getState().activeProject || undefined));
  return (await taskForChat(chat)).id;
}
