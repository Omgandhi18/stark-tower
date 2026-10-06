import { useState } from "react";
import { History, Trash2, UsersRound } from "lucide-react";
import { portraitKey, OverflowMenu, Portrait, SectionHeader, SkeletonRows, Tag, cx } from "../../design";
import { errorMessage } from "../../lib/errors";
import { AGENT_STATUS } from "../../lib/status";
import { formatRelative } from "../../lib/time";
import type { Agent } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useActivity } from "../../stores/activity";
import { useAgents } from "../../stores/agents";
import { isQuestion, useAttention } from "../../stores/attention";
import { selectThread, useChats } from "../../stores/chats";
import { useNavigation } from "../../stores/navigation";
import { folderName, useWorkspace } from "../../stores/workspace";
import type { Conversation } from "../../lib/types";
import { reopenChat } from "./chatActions";
import DeleteChatDialog from "./DeleteChatDialog";

const CLOCK_MS = 60_000;
const UNTITLED = "Untitled chat";

function AgentRow({ agent, current, waiting }: { agent: Agent; current: boolean; waiting: boolean }) {
  const activity = useActivity((s) => s.latest[agent.id]);
  const openConversation = useNavigation((s) => s.openConversation);
  const status = AGENT_STATUS[agent.status];
  const line = waiting ? "Waiting for your answer" : status.busy && activity ? activity.summary : status.label;
  return (
    <li>
      <button
        type="button"
        className="rail-agent"
        aria-current={current ? "page" : undefined}
        onClick={() => openConversation(agent.id)}
      >
        <Portrait name={agent.name} figure={portraitKey(agent)} accent={agent.accent} size={32} status={agent.status} />
        <span className="rail-text">
          <span className="rail-name">{agent.name}</span>
          <span className={cx("rail-line", waiting && "is-waiting")}>{line}</span>
        </span>
      </button>
    </li>
  );
}

/** Everyone you can talk to, and your earlier chats with the agent in focus. */
export default function ConversationRail({ agentId }: { agentId: string | null }) {
  const agents = useAgents((s) => s.agents);
  const loaded = useAgents((s) => s.loaded);
  const pending = useAttention((s) => s.pending);
  const conversations = useWorkspace((s) => s.conversations);
  const currentChat = useChats((s) => (agentId ? selectThread(agentId)(s).conversationId : null));
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const now = useNow(CLOCK_MS);
  const agent = agents.find((a) => a.id === agentId);
  const earlier = conversations.filter((c) => c.agent_id === agentId);

  const reopen = (conversationId: number) => {
    if (!agentId) return;
    setError(null);
    reopenChat(agentId, conversationId).catch((e) => setError(errorMessage(e, "That chat couldn't be reopened.")));
  };

  return (
    <nav className="conversation-rail" aria-label="Conversations">
      <SectionHeader title="Agents" icon={UsersRound} as="h2" />
      {loaded ? (
        <ul className="rail-list">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              current={a.id === agentId}
              waiting={pending.some((r) => r.agentId === a.id && isQuestion(r))}
            />
          ))}
        </ul>
      ) : (
        <SkeletonRows rows={4} label="Loading agents" />
      )}

      {agent && (
        <>
          <SectionHeader title={`Earlier with ${agent.name}`} icon={History} as="h2" />
          {error && (
            <p className="rail-error" role="alert">
              {error}
            </p>
          )}
          {earlier.length === 0 ? (
            <p className="rail-empty">Chats you start with {agent.name} are kept here.</p>
          ) : (
            <ul className="rail-list">
              {earlier.map((c) => {
                const current = c.id === currentChat;
                const title = c.title.trim() || UNTITLED;
                return (
                  <li key={c.id} className="rail-chat-row">
                    <button
                      type="button"
                      className="rail-chat"
                      aria-current={current ? "true" : undefined}
                      onClick={() => !current && reopen(c.id)}
                    >
                      <span className="rail-chat-title">{title}</span>
                      <span className="rail-chat-meta">
                        {c.cwd ? `${folderName(c.project_folder || c.cwd)}, ` : ""}
                        {formatRelative(c.updated, now)}
                      </span>
                      {c.branch && <Tag>{c.branch}</Tag>}
                      {current && <Tag tone="accent">Open</Tag>}
                    </button>
                    <OverflowMenu
                      label={`More actions for ${title}`}
                      align="start"
                      items={[{ id: "delete", label: "Delete chat", icon: Trash2, danger: true, onSelect: () => setDeleting(c) }]}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      <DeleteChatDialog key={deleting?.id ?? "none"} chat={deleting} onClose={() => setDeleting(null)} />
    </nav>
  );
}
