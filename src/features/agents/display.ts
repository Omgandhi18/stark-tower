import type { AppConfig } from "../../lib/types";

/** The provider an agent runs on, as the developer named it ("Claude Code"). */
export function engineLabel(engineId: string, config: AppConfig | null): string {
  return config?.engines.find((e) => e.id === engineId)?.label ?? engineId;
}

/** The provider and, when one is set, the model: "Claude Code · sonnet". */
export function providerLabel(agentId: string, engineId: string, config: AppConfig | null): string {
  const engine = config?.engines.find((e) => e.id === engineId);
  const model = config?.agents.find((a) => a.id === agentId)?.model?.trim() || engine?.model?.trim();
  const provider = engine?.label ?? engineId;
  return model ? `${provider} · ${model}` : provider;
}
