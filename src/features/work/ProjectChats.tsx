import { useState } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { OverflowMenu, Portrait, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";
import { AGENT_STATUS } from "../../lib/status";
import { formatRelative } from "../../lib/time";
import type { Conversation } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { selectThread, useChats } from "../../stores/chats";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import { reopenChat, startNewChat } from "../conversation/chatActions";
import DeleteChatDialog from "../conversation/DeleteChatDialog";
import { sameFolder } from "./projects";

const CLOCK_MS = 60_000;
/** Chats listed before "Show all". */
const SHOWN_CHATS = 5;
const UNTITLED = "Untitled chat";

/**
 * The developer's chats in a project, newest first. Each keeps its session until a new
 * chat is started; requests from Work continue the latest one with that agent.
 */
export default function ProjectChats({ path, name }: { path: string; name: string }) {
  const conversations = useWorkspace((s) => s.conversations);
  const agents = useAgents((s) => s.agents);
  const route = useNavigation((s) => s.route);
  const openConversation = useNavigation((s) => s.openConversation);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const now = useNow(CLOCK_MS);
  // Delegations run in chats of their own; those belong to the task that asked for them.
  const chats = conversations.filter((c) => !c.delegated && sameFolder(c.cwd, path));
  const shown = showAll ? chats : chats.slice(0, SHOWN_CHATS);
  const lead = agents.find((a) => a.kind === "orchestrator") ?? agents.find((a) => a.kind !== "maintenance");
  const openChatId = (agentId: string) => selectThread(agentId)(useChats.getState()).conversationId;

  const open = (chat: Conversation) => {
    setError(null);
    const agent = agents.find((a) => a.id === chat.agent_id);
    if (chat.id === openChatId(chat.agent_id)) {
      openConversation(chat.agent_id);
      return;
    }
    // Switching chats ends the agent's session, so never mid-task.
    if (agent && AGENT_STATUS[agent.status].busy) {
      setError(`${agent.name} is working in another chat. Open this one when they're done.`);
      return;
    }
    reopenChat(chat.agent_id, chat.id)
      .then(() => openConversation(chat.agent_id))
      .catch((e) => setError(errorMessage(e, "That chat couldn't be opened.")));
  };

  const startChat = () => {
    if (!lead) return;
    setError(null);
    if (AGENT_STATUS[lead.status].busy) {
      setError(`${lead.name} is working right now. Start a new chat when they're done.`);
      return;
    }
    startNewChat(lead.id, path)
      .then(() => openConversation(lead.id))
      .catch((e) => setError(errorMessage(e, "A new chat couldn't be started.")));
  };

  return (
    <ul className="nav-chats" aria-label={`Chats in ${name}`}>
      {shown.map((chat) => {
        const agent = agents.find((a) => a.id === chat.agent_id);
        const who = agent?.name ?? chat.agent_id;
        const current = route === "conversation" && openChatId(chat.agent_id) === chat.id;
        const title = chat.title || UNTITLED;
        return (
          <li key={chat.id} className="nav-sub-row">
            <button
              type="button"
              className={cx("nav-chat", current && "is-current")}
              title={`${chat.title || UNTITLED}\n${who} · ${formatRelative(chat.updated, now)}`}
              onClick={() => open(chat)}
            >
              <Portrait name={who} figure={agent?.figure} accent={agent?.accent} size={20} />
              <span className="nav-sub-label">{title}</span>
            </button>
            <OverflowMenu
              label={`More actions for ${title}`}
              align="start"
              items={[{ id: "delete", label: "Delete chat", icon: Trash2, danger: true, onSelect: () => setDeleting(chat) }]}
            />
          </li>
        );
      })}
      {chats.length > SHOWN_CHATS && (
        <li>
          <button type="button" className="nav-chats-more" onClick={() => setShowAll((all) => !all)}>
            {showAll ? "Show fewer" : `Show all ${chats.length} chats`}
          </button>
        </li>
      )}
      {lead && (
        <li>
          <button type="button" className="nav-chat is-quiet" onClick={startChat}>
            <MessageSquarePlus aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            <span className="nav-sub-label">New chat</span>
          </button>
        </li>
      )}
      {error && (
        <li>
          <p className="nav-sub-error" role="alert">
            {error}
          </p>
        </li>
      )}
      <DeleteChatDialog key={deleting?.id ?? "none"} chat={deleting} onClose={() => setDeleting(null)} />
    </ul>
  );
}
