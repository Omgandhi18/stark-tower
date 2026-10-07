import { useState } from "react";
import { History, Trash2 } from "lucide-react";
import { OverflowMenu, SectionHeader, Tag } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import type { Agent, Conversation } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useNavigation } from "../../stores/navigation";
import { folderName, useWorkspace } from "../../stores/workspace";
import { openChatTask } from "../conversation/chatActions";
import DeleteChatDialog from "../conversation/DeleteChatDialog";

const CLOCK_MS = 60_000;
/** Chats listed before "Show all". */
const SHOWN_CHATS = 5;
const UNTITLED = "Untitled chat";

interface EarlierChatsProps {
  agentId: string;
  agent: Agent | undefined;
  /** The chat this page shows. */
  shownChat: number | null;
}

/** The owner's chats in every project, newest first. Each opens here, as its task. */
export default function EarlierChats({ agentId, agent, shownChat }: EarlierChatsProps) {
  const conversations = useWorkspace((s) => s.conversations);
  const openTask = useNavigation((s) => s.openTask);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const now = useNow(CLOCK_MS);
  const name = agent?.name ?? agentId;
  // Delegations run in chats of their own; those belong to the task that asked for them.
  const chats = conversations.filter((c) => c.agent_id === agentId && !c.delegated);
  const shown = showAll ? chats : chats.slice(0, SHOWN_CHATS);

  const open = async (chat: Conversation) => {
    setError(null);
    try {
      openTask(await openChatTask(chat));
    } catch (e) {
      setError(errorMessage(e, "That chat couldn't be opened."));
    }
  };

  return (
    <section className="earlier-chats" aria-label={`Earlier with ${name}`}>
      <SectionHeader title={`Earlier with ${name}`} icon={History} as="h2" />
      {error && (
        <p className="earlier-error" role="alert">
          {error}
        </p>
      )}
      {chats.length === 0 ? (
        <p className="earlier-empty">Chats you start with {name} are kept here.</p>
      ) : (
        <ul className="earlier-list">
          {shown.map((chat) => {
            const current = chat.id === shownChat;
            const title = chat.title.trim() || UNTITLED;
            return (
              <li key={chat.id} className="earlier-row">
                <button
                  type="button"
                  className="earlier-chat"
                  aria-current={current ? "page" : undefined}
                  onClick={() => {
                    if (!current) void open(chat);
                  }}
                >
                  <span className="earlier-title">{title}</span>
                  <span className="earlier-meta">
                    {chat.cwd ? `${folderName(chat.project_folder || chat.cwd)}, ` : ""}
                    {formatRelative(chat.updated, now)}
                  </span>
                  {chat.branch && <Tag>{chat.branch}</Tag>}
                  {current && <Tag tone="accent">Open</Tag>}
                </button>
                <OverflowMenu
                  label={`Chat actions for ${title}`}
                  align="start"
                  items={[{ id: "delete", label: "Delete chat", icon: Trash2, danger: true, onSelect: () => setDeleting(chat) }]}
                />
              </li>
            );
          })}
          {chats.length > SHOWN_CHATS && (
            <li>
              <button type="button" className="earlier-more" onClick={() => setShowAll((all) => !all)}>
                {showAll ? "Show fewer" : `Show all ${chats.length} chats`}
              </button>
            </li>
          )}
        </ul>
      )}
      <DeleteChatDialog key={deleting?.id ?? "none"} chat={deleting} onClose={() => setDeleting(null)} />
    </section>
  );
}
