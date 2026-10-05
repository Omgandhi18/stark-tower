import { MessagesSquare } from "lucide-react";
import { EmptyState, KeepAlive } from "../../design";
import { useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import ChatPanel from "./ChatPanel";
import ConversationHeader from "./ConversationHeader";
import ConversationRail from "./ConversationRail";
import "./conversation.css";

/** Talk to one agent. Every chat opened this session stays mounted, so switching keeps your place. */
export default function ConversationScreen() {
  const agentId = useNavigation((s) => s.agentId);
  const openChats = useNavigation((s) => s.openChats);
  const agents = useAgents((s) => s.agents);
  const focused = agents.some((a) => a.id === agentId);

  return (
    <div className="conversation-screen">
      <ConversationRail agentId={agentId} />
      <section className="conversation-main" aria-label="Conversation">
        {openChats.map((id) => {
          const agent = agents.find((a) => a.id === id);
          if (!agent) return null;
          return (
            <KeepAlive key={id} active={id === agentId}>
              <div className="conversation-view">
                <ConversationHeader agent={agent} />
                <ChatPanel agentId={id} />
              </div>
            </KeepAlive>
          );
        })}
        {!focused && (
          <EmptyState
            icon={MessagesSquare}
            title="Pick someone to talk to"
            body="Choose an agent on the left. Each conversation keeps its own folder and history."
          />
        )}
      </section>
    </div>
  );
}
