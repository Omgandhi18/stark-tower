// What the chat screen's header had, now on the task's: where the chat works, a fresh
// start with the agent, and what the chat has cost.
import { useEffect, useState } from "react";
import { FolderOpen, MessageSquarePlus } from "lucide-react";
import { Button, SelectField } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatTokens } from "../../lib/format";
import type { Agent } from "../../lib/types";
import { selectThread, useChats, type ChatRef } from "../../stores/chats";
import { useNavigation } from "../../stores/navigation";
import { useSpend } from "../../stores/spend";
import { useWorkspace } from "../../stores/workspace";
import { startChatTask } from "../conversation/chatActions";
import { folderOptions } from "../conversation/folders";
import { reportedCost } from "../spend/spendModel";

/** Where the agent's next message in this chat runs. */
export function ChatFolderSelect({ chat }: { chat: ChatRef }) {
  const worktrees = useWorkspace((s) => s.worktrees);
  const projects = useWorkspace((s) => s.projects);
  const activeProject = useWorkspace((s) => s.activeProject);
  const chatFolder = useChats((s) => selectThread(chat.key)(s).folder);
  const folder = chatFolder || activeProject;
  return (
    <SelectField
      label="Works in"
      hideLabel
      icon={FolderOpen}
      value={folder}
      options={folderOptions(projects, folder, worktrees)}
      onChange={(path) => useChats.getState().setFolder(chat.key, path)}
      className="task-chat-folder"
    />
  );
}

interface NewChatButtonProps {
  agent: Agent;
  /** The project the fresh chat starts in. */
  folder: string;
  onError: (message: string | null) => void;
}

/** Start over with the agent in a fresh chat, shown here as its task; this one stays in earlier chats. */
export function NewChatButton({ agent, folder, onError }: NewChatButtonProps) {
  const openTask = useNavigation((s) => s.openTask);
  const [starting, setStarting] = useState(false);
  const start = async () => {
    setStarting(true);
    onError(null);
    try {
      openTask(await startChatTask(agent, folder || undefined));
    } catch (e) {
      onError(errorMessage(e, "A new chat couldn't be started."));
    } finally {
      setStarting(false);
    }
  };
  return (
    <Button icon={MessageSquarePlus} disabled={starting} onClick={() => void start()}>
      New chat
    </Button>
  );
}

/** The chat's recorded cost and latest context fill, once it has any. */
export function ChatCostFact({ conversationId }: { conversationId: number | null }) {
  const usage = useSpend((s) => (conversationId === null ? undefined : s.chats[conversationId]));
  const revision = useSpend((s) => s.revision);
  const refreshChat = useSpend((s) => s.refreshChat);
  useEffect(() => {
    if (conversationId !== null) void refreshChat(conversationId).catch(() => {});
  }, [conversationId, refreshChat, revision]);

  if (!usage || usage.total.turns === 0) return null;
  return (
    <div className="task-fact" title="This chat’s recorded cost and the latest context fill">
      <dt>Chat cost</dt>
      <dd className="tabular">
        {reportedCost(usage.total)}, {formatTokens(usage.context_tokens)} context
      </dd>
    </div>
  );
}
