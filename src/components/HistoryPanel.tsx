import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Plus, MessageSquare } from "lucide-react";
import type { Agent, Conversation } from "../lib/types";
import { listConversations, onConversationsChanged } from "../lib/api";

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onOpen: (conversationId: number, agentId: string) => void;
  onNew: (agentId: string) => void;
}

/** Saved chats: browse every past conversation and reopen (resume) one, or start
 *  a fresh chat with the selected agent. */
export default function HistoryPanel({ agents, selectedId, onOpen, onNew }: Props) {
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const reload = () => {
      listConversations().then(setConvs).catch(() => {});
    };
    reload();
    const unsub = onConversationsChanged(reload);
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  const nameOf = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? id.toUpperCase();

  return (
    <div className={`ov ov-history glass ${open ? "open" : ""}`}>
      <button className="ov-roster-head" onClick={() => setOpen((o) => !o)}>
        <span className="label">Chats</span>
        <span className="ov-roster-meta">
          <span className="label">{convs.length}</span>
          <span className="chev">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
      </button>
      {open && (
        <div className="history-list">
          {selectedId && (
            <button className="history-new" onClick={() => onNew(selectedId)}>
              <Plus size={13} /> New chat with {nameOf(selectedId)}
            </button>
          )}
          {convs.length === 0 && <div className="tasks-empty">No saved chats yet.</div>}
          {convs.map((c) => (
            <button
              key={c.id}
              className="history-row"
              onClick={() => onOpen(c.id, c.agent_id)}
              title={c.title}
            >
              <MessageSquare size={12} className="history-icon" />
              <span className="history-title">{c.title}</span>
              <span className="history-agent">{nameOf(c.agent_id)}</span>
              <span className="history-ago">{ago(c.updated)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
