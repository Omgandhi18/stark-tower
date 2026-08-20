import type { AgentStatus } from "./types";
import { PALETTE, hex } from "./tokens";

// Numeric palette for the Pixi floor — derived from the single source in
// tokens.ts (so it can never drift from the CSS vars). Steel / graphite,
// "Ambient Lab" direction.
export const COLORS = {
  bg: hex(PALETTE.void),
  floor: hex(PALETTE.floor),
  floorAlt: hex(PALETTE.floorAlt),
  seam: hex(PALETTE.seam),
  wall: hex(PALETTE.wall),
  reactorCore: hex(PALETTE.reactor),
  reactorGlow: hex(PALETTE.reactorDim),
  gold: hex(PALETTE.gold),
  danger: hex(PALETTE.danger),
  text: hex(PALETTE.text),
  textDim: hex(PALETTE.dim),
};

export const STATUS_META: Record<
  AgentStatus,
  { label: string; color: string; glyph: string }
> = {
  offline: { label: "Offline", color: PALETTE.dim, glyph: "○" },
  idle: { label: "Standby", color: PALETTE.ok, glyph: "●" },
  thinking: { label: "Thinking", color: PALETTE.reactor, glyph: "…" },
  working: { label: "Working", color: PALETTE.working, glyph: "▮" },
  blocked: { label: "Contained", color: PALETTE.danger, glyph: "!" },
};

export const TILE = 28; // px per floor tile (matches labArt LAB_TILE)
