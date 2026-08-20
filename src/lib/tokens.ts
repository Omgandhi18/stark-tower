// The single source of truth for the Stark Tower palette. It is consumed in two
// formats:
//   • CSS custom properties (`--void`, `--reactor`, …) in App.css :root — those
//     MUST mirror CSS_TOKENS below; assertTokensInSync() checks it in dev.
//   • numeric 0xRRGGBB for the Pixi floor, via hex() / the derived COLORS in
//     theme.ts.
// Change a colour here (and the matching App.css :root var) — never in theme.ts
// or a component directly.

export const PALETTE = {
  // surfaces
  void: "#0e1114",
  panel: "#151a1f",
  panel2: "#1a2027",
  inset: "#11151a",
  line: "#242c34",
  lineSoft: "#1b2127",
  // ink
  text: "#e4ebf2",
  text2: "#aeb9c4",
  dim: "#78848f",
  // accents / status
  reactor: "#59cfff",
  reactorDim: "#3a8ba8",
  ok: "#6ee7b7",
  working: "#e8c06a",
  danger: "#ff6b78",
  // Pixi floor only (no CSS var)
  floor: "#161b21",
  floorAlt: "#12171c",
  seam: "#2a333d",
  wall: "#0a0d11",
  gold: "#e8c06a",
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** A palette hex string as a Pixi 0xRRGGBB number. */
export const hex = (h: string): number => parseInt(h.replace("#", ""), 16);

/** The subset of the palette mirrored into App.css :root (CSS var → key). */
export const CSS_TOKENS: Record<string, PaletteKey> = {
  "--void": "void",
  "--panel": "panel",
  "--panel-2": "panel2",
  "--inset": "inset",
  "--line": "line",
  "--line-soft": "lineSoft",
  "--text": "text",
  "--text-2": "text2",
  "--dim": "dim",
  "--reactor": "reactor",
  "--reactor-dim": "reactorDim",
  "--ok": "ok",
  "--working": "working",
  "--danger": "danger",
};

/**
 * Dev-only drift check: warn if any App.css :root palette var no longer matches
 * PALETTE, so the two formats can't silently diverge (they already had once).
 */
export function assertTokensInSync(): void {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") {
    return;
  }
  const root = getComputedStyle(document.documentElement);
  for (const [cssVar, key] of Object.entries(CSS_TOKENS)) {
    const css = root.getPropertyValue(cssVar).trim().toLowerCase();
    const want = PALETTE[key].toLowerCase();
    if (css && css !== want) {
      console.warn(
        `[tokens] ${cssVar} = ${css} but PALETTE.${key} = ${want} — update App.css :root or tokens.ts so they match.`,
      );
    }
  }
}
