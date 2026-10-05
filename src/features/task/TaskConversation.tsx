import { useEffect, useState } from "react";
import { MessagesSquare, Undo2 } from "lucide-react";
import { Button, EmptyState } from "../../design";
import { errorMessage } from "../../lib/errors";
import type { Agent, StoredMessage, Task } from "../../lib/types";
import { selectThread, useChats, type ChatMessage, type MessageRole } from "../../stores/chats";
import ChatPanel from "../conversation/ChatPanel";
import MessageList from "../conversation/MessageList";
import { reopenChat } from "../conversation/chatActions";
import { askedByDeveloper } from "../../lib/requester";

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
 * The owner's conversation for this task. While it's the owner's current chat
 * you can talk in it; an older or delegated one is shown as it happened.
 */
export default function TaskConversation({ task, owner, messages, requester }: TaskConversationProps) {
  const thread = useChats(selectThread(task.assignee));
  const [error, setError] = useState<string | null>(null);
  const live = owner && task.conversation_id !== null && thread.hydrated && !thread.loading && thread.conversationId === task.conversation_id;

  // Find out which conversation the owner is in, so a current task can be talked in.
  useEffect(() => {
    if (!thread.hydrated) useChats.getState().hydrate(task.assignee).catch(() => undefined);
  }, [task.assignee, thread.hydrated]);

  if (live) return <ChatPanel agentId={task.assignee} />;

  const agent = owner ?? { name: task.assignee, figure: "", accent: "" };
  const delegated = !askedByDeveloper(task.requested_by);

  return (
    <div className="task-transcript">
      <MessageList
        agent={agent}
        messages={messages.map(toMessage)}
        pending={false}
        empty={<EmptyState icon={MessagesSquare} title="No messages yet" body="The conversation appears here once the task starts." />}
      />
      <footer className="task-transcript-foot">
        {delegated ? (
          <p>
            {requester} delegated this, and the result goes back to them. {agent.name} works on it on their own.
          </p>
        ) : (
          task.conversation_id !== null && (
            <>
              <p>{agent.name} has moved on to other work since.</p>
              <Button
                icon={Undo2}
                onClick={() => {
                  setError(null);
                  reopenChat(task.assignee, task.conversation_id as number).catch((e) =>
                    setError(errorMessage(e, "The conversation couldn't be reopened.")),
                  );
                }}
              >
                Pick this conversation back up
              </Button>
            </>
          )
        )}
        {error && (
          <p className="task-error" role="alert">
            {error}
          </p>
        )}
      </footer>
    </div>
  );
}
