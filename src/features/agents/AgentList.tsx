import { Plus } from "lucide-react";
import { portraitKey, Button, Portrait, SectionHeader, Tag, cx } from "../../design";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent, AgentConfig } from "../../lib/types";

interface AgentListProps {
  agents: readonly AgentConfig[];
  /** Live roster entries, for status. Agents that are turned off aren't in it. */
  live: readonly Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  adding: boolean;
}

const KIND_LABEL: Record<string, string> = { orchestrator: "Orchestrator", maintenance: "Maintenance" };

export default function AgentList({ agents, live, selectedId, onSelect, onAdd, adding }: AgentListProps) {
  return (
    <nav className="agent-list" aria-label="Agents">
      <SectionHeader
        title="Agents"
        count={agents.length}
        actions={
          <Button size="sm" variant="ghost" icon={Plus} onClick={onAdd} disabled={adding}>
            Add
          </Button>
        }
      />
      <ul className="agent-list-items">
        {agents.map((a) => {
          const running = live.find((l) => l.id === a.id);
          const status = running ? AGENT_STATUS[running.status] : null;
          const kind = KIND_LABEL[a.kind];
          return (
            <li key={a.id}>
              <button
                type="button"
                className={cx("agent-list-row", !a.enabled && "is-off")}
                aria-current={a.id === selectedId ? "page" : undefined}
                onClick={() => onSelect(a.id)}
              >
                <Portrait name={a.name} figure={portraitKey(a)} accent={a.accent} size={40} status={running?.status} />
                <span className="agent-list-text">
                  <span className="agent-list-name">{a.name}</span>
                  <span className="agent-list-role">{a.role}</span>
                </span>
                {!a.enabled ? (
                  <Tag>Off</Tag>
                ) : kind ? (
                  <Tag tone="accent">{kind}</Tag>
                ) : (
                  status && <span className={cx("agent-list-state", `tone-${status.tone}`)}>{status.label}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
