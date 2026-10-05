// Which agent occupies which painted station. Names are user-defined, so seating
// follows role and appearance (`figure`), never the agent's name.
import type { Agent } from "../../lib/types";
import { ENVIRONMENT_RECT, relativeTo, type Rect } from "./referenceAssets";
import scene from "./rnd-scene.json";

export interface Slot {
  id: string;
  figure: string;
  /** Painted character bounds, environment-local px. */
  hit: Rect;
  /** Top of the head, environment-local px. */
  head: { x: number; y: number };
}

const ORCHESTRATOR_SLOT = "commandDeck";

export const SLOTS: readonly Slot[] = scene.slots.map((s) => ({
  id: s.id,
  figure: s.figure,
  hit: relativeTo(s.hit as unknown as Rect, ENVIRONMENT_RECT),
  head: { x: s.head[0] - ENVIRONMENT_RECT[0], y: s.head[1] - ENVIRONMENT_RECT[1] },
}));

export const slotById = (id: string) => SLOTS.find((s) => s.id === id);

/**
 * Seat the orchestrator at the command deck, then each agent at the station
 * painted for its figure, then anyone left over in roster order. Maintenance
 * bots have no human station in this environment.
 */
export function assignSlots(agents: readonly Agent[]): Map<string, Agent> {
  const seated = new Map<string, Agent>();
  const humans = agents.filter((a) => a.kind !== "maintenance");
  const free = (id: string) => !seated.has(id);

  const orchestrator = humans.find((a) => a.kind === "orchestrator");
  if (orchestrator) seated.set(ORCHESTRATOR_SLOT, orchestrator);

  const waiting: Agent[] = [];
  for (const agent of humans) {
    if (agent === orchestrator) continue;
    const slot = SLOTS.find((s) => s.figure === agent.figure && free(s.id));
    if (slot) seated.set(slot.id, agent);
    else waiting.push(agent);
  }
  for (const agent of waiting) {
    const slot = SLOTS.find((s) => free(s.id));
    if (!slot) break;
    seated.set(slot.id, agent);
  }
  return seated;
}
