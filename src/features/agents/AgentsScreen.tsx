import { useState } from "react";
import { UsersRound } from "lucide-react";
import { EmptyState, SkeletonRows } from "../../design";
import { updateAgent } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useAgents } from "../../stores/agents";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import AgentEditor from "./AgentEditor";
import AgentList from "./AgentList";
import { newAgentConfig } from "./agentDraft";
import "./agents.css";

/** The roster: everyone you can give work to, and how each is set up. */
export default function AgentsScreen() {
  const config = useConfig((s) => s.config);
  const configError = useConfig((s) => s.error);
  const apply = useConfig((s) => s.apply);
  const live = useAgents((s) => s.agents);
  const focusedId = useNavigation((s) => s.agentId);
  const focusAgent = useNavigation((s) => s.focusAgent);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!config) {
    return (
      <div className="agents-screen">
        {configError ? (
          <EmptyState icon={UsersRound} title="The roster couldn't be loaded" body={configError} />
        ) : (
          <SkeletonRows rows={5} label="Loading agents" className="agents-loading" />
        )}
      </div>
    );
  }

  const selected = config.agents.find((a) => a.id === focusedId) ?? config.agents[0];

  const add = async () => {
    setAdding(true);
    setError(null);
    const created = newAgentConfig(config);
    try {
      apply(await updateAgent(created));
      focusAgent(created.id);
    } catch (e) {
      setError(errorMessage(e, "A new agent couldn't be added."));
    } finally {
      setAdding(false);
    }
  };

  return (
    <div className="agents-screen">
      <div className="agents-rail">
        <AgentList agents={config.agents} live={live} selectedId={selected?.id ?? null} onSelect={focusAgent} onAdd={add} adding={adding} />
        {error && (
          <p className="agents-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {selected ? (
        <AgentEditor
          key={selected.id}
          saved={selected}
          config={config}
          live={live.find((a) => a.id === selected.id)}
          onRemoved={() => {
            const next = config.agents.find((a) => a.id !== selected.id);
            if (next) focusAgent(next.id);
          }}
        />
      ) : (
        <EmptyState icon={UsersRound} title="No agents yet" body="Add an agent to give work to." />
      )}
    </div>
  );
}
