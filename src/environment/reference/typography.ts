// Live text drawn over the mockup layers. Each role is sized by the cap height
// measured in the mockup (scripts/mockup-extract), and placed so its cap top
// lands on the mockup's cap top — not by eyeballed offsets.
import type { CSSProperties } from "react";
import type { Rect } from "./referenceAssets";

export interface TextRole {
  family: string;
  weight: number;
  /** Cap height in CSS px, measured from the mockup. */
  capHeight: number;
  /** CSS font-stretch, for matching the mockup's narrower letterforms. */
  stretch: string;
  letterSpacing: number;
}

const UI_FAMILY = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';
/** Every live label in mockup 04 has a 10 px cap height. */
const MOCKUP_CAP_HEIGHT = 10;
/**
 * The mockup's lettering is narrower than SF Pro at that size (its caps match
 * SF Pro at 75% width; its lowercase is narrower still). Widths below were
 * fitted to the mockup's measured ink widths for each label.
 */
const MOCKUP_STRETCH = "75%";

const role = (weight: number, letterSpacing = 0, stretch = MOCKUP_STRETCH): TextRole => ({
  family: UI_FAMILY,
  weight,
  capHeight: MOCKUP_CAP_HEIGHT,
  stretch,
  letterSpacing,
});

export const TEXT_ROLES = {
  statusValue: role(400),
  cardName: role(500),
  cardStatus: role(500, -0.85),
  cardTask: role(400, -0.55),
  controlLabel: role(500),
  badge: role(600, 0, "100%"),
} as const;

export type TextRoleId = keyof typeof TEXT_ROLES;

interface Metrics {
  fontSize: number;
  capTop: number;
}

const SAMPLE_SIZE = 100;
const CAP_GLYPH = "H";
const cache = new Map<string, Metrics>();
let canvas: HTMLCanvasElement | null = null;

/** Font size giving the role's cap height, and where the cap top sits in a 1:1 line box. */
function metricsFor(role: TextRole): Metrics {
  const key = `${role.weight}|${role.stretch}|${role.family}|${role.capHeight}`;
  const hit = cache.get(key);
  if (hit) return hit;
  canvas ??= document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return { fontSize: role.capHeight, capTop: 0 };
  ctx.font = `${role.weight} ${SAMPLE_SIZE}px ${role.family}`;
  const m = ctx.measureText(CAP_GLYPH);
  const fontSize = (role.capHeight / m.actualBoundingBoxAscent) * SAMPLE_SIZE;
  const scale = fontSize / SAMPLE_SIZE;
  const ascent = m.fontBoundingBoxAscent * scale;
  const descent = m.fontBoundingBoxDescent * scale;
  const baseline = (fontSize - (ascent + descent)) / 2 + ascent;
  const metrics = { fontSize, capTop: baseline - role.capHeight };
  cache.set(key, metrics);
  return metrics;
}

/** Font properties for `role` without placement (for centred labels such as badges). */
export function fontStyle(roleId: TextRoleId): CSSProperties {
  const role = TEXT_ROLES[roleId];
  const { fontSize } = metricsFor(role);
  return {
    fontFamily: role.family,
    fontWeight: role.weight,
    fontStretch: role.stretch,
    fontSize,
    letterSpacing: role.letterSpacing,
  };
}

/** Absolute style placing `role` text so its cap top-left matches `rect`. */
export function textStyle(roleId: TextRoleId, rect: Rect, color: string): CSSProperties {
  const role = TEXT_ROLES[roleId];
  const { fontSize, capTop } = metricsFor(role);
  return {
    position: "absolute",
    left: rect[0],
    top: rect[1] - capTop,
    fontFamily: role.family,
    fontWeight: role.weight,
    fontStretch: role.stretch,
    fontSize,
    lineHeight: `${fontSize}px`,
    letterSpacing: role.letterSpacing,
    color,
    whiteSpace: "nowrap",
  };
}
