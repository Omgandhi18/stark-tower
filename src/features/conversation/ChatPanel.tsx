import { useCallback, useEffect } from "react";
import { MessagesSquare } from "lucide-react";
import { EmptyState, SkeletonRows, cx } from "../../design";
import { errorMessage } from "../../lib/errors";
import { useAgents, selectAgent } from "../../stores/agents";
import { selectQuestionFor, useAttention } from "../../stores/attention";
import { selectThread, useChats } from "../../stores/chats";
import type { Attachment } from "../../lib/types";
import { folderName, useWorkspace } from "../../stores/workspace";
import { FileDropZone } from "../attachments/FileDropZone";
import { useAttachmentDraft, type FilesUpdate } from "../attachments/useAttachmentDraft";
import ChatComposer from "./ChatComposer";
import MessageList from "./MessageList";
import QuestionCard from "./QuestionCard";
import { answerQuestion, sendMessage, stopChat } from "./chatActions";

interface ChatPanelProps {
  agentId: string;
  /** Narrow layout for side panels. */
  compact?: boolean;
}

const reportTo = (agentId: string, fallback: string) => (error: unknown) =>
  useChats.getState().pushError(agentId, errorMessage(error, fallback));

/** One agent's conversation: transcript, any question it's waiting on, and the composer. */
export default function ChatPanel({ agentId, compact = false }: ChatPanelProps) {
  const agent = useAgents(selectAgent(agentId));
  const thread = useChats(selectThread(agentId));
  const question = useAttention(selectQuestionFor(agentId));
  const activeProject = useWorkspace((s) => s.activeProject);
  const changeFiles = useCallback<FilesUpdate>((change) => useChats.getState().updateFiles(agentId, change), [agentId]);
  const attachments = useAttachmentDraft(thread.files, changeFiles);

  // Load the saved chat on first view, and again after the agent moves to another conversation.
  useEffect(() => {
    if (thread.hydrated) return;
    useChats.getState().hydrate(agentId).catch(reportTo(agentId, "This chat's history couldn't be loaded."));
  }, [agentId, thread.hydrated]);

  if (!agent) return null;
  const folder = thread.folder || activeProject;

  const send = (text: string, files: Attachment[] = []) => {
    if (question) void answerQuestion(agentId, question, text);
    else void sendMessage(agentId, text, folder, files);
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
      <MessageList agent={agent} messages={thread.messages} pending={thread.pending} empty={empty} />
      <div className="chat-dock">
        {question && <QuestionCard question={question} agentName={agent.name} busy={thread.pending} onChoose={send} />}
        <ChatComposer
          agentId={agentId}
          agentName={agent.name}
          folder={folder}
          pending={thread.pending}
          answering={Boolean(question)}
          attachments={attachments}
          onSend={send}
          onStop={() => void stopChat(agentId).catch(reportTo(agentId, "The session couldn't be stopped."))}
        />
      </div>
    </FileDropZone>
  );
}
