import { useCallback, useEffect, useMemo } from "react";
import { MessagesSquare } from "lucide-react";
import { EmptyState, SkeletonRows, cx } from "../../design";
import { errorMessage } from "../../lib/errors";
import { useAgents, selectAgent } from "../../stores/agents";
import { fromChat, selectQuestionFor, useAttention } from "../../stores/attention";
import { selectThread, useChats, type ChatKey, type ChatRef } from "../../stores/chats";
import type { Attachment } from "../../lib/types";
import { folderName, useWorkspace } from "../../stores/workspace";
import { FileDropZone } from "../attachments/FileDropZone";
import { useAttachmentDraft, type FilesUpdate } from "../attachments/useAttachmentDraft";
import ChatComposer from "./ChatComposer";
import MessageList from "./MessageList";
import ChatRequestCard from "./ChatRequestCard";
import { answerQuestion, sendMessage, stopChat } from "./chatActions";
import "./conversation.css";

interface ChatPanelProps {
  agentId: string;
  /** Which of the agent's chats; by default the one it's open in. */
  chatKey?: ChatKey;
  /** Narrow layout for side panels. */
  compact?: boolean;
}

const reportTo = (key: ChatKey, fallback: string) => (error: unknown) => useChats.getState().pushError(key, errorMessage(error, fallback));

/** One of an agent's chats: transcript, any question it's waiting on there, and the composer. */
export default function ChatPanel({ agentId, chatKey, compact = false }: ChatPanelProps) {
  const key = chatKey ?? agentId;
  const chat: ChatRef = { agentId, key };
  const agent = useAgents(selectAgent(agentId));
  const thread = useChats(selectThread(key));
  const question = useAttention(selectQuestionFor(agentId, thread.conversationId));
  const pending = useAttention((s) => s.pending);
  // Everything the agent waits on you for in this chat, shown in it as well as in Notifications.
  const requests = useMemo(() => pending.filter((r) => fromChat(r, agentId, thread.conversationId)), [pending, agentId, thread.conversationId]);
  const activeProject = useWorkspace((s) => s.activeProject);
  const changeFiles = useCallback<FilesUpdate>((change) => useChats.getState().updateFiles(key, change), [key]);
  const attachments = useAttachmentDraft(thread.files, changeFiles);

  // Load the saved chat on first view, and again after the agent moves to another conversation.
  useEffect(() => {
    if (thread.hydrated) return;
    useChats.getState().hydrate(key, agentId).catch(reportTo(key, "This chat's history couldn't be loaded."));
  }, [key, agentId, thread.hydrated]);

  if (!agent) return null;
  const folder = thread.folder || activeProject;

  const send = (text: string, files: Attachment[] = []) => {
    if (question) void answerQuestion(chat, question, text);
    else void sendMessage(chat, text, folder, files);
  };

  const empty = thread.loading ? (
    <SkeletonRows rows={3} label="Loading the conversation" />
  ) : (
    <EmptyState
      icon={MessagesSquare}
      title={`Start a conversation with ${agent.name}`}
      body={
        folder
          ? `Ask a question or hand over a task. ${agent.name} works in ${folderName(folder)}; type @ to point at a file, or attach, paste or drop files.`
          : "Ask a question or hand over a task. Add a project on Work so there is a folder to work in."
      }
    />
  );

  return (
    <FileDropZone
      draft={attachments}
      className={cx("chat-panel", compact && "is-compact")}
      hint={`Drop files to attach them to your message to ${agent.name}`}
      blocked={question ? `Answer ${agent.name}'s question first, then attach files.` : undefined}
    >
      <MessageList
        agent={agent}
        messages={thread.messages}
        pending={thread.pending}
        empty={empty}
        after={
          requests.length > 0 ? requests.map((review) => <ChatRequestCard key={review.id} review={review} chat={chat} agentName={agent.name} />) : undefined
        }
      />
      <div className="chat-dock">
        <ChatComposer
          chat={chat}
          agentName={agent.name}
          folder={folder}
          pending={thread.pending}
          answering={Boolean(question)}
          attachments={attachments}
          onSend={send}
          onStop={() => void stopChat(chat).catch(reportTo(key, "The session couldn't be stopped."))}
        />
      </div>
    </FileDropZone>
  );
}
