// Creating and checking agent configurations before they are saved.
import type { AgentConfig, AppConfig } from "../../lib/types";
import { ACCENTS, FIGURES, isHexColor } from "./appearance";

/** Free desk tiles on the legacy floor grid; still stored with every agent. */
const DESKS: ReadonlyArray<readonly [number, number]> = [
  [2, 13],
  [5, 13],
  [11, 13],
  [14, 13],
  [2, 16],
  [5, 16],
  [8, 16],
  [11, 16],
  [14, 16],
];
const FALLBACK_DESK = [8, 8] as const;

export const NEW_AGENT_NAME = "New agent";

/** A ready-to-edit worker: an unused look, colour and desk, on the first enabled provider. */
export function newAgentConfig(config: AppConfig, now = Date.now()): AgentConfig {
  const taken = new Set(config.agents.map((a) => `${a.home_x},${a.home_y}`));
  const desk = DESKS.find(([x, y]) => !taken.has(`${x},${y}`)) ?? FALLBACK_DESK;
  const usedFigures = new Set(config.agents.map((a) => a.figure));
  const usedAccents = new Set(config.agents.map((a) => a.accent?.toLowerCase()));
  return {
    id: `agent-${now.toString(36)}`,
    name: NEW_AGENT_NAME,
    role: "Specialist",
    kind: "worker",
    accent: ACCENTS.find((c) => !usedAccents.has(c)) ?? ACCENTS[0],
    figure: FIGURES.find((f) => !usedFigures.has(f.id))?.id ?? FIGURES[FIGURES.length - 1].id,
    engine: config.engines.find((e) => e.enabled)?.id ?? config.engines[0]?.id ?? "",
    model: "",
    personality: "",
    home_x: desk[0],
    home_y: desk[1],
    enabled: true,
  };
}

export interface AgentProblems {
  name?: string;
  accent?: string;
  engine?: string;
}

/** What has to be fixed before a draft can be saved (empty when it's fine). */
export function validateAgent(draft: AgentConfig, config: AppConfig): AgentProblems {
  const problems: AgentProblems = {};
  const name = draft.name.trim();
  if (!name) problems.name = "Give the agent a name.";
  else if (config.agents.some((a) => a.id !== draft.id && a.name.trim().toLowerCase() === name.toLowerCase()))
    problems.name = "Another agent already has this name.";
  if (draft.accent && !isHexColor(draft.accent)) problems.accent = "Use a colour like #4fd0ff.";
  if (!config.engines.some((e) => e.id === draft.engine)) problems.engine = "Choose a provider.";
  return problems;
}

export const hasProblems = (problems: AgentProblems) => Object.keys(problems).length > 0;

/** The fields the editor changes; anything else is carried through untouched. */
const EDITABLE: ReadonlyArray<keyof AgentConfig> = [
  "name",
  "role",
  "accent",
  "figure",
  "engine",
  "model",
  "personality",
  "enabled",
  "helpers",
  "helper_model",
  "tone",
];

/** Unset switches read as on, as the backend defaults them. */
const DEFAULT_ON: ReadonlyArray<keyof AgentConfig> = ["enabled", "helpers"];

/** A field's value for comparing drafts; structured ones (the tone dials) compare by content. */
const valueOf = (agent: AgentConfig, key: keyof AgentConfig) => {
  const value = agent[key] ?? (DEFAULT_ON.includes(key) ? true : "");
  return typeof value === "object" ? JSON.stringify(value) : value;
};

export const isDirty = (draft: AgentConfig, saved: AgentConfig | undefined) => !saved || EDITABLE.some((key) => valueOf(draft, key) !== valueOf(saved, key));
