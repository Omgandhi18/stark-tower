import { Maximize2, X } from "lucide-react";
import { IconButton, KeepAlive, Portrait, StatusPill } from "../../design";
import { AGENT_STATUS } from "../../lib/status";
import { useAgents, selectAgent } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import ChatPanel from "../conversation/ChatPanel";

interface EnvironmentDrawerProps {
  open: boolean;
  agentId: string | null;
  onClose: () => void;
}

/**
 * The conversation with the agent you clicked, beside the room. Every thread
 * opened this session stays mounted, so its scroll and draft survive.
 */
export default function EnvironmentDrawer({ open, agentId, onClose }: EnvironmentDrawerProps) {
  const agent = useAgents(selectAgent(agentId));
  const openChats = useNavigation((s) => s.openChats);
  const openConversation = useNavigation((s) => s.openConversation);
  const status = agent ? AGENT_STATUS[agent.status] : null;

  return (
    <aside className="env-drawer" data-open={open} aria-label={agent ? `Conversation with ${agent.name}` : "Conversation"} inert={!open}>
      {agent && status && (
        <header className="env-drawer-head">
          <Portrait name={agent.name} figure={agent.figure} accent={agent.accent} size={32} status={agent.status} />
          <span className="env-drawer-who">
            <span className="env-drawer-name">{agent.name}</span>
            <span className="env-drawer-role">{agent.role}</span>
          </span>
          <StatusPill label={status.label} tone={status.tone} icon={status.icon} live={status.busy} />
          <IconButton icon={Maximize2} label="Open the full conversation" size="sm" onClick={() => openConversation(agent.id)} />
          <IconButton icon={X} label="Close the conversation" size="sm" onClick={onClose} />
        </header>
      )}
      <div className="env-drawer-body">
        {openChats.map((id) => (
          <KeepAlive key={id} active={id === agentId}>
            <ChatPanel agentId={id} compact />
          </KeepAlive>
        ))}
      </div>
    </aside>
  );
}
