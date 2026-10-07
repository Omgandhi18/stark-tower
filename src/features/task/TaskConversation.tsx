import { useEffect } from "react";
import { MessagesSquare } from "lucide-react";
import { EmptyState } from "../../design";
import type { Agent, StoredMessage, Task } from "../../lib/types";
import type { ChatMessage, MessageRole } from "../../stores/chats";
import { useVoices } from "../../stores/voices";
import ChatPanel from "../conversation/ChatPanel";
import MessageList from "../conversation/MessageList";
import { taskChat } from "./liveChat";

const toMessage = (m: StoredMessage): ChatMessage => ({
  id: m.id,
  role: m.role as MessageRole,
  text: m.text ?? undefined,
  tool: m.tool ?? undefined,
  detail: m.detail ?? undefined,
  storedId: m.id,
});

interface TaskConversationProps {
  task: Task;
  owner: Agent | undefined;
  messages: readonly StoredMessage[];
  requester: string;
}

/**
 * The owner's conversation for this task, live: you can talk in it whatever else the owner is
 * doing. A delegated task's is shown as it happened; it belongs to the agent that delegated it.
 */
export default function TaskConversation({ task, owner, messages, requester }: TaskConversationProps) {
  const chat = taskChat(task, owner);
  const live = chat !== null;

  useEffect(() => {
    useVoices.getState().viewChat("task", live ? task.assignee : null);
    return () => useVoices.getState().viewChat("task", null);
  }, [live, task.assignee]);

  if (chat) return <ChatPanel agentId={chat.agentId} chatKey={chat.key} />;

  const agent = owner ?? { id: task.assignee, name: task.assignee, figure: "", accent: "" };

  return (
    <div className="task-transcript">
      <MessageList
        agent={agent}
        messages={messages.map(toMessage)}
        pending={false}
        empty={<EmptyState icon={MessagesSquare} title="No messages yet" body="The conversation appears here once the task starts." />}
      />
      {task.parent_id !== null && (
        <footer className="task-transcript-foot">
          <p>
            {requester} delegated this, and the result goes back to them. {agent.name} works on it on their own.
          </p>
        </footer>
      )}
    </div>
  );
}
