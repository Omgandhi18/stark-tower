// Changing an agent's model or effort from its conversation. The change shows at once, and saves
// go out one at a time, so a quick run of changes (dragging the effort along) lands in order and
// the last one wins.
import { getConfig, updateAgent } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { AgentConfig } from "../../lib/types";
import { useChats } from "../../stores/chats";
import { useConfig } from "../../stores/config";

/** Agents with a save on the way, and whether another change came in meanwhile. */
const saving = new Map<string, "busy" | "again">();

export async function saveQuickSettings(agentId: string, change: Pick<Partial<AgentConfig>, "model" | "effort">) {
  const { config, apply } = useConfig.getState();
  if (!config) return;
  apply({ ...config, agents: config.agents.map((a) => (a.id === agentId ? { ...a, ...change } : a)) });
  if (saving.has(agentId)) {
    saving.set(agentId, "again");
    return;
  }
  saving.set(agentId, "busy");
  try {
    for (;;) {
      const agent = useConfig.getState().config?.agents.find((a) => a.id === agentId);
      if (!agent) return;
      const saved = await updateAgent(agent);
      if (saving.get(agentId) === "again") {
        saving.set(agentId, "busy");
        continue;
      }
      useConfig.getState().apply(saved);
      return;
    }
  } catch (e) {
    useChats.getState().pushError(agentId, errorMessage(e, "That change couldn't be saved."));
    getConfig().then(useConfig.getState().apply, () => undefined);
  } finally {
    saving.delete(agentId);
  }
}
