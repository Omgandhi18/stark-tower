// What the Environment's UI needs to know about a room beyond its pixels: the
// world it spans, its stations, how tall each character stands when up and
// about, whose helpers the bots are, and where the agent card goes.
import type { CSSProperties } from "react";
import type { Agent } from "../../lib/types";
import type { Point, Size } from "./camera";
import { characterArt } from "../life/characters";
import { rectHeight, rectWidth } from "./referenceAssets";
import type { CardJson, Room } from "./rooms";
import { slotsOf, type Slot } from "./slots";

export interface RoomLayout {
  world: Size;
  slots: readonly Slot[];
  orchestratorSlot?: string;
  /** How tall each station's character stands when up and about (px), so they can be clicked while they walk. */
  heights: Readonly<Record<string, number>>;
  /** Whose helpers the bots stand for; null for everyone's. */
  helperSlot: string | null;
  /** Every painted helper (and the "+1" badge where one is painted): the mockup's state. */
  referenceHelpers: number;
  /** The station whose card the mockup shows; reference mode frames it. */
  referenceSlot: Slot;
  card: CardJson;
}

export function layoutOf(room: Room): RoomLayout {
  const slots = slotsOf(room);
  const heights: Record<string, number> = {};
  for (const slot of slots) {
    const art = characterArt(room.folder, slot.figure);
    if (art) heights[slot.id] = art.json.height;
  }
  return {
    world: { width: rectWidth(room.rect), height: rectHeight(room.rect) },
    slots,
    orchestratorSlot: room.scene.orchestratorSlot,
    heights,
    helperSlot: room.scene.helperSlot ?? null,
    referenceHelpers: room.scene.helpers.length,
    referenceSlot: slots.find((s) => s.id === room.scene.card.slot) ?? slots[0],
    card: room.scene.card,
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** The agent card's position in the view: beside `head` (screen px), or docked in the room's corner. */
export function cardPlacement(card: CardJson, head: Point, view: Size, size: Size): CSSProperties {
  switch (card.anchor) {
    case "head":
      return {
        left: clamp(head.x + card.offset[0], 0, view.width - size.width),
        top: clamp(head.y + card.offset[1], 0, view.height - size.height),
      };
    case "top-right":
      return { right: card.inset[0], top: card.inset[1] };
    case "bottom-left":
      return { left: card.inset[0], bottom: card.inset[1] };
  }
}

/** How many helpers the room's bots stand for: one station's agent's, or everyone's where the room doesn't say whose. */
export function helpersShown(helperSlot: string | null, seats: ReadonlyMap<string, Agent>, helpers: Readonly<Record<string, number>>): number {
  const running = (agent: Agent | undefined) => (agent ? (helpers[agent.id] ?? 0) : 0);
  if (helperSlot) return running(seats.get(helperSlot));
  return [...seats.values()].reduce((sum, agent) => sum + running(agent), 0);
}
