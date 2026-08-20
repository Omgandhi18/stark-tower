import type { AgentStatus } from "./types";

// Steel / graphite palette (Ambient Lab direction).
export const COLORS = {
  bg: 0x0d1116,
  floor: 0x161b21,
  floorAlt: 0x12171c,
  seam: 0x2a333d,
  wall: 0x0a0d11,
  reactorCore: 0x59cfff,
  reactorGlow: 0x3a8ba8,
  gold: 0xe8c06a,
  danger: 0xff6b78,
  text: 0xe4ebf2,
  textDim: 0x78848f,
};

export const STATUS_META: Record<
  AgentStatus,
  { label: string; color: string; glyph: string }
> = {
  offline: { label: "Offline", color: "#78848f", glyph: "○" },
  idle: { label: "Standby", color: "#6ee7b7", glyph: "●" },
  thinking: { label: "Thinking", color: "#59cfff", glyph: "…" },
  working: { label: "Working", color: "#e8c06a", glyph: "▮" },
  blocked: { label: "Contained", color: "#ff6b78", glyph: "!" },
};

export const TILE = 28; // px per floor tile (matches labArt LAB_TILE)
