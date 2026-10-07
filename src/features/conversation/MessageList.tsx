import { memo, useMemo, type ReactNode } from "react";
import { ArrowDown, Brain, CircleAlert, Share2, Sparkles } from "lucide-react";
import { portraitKey, Button, Markdown, Portrait, ICON_SIZE, ICON_STROKE } from "../../design";
import { AttachmentGallery } from "../attachments/AttachmentView";
import { presentTool } from "../../lib/tools";
import type { Agent } from "../../lib/types";
import type { ChatMessage, MessageRole } from "../../stores/chats";
import ReadAloud from "../voices/ReadAloud";
import { withoutOwnMemory } from "./ownMemory";
import { useStickToBottom } from "./useStickToBottom";
import "./conversation.css";

/** Messages that come from the agent's side of the conversation. */
const AGENT_SIDE: readonly MessageRole[] = ["agent", "tool", "thinking", "artifact"];

const startsAgentRun = (messages: readonly ChatMessage[], index: number) =>
  AGENT_SIDE.includes(messages[index].role) && (index === 0 || !AGENT_SIDE.includes(messages[index - 1].role));

const MessageRow = memo(function MessageRow({ message, agentId }: { message: ChatMessage; agentId: string }) {
  switch (message.role) {
    case "user":
      return (
        <div className="msg msg-user">
          {message.text && <p className="msg-bubble selectable">{message.text}</p>}
          {message.attachments && <AttachmentGallery files={message.attachments} compact />}
        </div>
      );
    case "artifact": {
      // What the agent made this turn, or shared on purpose.
      const shared = message.detail === "shared";
      const Icon = shared ? Share2 : Sparkles;
      return (
        <div className="msg msg-artifact">
          <span className="msg-artifact-label">
            <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            {shared ? "Shared" : "Made in this turn"}
          </span>
          {message.text && <Markdown text={message.text} className="msg-artifact-caption" />}
          <AttachmentGallery files={message.attachments ?? []} />
        </div>
      );
    }
    case "agent":
      return <><Markdown text={message.text ?? ""} className="msg msg-agent" />{message.text && <ReadAloud agentId={agentId} text={message.text} messageId={String(message.id)} />}</>;
    case "tool": {
      const { verb, icon: Icon } = presentTool(message.tool);
      return (
        <div className="msg msg-tool">
          <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="msg-tool-icon" />
          <span className="msg-tool-verb">{verb}</span>
          {message.detail && (
            <span className="msg-tool-detail mono selectable" title={message.detail}>
              {message.detail}
            </span>
          )}
        </div>
      );
    }
    case "thinking":
      return (
        <details className="msg msg-thinking">
          <summary>
            <Brain aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            Thinking
          </summary>
          <p className="selectable">{message.text}</p>
        </details>
      );
    case "error":
      return (
        <div className="msg msg-error">
          <CircleAlert aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          <p className="selectable">{message.text}</p>
        </div>
      );
    default:
      return (
        <div className="msg msg-system">
          <span>{message.text}</span>
        </div>
      );
  }
});

interface MessageListProps {
  agent: Pick<Agent, "id" | "name" | "figure" | "accent">;
  messages: readonly ChatMessage[];
  /** The agent is working on a reply. */
  pending: boolean;
  /** Shown when there are no messages yet. */
  empty: ReactNode;
  /** After the messages: what the agent is waiting on you for in this chat. */
  after?: ReactNode;
}

/** The transcript: follows new messages unless the reader scrolled back. */
export default function MessageList({ agent, messages: transcript, pending, empty, after }: MessageListProps) {
  const { scrollerRef, contentRef, atEnd, jumpToEnd } = useStickToBottom();
  const messages = useMemo(() => withoutOwnMemory(transcript, agent.id), [transcript, agent.id]);
  return (
    <div className="message-area">
      <div className="message-scroller" ref={scrollerRef}>
        <div className="message-column" ref={contentRef} role="log" aria-label={`Conversation with ${agent.name}`}>
        {messages.length === 0 && !pending && !after && empty}
        {messages.map((message, i) => (
          <div key={message.id} className="msg-slot">
            {startsAgentRun(messages, i) && (
              <div className="msg-author">
                <Portrait name={agent.name} figure={portraitKey(agent)} accent={agent.accent} size={24} />
                {agent.name}
              </div>
            )}
            <MessageRow message={message} agentId={agent.id} />
          </div>
        ))}
        {after}
        {pending && (
          <div className="msg-pending" role="status">
            <span className="typing-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
            {agent.name} is working
          </div>
        )}
        </div>
      </div>
      {!atEnd && (
        <Button className="jump-to-end" size="sm" icon={ArrowDown} onClick={jumpToEnd}>
          Latest
        </Button>
      )}
    </div>
  );
}
