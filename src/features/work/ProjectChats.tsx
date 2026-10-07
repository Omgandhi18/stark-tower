import { useState } from "react";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import { portraitKey, OverflowMenu, Portrait, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { taskForChat } from "../../lib/api";
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
 * The developer's chats in a project, newest first. Each opens as its task, with the work's
 * status, permissions and side panel around the conversation. Each keeps its session until
 * a new chat is started; requests from Work continue the latest one with that agent.
 */
export default function ProjectChats({ path, name }: { path: string; name: string }) {
  const conversations = useWorkspace((s) => s.conversations);
  const agents = useAgents((s) => s.agents);
  const route = useNavigation((s) => s.route);
  const openTask = useNavigation((s) => s.openTask);
  const shownTask = useNavigation((s) => s.taskId);
  const shownChat = useWorkspace((s) => s.tasks.find((t) => t.id === shownTask)?.conversation_id ?? null);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const now = useNow(CLOCK_MS);
  // Delegations run in chats of their own; those belong to the task that asked for them.
  const chats = conversations.filter((c) => !c.delegated && sameFolder(c.project_folder || c.cwd, path));
  const shown = showAll ? chats : chats.slice(0, SHOWN_CHATS);
  const lead = agents.find((a) => a.kind === "orchestrator") ?? agents.find((a) => a.kind !== "maintenance");
  const openChatId = (agentId: string) => selectThread(agentId)(useChats.getState()).conversationId;

  const open = async (chat: Conversation) => {
    setError(null);
    const agent = agents.find((a) => a.id === chat.agent_id);
    try {
      // It becomes the agent's chat when they're free, so you can talk in it at once. Switching
      // ends their session, so never mid-task: then the page shows it until you pick it back up.
      if (chat.id !== openChatId(chat.agent_id) && !(agent && AGENT_STATUS[agent.status].busy)) await reopenChat(chat.agent_id, chat.id);
      openTask((await taskForChat(chat.id)).id);
    } catch (e) {
      setError(errorMessage(e, "That chat couldn't be opened."));
    }
  };

  const startChat = async () => {
    if (!lead) return;
    setError(null);
    if (AGENT_STATUS[lead.status].busy) {
      setError(`${lead.name} is working right now. Start a new chat when they're done.`);
      return;
    }
    try {
      await startNewChat(lead.id, path);
      const chat = openChatId(lead.id);
      if (chat === null) throw new Error("The new chat didn't open.");
      openTask((await taskForChat(chat)).id);
    } catch (e) {
      setError(errorMessage(e, "A new chat couldn't be started."));
    }
  };

  return (
    <ul className="nav-chats" aria-label={`Chats in ${name}`}>
      {shown.map((chat) => {
        const agent = agents.find((a) => a.id === chat.agent_id);
        const who = agent?.name ?? chat.agent_id;
        const current = route === "task" && shownChat === chat.id;
        const title = chat.title || UNTITLED;
        return (
          <li key={chat.id} className="nav-sub-row">
            <button
              type="button"
              className={cx("nav-chat", current && "is-current")}
              title={`${chat.title || UNTITLED}\n${who} · ${formatRelative(chat.updated, now)}`}
              onClick={() => void open(chat)}
            >
              <Portrait name={who} figure={portraitKey(agent)} accent={agent?.accent} size={20} />
              <span className="nav-sub-label">{title}</span>
              {chat.branch && <Tag>{chat.branch}</Tag>}
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
          <button type="button" className="nav-chat is-quiet" onClick={() => void startChat()}>
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
