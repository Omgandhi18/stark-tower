import type { Agent, Task } from "../../lib/types";
import { chatKey, type ChatRef } from "../../stores/chats";

/**
 * The chat you can talk, point and attach in on this task's page: its own, while it's one of
 * the owner's chats with you. An agent works in several at once, so every such chat is live; a
 * delegated task's conversation belongs to the agent that delegated it, and is only shown.
 */
export function taskChat(task: Task, owner: Agent | undefined): ChatRef | null {
  if (!owner || task.conversation_id === null || task.parent_id !== null) return null;
  return { agentId: task.assignee, key: chatKey(task.conversation_id) };
}
