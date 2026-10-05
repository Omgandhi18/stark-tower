// Which agent occupies which painted station. Names are user-defined, so seating
// follows role and appearance (`figure`), never the agent's name.
import type { Agent } from "../../lib/types";
import { relativeTo, type Rect } from "./referenceAssets";
import type { Room } from "./rooms";

export interface Slot {
  id: string;
  figure: string;
  /** Painted character bounds, environment-local px. */
  hit: Rect;
  /** Top of the head, environment-local px. */
  head: { x: number; y: number };
  /** Painted in for the app: the room's mockup shows this seat empty. */
  added: boolean;
}

/** A room's stations in its own (world) px; a character's bounds default to their station's cut-out. */
export function slotsOf(room: Room): readonly Slot[] {
  return room.scene.slots.map((s) => {
    const cutout = room.scene.stations[s.id]?.cutout;
    const bounds = s.hit ?? (cutout ? room.cutouts[cutout]?.rect : undefined);
    if (!bounds) throw new Error(`The ${room.id} room's ${s.id} station has no character to click.`);
    const hit = relativeTo(bounds as unknown as Rect, room.rect);
    const head = s.head ? { x: s.head[0] - room.rect[0], y: s.head[1] - room.rect[1] } : { x: (hit[0] + hit[2]) / 2, y: hit[1] };
    return { id: s.id, figure: s.figure, hit, head, added: s.added ?? false };
  });
}

/**
 * Seat the orchestrator at their station, then each agent at the station
 * painted for its figure, then anyone left over in roster order. Maintenance
 * bots have no human station in these rooms.
 */
export function assignSlots(agents: readonly Agent[], slots: readonly Slot[], orchestratorSlot?: string): Map<string, Agent> {
  const seated = new Map<string, Agent>();
  const humans = agents.filter((a) => a.kind !== "maintenance");
  const free = (id: string) => !seated.has(id);

  const orchestrator = humans.find((a) => a.kind === "orchestrator");
  if (orchestrator && orchestratorSlot) seated.set(orchestratorSlot, orchestrator);

  const waiting: Agent[] = [];
  for (const agent of humans) {
    if (agent === orchestrator && orchestratorSlot) continue;
    const slot = slots.find((s) => s.figure === agent.figure && free(s.id));
    if (slot) seated.set(slot.id, agent);
    else waiting.push(agent);
  }
  for (const agent of waiting) {
    const slot = slots.find((s) => free(s.id));
    if (!slot) break;
    seated.set(slot.id, agent);
  }
  return seated;
}
