import { useEffect } from "react";
import type { Agent, Task } from "../../lib/types";
import { selectThread, useChats } from "../../stores/chats";

/**
 * Whether this task's chat is the one its owner talks in now, so you can talk, point and
 * attach in it here. Loads the owner's thread to find out.
 */
export function useLiveChat(task: Task, owner: Agent | undefined): boolean {
  const thread = useChats(selectThread(task.assignee));
  const hydrate = useChats((s) => s.hydrate);

  useEffect(() => {
    if (!thread.hydrated) hydrate(task.assignee).catch(() => undefined);
  }, [hydrate, task.assignee, thread.hydrated]);

  return Boolean(owner) && task.conversation_id !== null && thread.hydrated && !thread.loading && thread.conversationId === task.conversation_id;
}
