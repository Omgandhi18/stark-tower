// Procedural sci-fi lab facility — floor tiles, walls, and furniture drawn in
// code (commercial-safe, no tileset). A single `renderFloor()` composes the whole
// static facility (reactor bay, command consoles, meeting room, server room, a
// desk bullpen, fabrication bay, canteen, containment lab, corridors + décor)
// into one RGBA buffer that StarkFloor turns into a nearest-neighbor texture.

export const LAB_TILE = 28;
export const LAB_GW = 30;
export const LAB_GH = 20;

/** Bullpen desk tiles [tx,ty]. The first six seat the default roster; the rest
 *  are ambient (and a pool for newly-added agents). */
export const BULLPEN_DESKS: [number, number][] = [
  [2, 10], [5, 10], [8, 10], [11, 10], [14, 10],
  [2, 13], [5, 13], [8, 13], [11, 13], [14, 13],
  [2, 16], [5, 16], [8, 16], [11, 16], [14, 16],
];

/** Ceiling-lamp tiles (fixtures + warm light sources at night). Placed in aisles
 *  and along edges — off the agents/desks — for even coverage with no dark corners. */
const LAMP_TILES: [number, number][] = [
  [1, 1], [7, 1],                                        // reactor bay: top corners
  [10, 1], [18, 1], [10, 6], [18, 6],                    // meeting: corners
  [22, 1], [22, 6],                                      // server: center column (sparse room)
  [3, 8], [13, 8],                                       // bullpen: top (sides, no centre column)
  [3, 12], [13, 12],                                     // bullpen: aisle
  [3, 15], [13, 15],                                     // bullpen: aisle
  [3, 18], [13, 18],                                     // bullpen: bottom
  [23, 8], [19, 11], [24, 11],                           // canteen: sides
  [19, 15], [24, 15],                                    // containment: sides (sparse room)
];

type RGB = [number, number, number];
export interface Buf { w: number; h: number; d: Uint8ClampedArray }

/** A light source for the day/night light-map (world-pixel coords). */
export interface LightSource { x: number; y: number; r: number; c: RGB; i: number }

const C = {
  bg: [12, 15, 20] as RGB,
  floor: [48, 56, 68] as RGB, floorB: [43, 51, 62] as RGB, seam: [30, 36, 45] as RGB, rivet: [66, 78, 92] as RGB, inlay: [64, 150, 180] as RGB,
  grate: [40, 47, 58] as RGB, grateLine: [54, 64, 78] as RGB,
  wall: [58, 66, 80] as RGB, wallHi: [78, 88, 105] as RGB, wallLo: [30, 35, 44] as RGB, strip: [70, 210, 255] as RGB,
  part: [50, 57, 70] as RGB, partHi: [70, 80, 98] as RGB, partLo: [30, 35, 44] as RGB,
  metal: [44, 50, 62] as RGB, metalHi: [64, 72, 88] as RGB, metalLo: [30, 34, 43] as RGB, metalD: [24, 28, 36] as RGB,
  screen: [16, 24, 34] as RGB, glow: [90, 210, 255] as RGB, amber: [235, 195, 95] as RGB, green: [120, 225, 150] as RGB,
  red: [255, 95, 105] as RGB, white: [226, 232, 240] as RGB, dark: [18, 22, 28] as RGB,
  pot: [70, 60, 50] as RGB, leaf: [80, 165, 100] as RGB, leafHi: [130, 210, 140] as RGB, wood: [96, 78, 56] as RGB,
};
const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const sh = (c: RGB, f: number): RGB => [clamp(c[0] * f), clamp(c[1] * f), clamp(c[2] * f)];
const mk = (w: number, h: number): Buf => ({ w, h, d: new Uint8ClampedArray(w * h * 4) });
function px(b: Buf, x: number, y: number, c: RGB, a = 255) { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= b.w || y >= b.h) return; const i = (y * b.w + x) * 4; b.d[i] = c[0]; b.d[i + 1] = c[1]; b.d[i + 2] = c[2]; b.d[i + 3] = a; }
function rct(b: Buf, x0: number, y0: number, x1: number, y1: number, c: RGB, a = 255) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(b, x, y, c, a); }
function outline(b: Buf, col: RGB = [10, 13, 18]) { const pts: [number, number][] = []; const A = (x: number, y: number) => (x < 0 || y < 0 || x >= b.w || y >= b.h ? 0 : b.d[(y * b.w + x) * 4 + 3]); for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) { if (A(x, y) !== 0) continue; if (A(x + 1, y) > 200 || A(x - 1, y) > 200 || A(x, y + 1) > 200 || A(x, y - 1) > 200) pts.push([x, y]); } for (const [x, y] of pts) px(b, x, y, col); }
function blit(dst: Buf, src: Buf, ox: number, oy: number) { ox = Math.round(ox); oy = Math.round(oy); for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) { const a = src.d[(y * src.w + x) * 4 + 3]; if (!a) continue; const dx = ox + x, dy = oy + y; if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue; const i = (dy * dst.w + dx) * 4, af = a / 255; dst.d[i] = clamp(src.d[(y * src.w + x) * 4] * af + dst.d[i] * (1 - af)); dst.d[i + 1] = clamp(src.d[(y * src.w + x) * 4 + 1] * af + dst.d[i + 1] * (1 - af)); dst.d[i + 2] = clamp(src.d[(y * src.w + x) * 4 + 2] * af + dst.d[i + 2] * (1 - af)); dst.d[i + 3] = 255; } }

const T = LAB_TILE;
function floorTile(kind: string): Buf {
  const b = mk(T, T);
  const base = kind === "grate" ? C.grate : (kind === "alt" ? C.floorB : C.floor);
  rct(b, 0, 0, T - 1, T - 1, base);
  // bevel: bright top/left edge, shaded bottom/right → panels read cleanly
  rct(b, 1, 1, T - 2, 1, sh(base, 1.14));
  rct(b, 1, 1, 1, T - 2, sh(base, 1.14));
  rct(b, 1, T - 2, T - 2, T - 2, sh(base, 0.82));
  rct(b, T - 2, 1, T - 2, T - 2, sh(base, 0.82));
  for (let x = 0; x < T; x++) { px(b, x, 0, C.seam); px(b, x, T - 1, C.seam); }
  for (let y = 0; y < T; y++) { px(b, 0, y, C.seam); px(b, T - 1, y, C.seam); }
  if (kind === "grate") for (let y = 5; y < T - 4; y += 3) rct(b, 4, y, T - 5, y, C.grateLine);
  else if (kind === "alt") for (const [ox, oy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]] as const) px(b, T / 2 + ox, T / 2 + oy, C.inlay, ox || oy ? 70 : 150);
  else for (const [rx, ry] of [[3, 3], [T - 4, 3], [3, T - 4], [T - 4, T - 4]] as const) px(b, rx, ry, C.rivet);
  if (kind === "walk") rct(b, T / 2 - 1, 2, T / 2, T - 3, C.strip, 40);
  return b;
}
function wallTop(): Buf { const b = mk(T, 34); rct(b, 0, 0, T - 1, 33, C.wall); rct(b, 0, 0, T - 1, 2, C.wallHi); rct(b, 0, 11, T - 1, 13, C.strip, 190); rct(b, 0, 12, T - 1, 12, sh(C.strip, 1.3), 230); rct(b, 0, 28, T - 1, 33, C.wallLo); for (let x = 4; x < T; x += 7) rct(b, x, 4, x, 9, C.wallLo, 120); return b; }
function wallSide(): Buf { const b = mk(7, T); rct(b, 0, 0, 6, T - 1, C.wall); rct(b, 0, 0, 1, T - 1, C.wallHi); rct(b, 5, 0, 6, T - 1, C.wallLo); rct(b, 3, 0, 3, T - 1, C.strip, 110); return b; }
function partH(): Buf { const b = mk(T, 12); rct(b, 0, 2, T - 1, 9, C.part); rct(b, 0, 2, T - 1, 3, C.partHi); rct(b, 0, 8, T - 1, 9, C.partLo); rct(b, 0, 5, T - 1, 5, C.strip, 130); return b; }
function partV(): Buf { const b = mk(12, T); rct(b, 2, 0, 9, T - 1, C.part); rct(b, 2, 0, 3, T - 1, C.partHi); rct(b, 8, 0, 9, T - 1, C.partLo); rct(b, 5, 0, 5, T - 1, C.strip, 130); return b; }

function workstation(): Buf { const b = mk(56, 46); rct(b, 4, 22, 51, 40, C.metal); rct(b, 4, 22, 51, 24, C.metalHi); rct(b, 4, 38, 51, 40, C.metalLo); rct(b, 7, 40, 10, 45, C.metalLo); rct(b, 45, 40, 48, 45, C.metalLo); rct(b, 26, 18, 29, 23, C.metalLo); rct(b, 15, 4, 40, 20, sh(C.metal, 0.8)); rct(b, 17, 6, 38, 18, C.screen); for (let i = 0; i < 5; i++) rct(b, 19, 8 + i * 2, 19 + (i % 2 ? 13 : 8), 8 + i * 2, C.glow, 200); rct(b, 15, 4, 40, 5, sh(C.glow, 0.5), 110); rct(b, 19, 32, 36, 37, sh(C.metal, 0.85)); rct(b, 40, 33, 44, 36, sh(C.metal, 0.9)); outline(b); return b; }
function chair(): Buf { const b = mk(20, 22); rct(b, 4, 6, 15, 16, C.metalD); rct(b, 4, 6, 15, 7, C.metal); rct(b, 5, 2, 14, 6, sh(C.metalD, 0.85)); rct(b, 8, 16, 11, 20, C.metalLo); outline(b); return b; }
function serverRack(): Buf { const b = mk(30, 54); rct(b, 3, 3, 26, 51, C.metalLo); rct(b, 3, 3, 26, 4, C.metalHi); for (let r = 0; r < 8; r++) { const y = 7 + r * 5; rct(b, 6, y, 23, y + 3, sh(C.metal, 0.7)); px(b, 8, y + 1, r % 3 ? C.green : C.amber); px(b, 10, y + 1, C.green, 200); rct(b, 19, y + 1, 22, y + 2, C.dark); } outline(b); return b; }
function plant(): Buf { const b = mk(26, 38); rct(b, 8, 27, 18, 36, C.pot); rct(b, 8, 27, 18, 28, sh(C.pot, 1.2)); for (const [lx, ly] of [[13, 9], [8, 15], [18, 15], [11, 19], [15, 19], [13, 23], [6, 21], [20, 21]] as const) { rct(b, lx - 2, ly, lx + 2, ly + 6, C.leaf); px(b, lx, ly, C.leafHi); } rct(b, 12, 21, 13, 29, sh(C.leaf, 0.7)); outline(b); return b; }
function crate(): Buf { const b = mk(26, 26); rct(b, 3, 6, 22, 23, C.wood); rct(b, 3, 6, 22, 7, sh(C.wood, 1.25)); rct(b, 3, 22, 22, 23, sh(C.wood, 0.7)); rct(b, 12, 6, 13, 23, sh(C.wood, 0.7)); rct(b, 3, 13, 22, 14, sh(C.wood, 0.7)); rct(b, 8, 3, 17, 6, sh(C.amber, 0.9)); outline(b); return b; }
function trashBin(): Buf { const b = mk(16, 20); rct(b, 3, 5, 12, 18, C.metalD); rct(b, 3, 5, 12, 6, C.metalHi); rct(b, 2, 3, 13, 5, C.metalLo); for (let x = 5; x < 11; x += 2) rct(b, x, 7, x, 16, C.metalLo); outline(b); return b; }
function fridge(): Buf { const b = mk(30, 44); rct(b, 4, 3, 26, 41, C.metal); rct(b, 4, 3, 26, 4, C.metalHi); rct(b, 4, 22, 26, 22, C.metalLo); rct(b, 21, 8, 23, 18, C.metalLo); rct(b, 21, 26, 23, 36, C.metalLo); rct(b, 7, 6, 12, 9, C.glow, 180); px(b, 8, 7, C.green); outline(b); return b; }
function waterCooler(): Buf { const b = mk(20, 40); rct(b, 4, 12, 15, 37, C.metal); rct(b, 4, 12, 15, 13, C.metalHi); rct(b, 6, 2, 13, 12, C.glow, 120); rct(b, 6, 2, 13, 12, sh(C.glow, 0.6), 90); px(b, 9, 20, C.strip); px(b, 10, 20, C.strip); rct(b, 8, 22, 11, 24, C.dark); outline(b); return b; }
function coffee(): Buf { const b = mk(52, 40); rct(b, 3, 20, 49, 36, C.metal); rct(b, 3, 20, 49, 21, C.metalHi); rct(b, 3, 35, 49, 36, C.metalLo); rct(b, 8, 6, 22, 22, sh(C.metal, 0.7)); rct(b, 10, 8, 20, 11, C.dark); px(b, 18, 9, C.amber); rct(b, 12, 14, 18, 20, C.dark); rct(b, 13, 18, 17, 20, sh(C.amber, 0.9)); rct(b, 30, 14, 37, 22, sh(C.metal, 0.9)); rct(b, 31, 12, 36, 14, C.dark); for (const x of [40, 45]) rct(b, x, 16, x + 3, 20, C.white); outline(b); return b; }
function fabricator(): Buf { const b = mk(46, 52); rct(b, 5, 5, 40, 47, C.metal); rct(b, 5, 5, 40, 7, C.metalHi); rct(b, 5, 45, 40, 47, C.metalLo); rct(b, 11, 11, 34, 22, C.dark); for (let i = 0; i < 3; i++) rct(b, 13, 14 + i * 3, 13 + (i % 2 ? 15 : 9), 14 + i * 3, C.glow, 200); rct(b, 9, 32, 36, 35, sh(C.strip, 1.1), 230); rct(b, 9, 31, 36, 31, sh(C.strip, 1.4), 255); rct(b, 15, 36, 30, 44, C.white); rct(b, 17, 38, 28, 38, sh(C.strip, 0.6)); px(b, 8, 8, C.green); outline(b); return b; }
function control(): Buf { const b = mk(58, 34); rct(b, 4, 12, 53, 30, C.metal); rct(b, 4, 12, 53, 13, C.metalHi); rct(b, 2, 20, 55, 30, sh(C.metal, 0.9)); rct(b, 10, 4, 26, 14, sh(C.metal, 0.8)); rct(b, 12, 6, 24, 12, C.screen); for (let i = 0; i < 3; i++) rct(b, 14, 7 + i * 2, 14 + (i % 2 ? 8 : 5), 7 + i * 2, C.glow, 200); rct(b, 30, 4, 46, 14, sh(C.metal, 0.8)); rct(b, 32, 6, 44, 12, C.screen); rct(b, 33, 7, 43, 10, C.amber, 160); for (const [x, y, c] of [[10, 24, C.green], [14, 24, C.amber], [18, 24, C.strip], [44, 24, C.red], [48, 24, C.green]] as const) rct(b, x, y, x + 1, y + 1, c); outline(b); return b; }
function holoTable(): Buf { const b = mk(90, 56); for (let y = 0; y < 56; y++) for (let x = 0; x < 90; x++) { const dx = (x - 45) / 44, dy = (y - 34) / 20; if (dx * dx + dy * dy <= 1) px(b, x, y, C.metal); } for (let x = 0; x < 90; x++) for (let y = 0; y < 56; y++) { const dx = (x - 45) / 44, dy = (y - 34) / 20; if (dx * dx + dy * dy <= 1 && (x - 45) * (x - 45) / (40 * 40) + (y - 34) * (y - 34) / (17 * 17) > 1) px(b, x, y, C.metalLo); } for (let r = 0; r < 3; r++) { const rr = 6 + r * 5; for (let d = 0; d < 360; d += 6) px(b, 45 + Math.cos(d * Math.PI / 180) * rr, 22 + Math.sin(d * Math.PI / 180) * rr * 0.5, C.strip, 150 - r * 30); } rct(b, 44, 18, 46, 26, C.strip, 200); px(b, 45, 22, C.white); outline(b); return b; }
function reactor(): Buf { const S = 92, cx = 46, cy = 46; const b = mk(S, S); const ring = (r: number, c: RGB, a: number, th = 1) => { for (let d = 0; d < 360; d += 2) { const rad = d * Math.PI / 180; for (let t = 0; t < th; t++) px(b, cx + Math.cos(rad) * (r + t), cy + Math.sin(rad) * (r + t), c, a); } }; ring(42, C.metalLo, 255, 4); ring(38, C.metal, 255, 2); ring(33, sh(C.strip, 0.7), 180, 2); ring(26, C.strip, 230, 3); ring(17, sh(C.strip, 1.2), 255, 2); for (let d = 0; d < 360; d += 45) { const rad = d * Math.PI / 180; for (let rr = 19; rr < 26; rr++) px(b, cx + Math.cos(rad) * rr, cy + Math.sin(rad) * rr, sh(C.strip, 1.1), 220); } for (let y = -9; y <= 9; y++) for (let x = -9; x <= 9; x++) { const dd = Math.hypot(x, y); if (dd < 10) px(b, cx + x, cy + y, dd < 4 ? [235, 250, 255] : sh(C.strip, 1.1), dd < 4 ? 255 : 200); } return b; }
function reactorPad(): Buf { const S = 130, cx = 65, cy = 65; const b = mk(S, S); for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const d = Math.hypot(x - cx, y - cy); if (d < 60) px(b, x, y, sh(C.floor, 1.3), d > 54 ? 200 : 255); if (d >= 56 && d < 60) px(b, x, y, C.strip, 150); } for (let a = 0; a < 360; a += 30) { const r = a * Math.PI / 180; for (let rr = 46; rr < 54; rr++) px(b, cx + Math.cos(r) * rr, cy + Math.sin(r) * rr, C.amber, 110); } return b; }
/** Ultron — a seething, red-eyed captive. Painted behind the containment bars. */
function ultronFigure(): Buf {
  const b = mk(30, 40);
  const M = C.metal, MH = C.metalHi, ML = C.metalLo, MD = C.metalD, RED = C.red;
  const HI: RGB = [150, 160, 178];
  // hunched shoulders + pauldrons
  rct(b, 3, 24, 26, 36, ML); rct(b, 3, 24, 26, 25, M);
  rct(b, 1, 25, 5, 33, MD); rct(b, 24, 25, 28, 33, MD);
  rct(b, 2, 25, 3, 31, ML); rct(b, 26, 25, 27, 31, ML);
  // chest core (angry red glow-plate)
  rct(b, 12, 27, 17, 33, MD); rct(b, 13, 28, 16, 31, sh(RED, 0.8));
  px(b, 14, 29, [255, 200, 200]); px(b, 15, 29, [255, 200, 200]);
  // neck
  rct(b, 12, 21, 17, 24, MD);
  // clenched claws raised (rage)
  rct(b, 3, 20, 7, 25, ML); rct(b, 22, 20, 26, 25, ML);
  for (const hx of [3, 22]) { px(b, hx + 1, 19, MD); px(b, hx + 3, 19, MD); }
  // angular head — wide cheeks, narrow jaw
  rct(b, 8, 7, 21, 20, M);
  rct(b, 9, 5, 20, 7, MH); rct(b, 10, 4, 19, 5, ML);
  px(b, 14, 2, MH); px(b, 15, 2, MH); px(b, 14, 3, MH); px(b, 15, 3, MH); // crest
  rct(b, 8, 7, 9, 20, ML); rct(b, 20, 7, 21, 20, ML); // cheek shade
  rct(b, 10, 18, 19, 21, ML); // jaw
  rct(b, 9, 6, 20, 6, HI, 160); // top highlight
  // brows sloping down to centre = furious
  for (let i = 0; i < 4; i++) { px(b, 9 + i, 8 + i, MD); px(b, 10 + i, 8 + i, MD); px(b, 20 - i, 8 + i, MD); px(b, 19 - i, 8 + i, MD); }
  // red slit eyes
  rct(b, 9, 11, 12, 12, sh(RED, 1.15)); rct(b, 17, 11, 20, 12, sh(RED, 1.15));
  px(b, 10, 11, [255, 210, 210]); px(b, 19, 11, [255, 210, 210]);
  px(b, 12, 12, sh(RED, 0.7)); px(b, 17, 12, sh(RED, 0.7));
  // cheek vents
  px(b, 9, 15, MD); px(b, 9, 16, MD); px(b, 20, 15, MD); px(b, 20, 16, MD);
  // snarling grille mouth
  rct(b, 11, 15, 18, 17, MD);
  for (let x = 11; x <= 18; x += 2) rct(b, x, 15, x, 16, sh(M, 1.2));
  px(b, 14, 16, sh(RED, 0.8)); px(b, 15, 16, sh(RED, 0.8));
  outline(b);
  return b;
}
function containment(): Buf {
  const b = mk(66, 66);
  rct(b, 3, 3, 62, 62, C.metalLo); rct(b, 3, 3, 62, 5, C.metalHi); // outer frame
  rct(b, 10, 10, 55, 55, C.dark); // cell interior
  rct(b, 14, 14, 51, 51, sh(C.dark, 1.3)); // back wall
  blit(b, ultronFigure(), 17, 12); // the prisoner
  for (let i = 0; i < 9; i++) { const x = 10 + i * 5; rct(b, x, 10, x, 55, i % 2 ? C.amber : sh(C.dark, 1.3), 210); } // bars over him
  rct(b, 10, 10, 55, 10, sh(C.metalLo, 1.1)); rct(b, 10, 55, 55, 55, C.metalD); // top/bottom rail
  for (const [x, y] of [[6, 6], [58, 6], [6, 58], [58, 58]] as const) rct(b, x, y, x + 2, y + 2, C.red);
  outline(b);
  return b;
}
function wallScreen(): Buf { const b = mk(52, 26); rct(b, 2, 2, 49, 23, sh(C.metal, 0.8)); rct(b, 4, 4, 47, 21, C.screen); for (let i = 0; i < 5; i++) rct(b, 7, 6 + i * 3, 7 + (i % 2 ? 30 : 18), 6 + i * 3, C.glow, 180); rct(b, 30, 8, 44, 19, C.strip, 40); outline(b); return b; }
function windowPane(): Buf { const b = mk(44, 26); rct(b, 2, 2, 41, 23, C.metalD); rct(b, 4, 4, 39, 21, [16, 26, 40]); for (let i = 0; i < 26; i++) px(b, 5 + (i * 7) % 34, 5 + (i * 5) % 16, C.white, 180); rct(b, 21, 4, 22, 21, C.metalD); rct(b, 4, 12, 39, 13, C.metalD); rct(b, 4, 4, 39, 5, C.strip, 90); outline(b); return b; }
function lamp(): Buf { const b = mk(24, 12); rct(b, 1, 1, 22, 10, C.metalLo); rct(b, 3, 3, 20, 8, [255, 236, 200]); rct(b, 3, 3, 20, 3, [255, 249, 232]); rct(b, 4, 6, 19, 6, sh([255, 236, 200], 0.9)); outline(b); return b; }

/** Light sources for the day/night light-map (world-pixel coords). */
export function lightSources(): LightSource[] {
  const CYAN: RGB = [90, 210, 255], WARM: RGB = [255, 214, 150], COOL: RGB = [130, 190, 255], MOON: RGB = [150, 180, 225], RED: RGB = [255, 110, 120];
  const s: LightSource[] = [{ x: 4 * T + T / 2, y: 3 * T + T / 2, r: 165, c: CYAN, i: 1.6 }];
  for (const [tx, ty] of LAMP_TILES) s.push({ x: tx * T + T / 2, y: ty * T + T / 2, r: 120, c: WARM, i: 1.0 });
  for (const [tx, ty] of BULLPEN_DESKS) s.push({ x: tx * T + T / 2, y: ty * T + 10, r: 48, c: COOL, i: 0.5 });
  s.push({ x: 24 * T + T / 2, y: 6 * T + T / 2, r: 100, c: MOON, i: 0.7 });
  s.push({ x: 22 * T + T / 2, y: 15 * T + T / 2, r: 60, c: RED, i: 0.6 });
  return s;
}

/** Compose the full static facility into one RGBA buffer. */
export function renderFloor(): Buf {
  const gw = LAB_GW, gh = LAB_GH, W = gw * T, H = gh * T;
  const room = mk(W, H);
  rct(room, 0, 0, W - 1, H - 1, C.bg);
  const tiles = { plain: floorTile("plain"), alt: floorTile("alt"), grate: floorTile("grate"), walk: floorTile("walk") };
  const grateZone = (tx: number, ty: number) => (tx >= 2 && tx <= 7 && ty >= 1 && ty <= 5) || (tx >= 20 && tx <= 24 && ty >= 9 && ty <= 12);
  const walkZone = (tx: number, ty: number) => ty === 7 || tx === 15;
  for (let ty = 0; ty < gh; ty++) for (let tx = 0; tx < gw; tx++) { let t = (tx + ty) % 2 ? tiles.alt : tiles.plain; if (grateZone(tx, ty)) t = tiles.grate; else if (walkZone(tx, ty)) t = tiles.walk; blit(room, t, tx * T, ty * T); }
  const wt = wallTop(), ws = wallSide();
  for (let tx = 0; tx < gw; tx++) blit(room, wt, tx * T, -6);
  for (let ty = 0; ty < gh; ty++) { blit(room, ws, 0, ty * T); blit(room, ws, W - 7, ty * T); }
  rct(room, 0, H - 5, W - 1, H - 1, C.wallLo);
  const ph = partH(), pv = partV();
  const doorH = new Set([5, 14, 22]);
  for (let tx = 1; tx < gw - 1; tx++) if (!doorH.has(tx)) blit(room, ph, tx * T, 7 * T - 2);
  for (let ty = 1; ty <= 6; ty++) if (ty !== 4) blit(room, pv, 9 * T - 2, ty * T);
  for (let ty = 1; ty <= 6; ty++) if (ty !== 3) blit(room, pv, 19 * T - 2, ty * T);
  for (let ty = 8; ty <= 18; ty++) if (ty !== 12) blit(room, pv, 19 * T - 2, ty * T);
  for (let tx = 20; tx < gw - 1; tx++) if (tx !== 22) blit(room, ph, tx * T, 13 * T - 2);

  const place = (prop: Buf, tx: number, ty: number, dy = 0) => blit(room, prop, tx * T + T / 2 - prop.w / 2, ty * T + T - prop.h + dy);
  // reactor bay
  const rcx = 4 * T + T / 2, rcy = 3 * T + 4;
  blit(room, reactorPad(), rcx - 65, rcy - 65); blit(room, reactor(), rcx - 46, rcy - 46);
  place(control(), 2, 5, 6); place(control(), 6, 5, 6);
  // meeting room
  blit(room, holoTable(), 13 * T + T / 2 - 45, 3 * T + T / 2 - 20);
  for (const [cx, cy] of [[12, 2], [15, 2], [12, 5], [15, 5]] as const) place(chair(), cx, cy);
  // server room
  for (const [sx, sy] of [[20, 2], [20, 4], [24, 2], [24, 4]] as const) place(serverRack(), sx, sy);
  // bullpen desks
  for (const [dx, dy] of BULLPEN_DESKS) place(workstation(), dx, dy);
  // fabrication bay
  place(fabricator(), 16, 9); place(crate(), 16, 11); place(crate(), 17, 11, -14); place(trashBin(), 15, 9);
  // canteen
  place(fridge(), 24, 9); place(coffee(), 20, 9); place(waterCooler(), 22, 11, 6); place(chair(), 21, 11); place(chair(), 23, 11);
  // containment
  place(containment(), 22, 15);
  // ceiling lamp fixtures (light sources at night)
  const lmp = lamp();
  for (const [tx, ty] of LAMP_TILES) blit(room, lmp, tx * T + T / 2 - lmp.w / 2, ty * T + 2);
  // décor
  blit(room, wallScreen(), 11 * T, 4); blit(room, windowPane(), 24 * T, 6);
  for (const [pxu, pyu] of [[1, 18], [15, 18], [28, 18], [1, 8], [28, 1]] as const) place(plant(), pxu, pyu);
  place(trashBin(), 10, 18); place(crate(), 27, 16); place(crate(), 28, 16, -14);
  return room;
}
