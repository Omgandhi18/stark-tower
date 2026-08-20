import type { LightPhase } from "./types";
import { LAB_GH, LAB_GW, LAB_TILE, type LightSource } from "./labArt";

// Day/night light-map. Two low-res RGBA layers the floor composites over the
// live scene:
//   • `darkness` (NORMAL blend) — a shadow tint that thins toward each light AND
//     shifts its colour toward that light (warm lamp pools, cool reactor), so lit
//     floor reads as genuinely lit, not a pale wash.
//   • `glow` (ADDITIVE blend) — a tight bright bloom at each light's core.

export interface Lightmap { darkness: Uint8ClampedArray; glow: Uint8ClampedArray; w: number; h: number }

interface PhaseParams { baseDark: number; tint: [number, number, number]; castMax: number; bloomMul: number }
const PHASE: Record<LightPhase, PhaseParams> = {
  day: { baseDark: 0.0, tint: [0, 0, 0], castMax: 0, bloomMul: 0 },
  morning: { baseDark: 0.1, tint: [34, 28, 20], castMax: 0.15, bloomMul: 0.3 },
  evening: { baseDark: 0.4, tint: [26, 20, 34], castMax: 0.28, bloomMul: 0.5 },
  night: { baseDark: 0.6, tint: [10, 16, 34], castMax: 0.34, bloomMul: 0.75 },
};

const DS = 3; // light-map downsample (linear-filtered back up for smooth gradients)

export function renderLightmap(phase: LightPhase, sources: LightSource[]): Lightmap {
  const W = LAB_GW * LAB_TILE, H = LAB_GH * LAB_TILE;
  const w = Math.ceil(W / DS), h = Math.ceil(H / DS);
  const darkness = new Uint8ClampedArray(w * h * 4);
  const glow = new Uint8ClampedArray(w * h * 4);
  const p = PHASE[phase];
  if (p.baseDark <= 0 && p.castMax <= 0) return { darkness, glow, w, h };

  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const x = lx * DS, y = ly * DS;
      let L = 0, cr = 0, cg = 0, cb = 0, bloom = 0;
      for (const s of sources) {
        const dx = x - s.x, dy = y - s.y, d2 = dx * dx + dy * dy;
        if (d2 >= s.r * s.r) continue;
        const d = Math.sqrt(d2), f = 1 - d / s.r, c = s.i * f * f;
        L += c; cr += s.c[0] * c; cg += s.c[1] * c; cb += s.c[2] * c;
        const inner = s.r * 0.35;
        if (d < inner) bloom += s.i * (1 - d / inner);
      }
      const lit = L > 0 ? Math.min(1, L * 1.35) : 0;
      const i = (ly * w + lx) * 4;

      // darkness (normal): darken toward tint in shadow, tint toward light colour
      // where lit — alpha-weighted blend of the two so it stays smooth.
      const darkA = p.baseDark * (1 - lit);
      const castA = L > 0 ? p.castMax * lit : 0;
      const oa = Math.min(0.95, darkA + castA);
      const denom = darkA + castA || 1;
      const lcR = L > 0 ? cr / L : p.tint[0], lcG = L > 0 ? cg / L : p.tint[1], lcB = L > 0 ? cb / L : p.tint[2];
      darkness[i] = Math.round((p.tint[0] * darkA + lcR * castA) / denom);
      darkness[i + 1] = Math.round((p.tint[1] * darkA + lcG * castA) / denom);
      darkness[i + 2] = Math.round((p.tint[2] * darkA + lcB * castA) / denom);
      darkness[i + 3] = Math.round(255 * oa);

      // glow (additive): tight coloured bloom at the bulb cores
      if (bloom > 0 && p.bloomMul > 0) {
        glow[i] = Math.round(lcR); glow[i + 1] = Math.round(lcG); glow[i + 2] = Math.round(lcB);
        glow[i + 3] = Math.round(255 * Math.min(0.8, bloom * 0.5) * p.bloomMul);
      }
    }
  }
  return { darkness, glow, w, h };
}
