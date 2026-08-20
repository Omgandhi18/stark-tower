// Procedural pixel-character painter for Stark Tower.
//
// Characters are DRAWN IN CODE from a per-character "recipe" (skin, hair, face,
// facial hair, visor/glasses, clothing) — no sprite sheets. The same recipe
// renders both the portrait bust (cards / picker) and the walking floor sprite,
// so an agent on the floor looks identical to its card, and any number of
// distinct characters can be generated (or randomized) with zero assets.
//
// The drawing engine (primitives, head/face/hair, back-of-head, legs, outline)
// is adapted from munder-difflin's portraitArt.ts (MIT © Chaitanya Giri); the
// clothing set is re-themed to a sci-fi lab crew (lab coat / jumpsuit / tac-vest
// / hoodie / suit) with a HUD visor, and the recipes are original.

export type RGB = [number, number, number];
type Buf = Uint8ClampedArray;

export const PORTRAIT_W = 18;
export const PORTRAIT_H = 28;
export const SCENE_W = 18;
export const SCENE_H = 32;

const OUTLINE: RGB = [38, 34, 46];
const HX0 = 4, HX1 = 13;
let CUR_W = PORTRAIT_W, CUR_H = PORTRAIT_H;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
function shades(rgb: RGB, dl = 1.22, dd = 0.68): [RGB, RGB, RGB] {
  return [
    [clamp(rgb[0] * dl), clamp(rgb[1] * dl), clamp(rgb[2] * dl)],
    [rgb[0], rgb[1], rgb[2]],
    [clamp(rgb[0] * dd), clamp(rgb[1] * dd), clamp(rgb[2] * dd)],
  ];
}
function set(b: Buf, x: number, y: number, c: RGB, a = 255): void {
  if (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H) return;
  const i = (y * CUR_W + x) * 4; b[i] = c[0]; b[i + 1] = c[1]; b[i + 2] = c[2]; b[i + 3] = a;
}
const alphaAt = (b: Buf, x: number, y: number) => (x < 0 || x >= CUR_W || y < 0 || y >= CUR_H ? 0 : b[(y * CUR_W + x) * 4 + 3]);
const rgbAt = (b: Buf, x: number, y: number): RGB => { const i = (y * CUR_W + x) * 4; return [b[i], b[i + 1], b[i + 2]]; };
const eq = (a: RGB, b: RGB) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function rect(b: Buf, x0: number, y0: number, x1: number, y1: number, c: RGB): void {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(b, x, y, c);
}

interface SkinPal { hi: RGB; base: RGB; sh: RGB; line: RGB; }
const SKIN: Record<string, SkinPal> = {
  light: { hi: [255, 221, 189], base: [247, 201, 170], sh: [212, 158, 126], line: [168, 112, 82] },
  tan:   { hi: [232, 182, 136], base: [214, 162, 116], sh: [176, 126, 86],  line: [138, 92, 60] },
  brown: { hi: [180, 130, 94],  base: [158, 112, 78],  sh: [124, 86, 58],   line: [90, 60, 40] },
  dark:  { hi: [142, 98, 70],   base: [120, 80, 56],   sh: [94, 62, 42],    line: [64, 42, 28] },
};

type Brow = 'flat' | 'angry' | 'raised' | 'soft';
type Mouth = 'neutral' | 'smile' | 'frown' | 'grin';
type Facial = 'mustache' | 'goatee' | 'stubble';
type Cloth = 'tacvest' | 'jumpsuit' | 'labcoat' | 'hoodie' | 'suit';
interface HairArgs { part?: 'L' | 'R'; recede?: number; length?: number; vol?: number }

function drawHead(b: Buf, skin: string): void {
  const s = SKIN[skin];
  for (let y = 4; y <= 16; y++) for (let x = HX0; x <= HX1; x++) {
    if (((x === HX0 || x === HX1) && (y === 4 || y === 5 || y === 16)) || ((x === 5 || x === 12) && y === 4)) continue;
    set(b, x, y, s.base);
  }
  for (let y = 6; y < 12; y++) set(b, 5, y, s.hi);
  set(b, 6, 5, s.hi); set(b, 7, 5, s.hi);
  for (let y = 6; y < 15; y++) set(b, 12, y, s.sh);
  for (const x of [7, 8, 9, 10, 11]) set(b, x, 16, s.sh);
  for (const ex of [HX0 - 1, HX1 + 1]) { set(b, ex, 9, s.base); set(b, ex, 10, s.base); set(b, ex, 11, s.sh); }
  rect(b, 7, 17, 10, 18, s.sh); rect(b, 7, 17, 9, 17, s.base);
}
function drawFace(b: Buf, skin: string, brow: Brow, mouth: Mouth, blush: boolean, lashes: boolean, visor: boolean): void {
  const s = SKIN[skin];
  const white: RGB = [250, 248, 244], pup: RGB = [46, 38, 42];
  if (!visor) {
    for (const [a, bb, p] of [[5, 6, 6], [10, 11, 10]] as const) { set(b, a, 9, white); set(b, bb, 9, white); set(b, p, 9, pup); }
    if (lashes) {
      const lash: RGB = [54, 40, 48], glint: RGB = [252, 250, 248];
      for (const x of [5, 6, 10, 11]) set(b, x, 8, lash);
      set(b, 4, 8, lash); set(b, 12, 8, lash); set(b, 5, 9, glint); set(b, 10, 9, glint);
    }
    if (brow === 'flat') for (const x of [5, 6, 10, 11]) set(b, x, 7, s.line);
    else if (brow === 'angry') { set(b, 5, 8, s.line); set(b, 6, 7, s.line); set(b, 10, 7, s.line); set(b, 11, 8, s.line); }
    else if (brow === 'raised') for (const x of [5, 6, 10, 11]) set(b, x, 6, s.line);
    else if (brow === 'soft') { for (const x of [5, 11]) set(b, x, 7, s.line); for (const x of [6, 10]) set(b, x, 7, s.sh); }
  }
  set(b, 8, 11, s.sh); set(b, 8, 12, s.sh); set(b, 7, 12, s.sh);
  const mc: RGB = [158, 86, 80];
  const mouths: Record<Mouth, [number, number][]> = {
    neutral: [[7, 14], [8, 14], [9, 14], [10, 14]],
    smile: [[7, 14], [8, 14], [9, 14], [10, 14], [6, 13], [11, 13]],
    frown: [[7, 15], [8, 15], [9, 15], [10, 15], [6, 14], [11, 14]],
    grin: [[7, 14], [8, 14], [9, 14], [10, 14], [7, 13], [8, 13], [9, 13], [10, 13], [6, 13], [11, 13]],
  };
  for (const [x, y] of mouths[mouth]) set(b, x, y, mc);
  if (blush) for (const x of [5, 12]) set(b, x, 12, [235, 150, 140], 140);
}

type HairFn = (b: Buf, color: RGB, skinBase: RGB, a: HairArgs) => void;
const styleShort: HairFn = (b, color, skinBase, a) => {
  const [hi, base, sh] = shades(color); const part = a.part ?? 'L', recede = a.recede ?? 0;
  rect(b, HX0, 2, HX1, 4, base); for (let x = HX0 - 1; x <= HX1 + 1; x++) set(b, x, 3, base);
  rect(b, HX0 - 1, 4, HX1 + 1, 5, base);
  for (let y = 6; y < 9; y++) { set(b, HX0 - 1, y, base); set(b, HX0, y, base); set(b, HX1, y, base); set(b, HX1 + 1, y, base); }
  for (let x = HX0; x <= HX1; x++) set(b, x, 5, base);
  if (recede) { for (let y = 3; y < 6; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(b, x, y), base)) set(b, x, y, skinBase); set(b, 8, 5, base); }
  const hx = part === 'L' ? 6 : 11; for (let y = 2; y < 6; y++) set(b, hx, y, sh);
  for (let x = HX0; x < hx; x++) if (alphaAt(b, x, 3)) set(b, x, 3, hi);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(b, x, 2)) set(b, x, 2, hi);
};
const styleFloppy: HairFn = (b, color) => {
  const [hi, base] = shades(color);
  rect(b, HX0, 2, HX1, 4, base); for (let x = HX0 - 1; x <= HX1 + 1; x++) set(b, x, 3, base);
  rect(b, HX0 - 1, 4, HX1 + 1, 5, base); for (let x = HX0; x <= HX1; x++) set(b, x, 5, base);
  for (let x = 6; x <= 12; x++) set(b, x, 6, base); set(b, 9, 7, base); set(b, 10, 7, base); set(b, 11, 7, base);
  for (let y = 6; y < 9; y++) { set(b, HX0 - 1, y, base); set(b, HX0, y, base); set(b, HX1, y, base); set(b, HX1 + 1, y, base); }
  for (let x = HX0; x <= HX1; x++) if (alphaAt(b, x, 2)) set(b, x, 2, hi);
  for (const x of [7, 8, 9]) set(b, x, 6, hi);
};
const styleFrame: HairFn = (b, color, skinBase, a) => {
  const [hi, base, sh] = shades(color); const length = a.length ?? 17, vol = a.vol ?? 1;
  rect(b, HX0 - 1, 2, HX1 + 1, 5, base); for (let x = HX0 - 1; x <= HX1 + 1; x++) set(b, x, 3, base);
  for (let x = HX0; x <= HX1; x++) set(b, x, 5, base); for (let x = 6; x < 12; x++) set(b, x, 6, base);
  set(b, 8, 6, skinBase); set(b, 9, 6, skinBase);
  for (let y = 6; y <= length; y++) { for (let dx = 0; dx < vol; dx++) { set(b, HX0 - 1 - dx, y, base); set(b, HX1 + 1 + dx, y, base); } set(b, HX0, y, base); set(b, HX1, y, base); }
  for (let x = HX0 - 1; x < HX0 + 1; x++) set(b, x, length + 1, base); for (let x = HX1; x < HX1 + 2; x++) set(b, x, length + 1, base);
  for (let y = 2; y < 6; y++) if (alphaAt(b, HX1, y)) set(b, HX1, y, sh);
  for (let x = HX0; x < 9; x++) if (alphaAt(b, x, 2)) set(b, x, 2, hi);
};
const styleBun: HairFn = (b, color, skinBase) => {
  const [hi, base] = shades(color);
  rect(b, HX0, 3, HX1, 5, base); for (let x = HX0 - 1; x <= HX1 + 1; x++) set(b, x, 4, base);
  for (let x = HX0; x <= HX1; x++) set(b, x, 5, base); for (let x = 6; x < 12; x++) set(b, x, 6, base);
  set(b, 8, 6, skinBase); set(b, 9, 6, skinBase);
  for (let y = 6; y < 9; y++) { set(b, HX0, y, base); set(b, HX1, y, base); }
  rect(b, 7, 1, 10, 2, base); for (let x = HX0; x <= HX1; x++) if (alphaAt(b, x, 3)) set(b, x, 3, hi);
};
const styleSpiky: HairFn = (b, color, skinBase) => {
  const [hi, base] = shades(color);
  rect(b, HX0, 3, HX1, 5, base); for (let x = HX0 - 1; x <= HX1 + 1; x++) set(b, x, 4, base);
  for (let x = HX0; x <= HX1; x++) set(b, x, 5, base);
  const spikes: [number, number][] = [[5, 2], [7, 1], [9, 2], [11, 1], [6, 2], [8, 2], [10, 2], [12, 2]];
  for (const [x, y] of spikes) set(b, x, y, base); for (let x = 6; x < 12; x++) set(b, x, 6, base);
  set(b, 8, 6, skinBase); set(b, 9, 6, skinBase);
  for (let y = 6; y < 8; y++) { set(b, HX0, y, base); set(b, HX1, y, base); }
  for (const [x, y] of spikes) set(b, x, y, hi);
};
const styleMessy: HairFn = (b, color, skinBase, a) => {
  const [hi, base] = shades(color); const length = a.length ?? 8;
  rect(b, HX0 - 1, 2, HX1 + 1, 5, base);
  const spikes: [number, number][] = [[3, 2], [5, 1], [7, 2], [9, 1], [11, 2], [13, 1], [14, 2], [4, 2], [12, 2]];
  for (const [x, y] of spikes) set(b, x, y, base); for (let x = HX0; x <= HX1; x++) set(b, x, 5, base);
  for (let x = 6; x < 12; x++) set(b, x, 6, base); set(b, 8, 6, skinBase); set(b, 9, 6, skinBase);
  for (let y = 6; y <= length; y++) { set(b, HX0 - 1, y, base); set(b, HX0, y, base); set(b, HX1, y, base); set(b, HX1 + 1, y, base); }
  for (const [x, y] of spikes) set(b, x, y, hi);
};
const styleCurly: HairFn = (b, color, skinBase) => {
  const [hi, base] = shades(color);
  const pts: [number, number][] = [[4, 3], [5, 2], [6, 3], [7, 2], [8, 3], [9, 2], [10, 3], [11, 2], [12, 3], [13, 3], [3, 4], [4, 4], [13, 4], [14, 4], [3, 5], [4, 5], [13, 5], [14, 5], [3, 6], [13, 6], [4, 6], [12, 6], [3, 7], [13, 7], [4, 7]];
  rect(b, HX0, 3, HX1, 5, base); for (let x = HX0 - 1; x <= HX1 + 1; x++) set(b, x, 4, base);
  for (const [x, y] of pts) set(b, x, y, base); for (let x = 6; x < 12; x++) set(b, x, 6, base);
  set(b, 8, 6, skinBase); set(b, 9, 6, skinBase);
  for (const [x, y] of [[5, 2], [7, 2], [9, 2], [11, 2]] as const) set(b, x, y, hi);
};
const styleBald: HairFn = (b, color, skinBase, a) => {
  const [shi, sbase, ssh] = shades(skinBase, 1.1, 0.82);
  for (let x = 6; x <= 11; x++) set(b, x, 2, sbase); for (let x = 5; x <= 12; x++) set(b, x, 3, sbase);
  for (let x = HX0; x <= HX1; x++) set(b, x, 4, sbase);
  for (const x of [7, 8, 9]) set(b, x, 2, shi); set(b, 6, 3, shi); set(b, 7, 3, shi);
  set(b, 5, 3, ssh); set(b, 12, 3, ssh); set(b, HX1, 4, ssh);
  const [, base, sh] = shades(color); const top = a.recede ? 8 : 6;
  for (let y = top; y <= 10; y++) { set(b, HX0 - 1, y, base); set(b, HX0, y, base); set(b, HX1, y, base); set(b, HX1 + 1, y, base); }
  for (let y = top; y <= 10; y++) { set(b, HX0 - 1, y, sh); set(b, HX1 + 1, y, sh); }
};
const styleRecede: HairFn = (b, color, skinBase) => {
  const [, base, sh] = shades(color);
  for (let y = 4; y < 10; y++) { set(b, HX0 - 1, y, base); set(b, HX0, y, base); set(b, HX1, y, base); set(b, HX1 + 1, y, base); }
  for (let x = HX0; x <= HX1; x++) set(b, x, 4, base); for (let x = HX0 + 1; x < HX1; x++) set(b, x, 5, base);
  for (let y = 5; y < 9; y++) for (let x = 6; x < 12; x++) if (eq(rgbAt(b, x, y), base)) set(b, x, y, skinBase);
  for (let x = HX0; x <= HX1; x++) if (alphaAt(b, x, 4)) set(b, x, 4, sh);
};
const HAIR_FNS = { styleShort, styleFloppy, styleFrame, styleBun, styleCurly, styleMessy, styleRecede, styleSpiky, styleBald };
type HairStyle = keyof typeof HAIR_FNS;

function drawFacial(b: Buf, kind: Facial, color: RGB): void {
  const [, base, sh] = shades(color);
  if (kind === 'mustache') { for (const x of [6, 7, 8, 9, 10]) set(b, x, 13, base); set(b, 6, 12, base); set(b, 10, 12, base); }
  else if (kind === 'goatee') { for (const x of [8, 9]) set(b, x, 15, base); set(b, 8, 14, base); set(b, 9, 14, base); for (const x of [7, 8, 9, 10]) set(b, x, 13, base); }
  else if (kind === 'stubble') for (const [x, y] of [[5, 14], [6, 15], [7, 15], [8, 15], [9, 15], [10, 15], [11, 14], [12, 13], [4, 13], [5, 15], [10, 15]] as const) set(b, x, y, sh, 150);
}
function drawGlasses(b: Buf): void {
  const frame: RGB = [60, 54, 62], glint: RGB = [236, 240, 246];
  for (const x of [5, 6]) { set(b, x, 8, frame); set(b, x, 10, frame); } set(b, 4, 9, frame); set(b, 7, 9, frame); set(b, 4, 8, frame); set(b, 7, 8, frame);
  for (const x of [10, 11]) { set(b, x, 8, frame); set(b, x, 10, frame); } set(b, 9, 9, frame); set(b, 12, 9, frame); set(b, 9, 8, frame); set(b, 12, 8, frame);
  set(b, 8, 8, frame); set(b, 3, 9, frame); set(b, 13, 9, frame); set(b, 4, 8, glint); set(b, 9, 8, glint);
}
function drawVisor(b: Buf, glow: RGB): void {
  const frame: RGB = [34, 38, 48];
  for (let x = 4; x <= 13; x++) { set(b, x, 8, frame); set(b, x, 9, glow); set(b, x, 10, frame); }
  set(b, 3, 9, frame); set(b, 14, 9, frame);
  const [hi] = shades(glow, 1.5);
  set(b, 5, 9, hi); set(b, 11, 9, hi);
}

function bodyShape(b: Buf, col: RGB, heavy: boolean): void {
  const [, base, sh] = shades(col);
  const rows: [number, number, number][] = heavy
    ? [[19, 5, 12], [20, 3, 14], [21, 2, 15], [22, 1, 16], [23, 1, 16], [24, 0, 17], [25, 0, 17], [26, 0, 17], [27, 0, 17]]
    : [[19, 6, 11], [20, 4, 13], [21, 3, 14], [22, 2, 15], [23, 2, 15], [24, 1, 16], [25, 1, 16], [26, 1, 16], [27, 1, 16]];
  for (const [y, a, bb] of rows) rect(b, a, y, bb, y, base);
  const [lo, hi] = heavy ? [1, 16] : [2, 15];
  for (let y = 22; y < 28; y++) { set(b, lo, y, sh); set(b, hi, y, sh); }
}
function drawClothing(b: Buf, r: Recipe): void {
  const [hi, , sh] = shades(r.c1);
  bodyShape(b, r.c1, r.heavy ?? false);
  const kind = r.cloth;
  if (kind === 'labcoat') {
    const inner = r.c2 ? shades(r.c2)[1] : [70, 82, 100] as RGB;
    for (let y = 19; y < 27; y++) { set(b, 8, y, inner); set(b, 9, y, inner); }
    for (const [x, y] of [[6, 19], [7, 20], [11, 19], [10, 20]] as const) set(b, x, y, sh);
    set(b, 7, 19, hi); set(b, 10, 19, hi);
    if (r.accent) set(b, 8, 20, r.accent);
  } else if (kind === 'jumpsuit') {
    for (let y = 19; y < 27; y++) set(b, 8, y, sh);
    for (let x = 6; x <= 11; x++) set(b, x, 19, hi);
    if (r.accent) { set(b, 8, 20, r.accent); set(b, 8, 24, r.accent); }
    for (const [x, y] of [[6, 20], [11, 20]] as const) set(b, x, y, r.c2 ? shades(r.c2)[1] : sh);
  } else if (kind === 'tacvest') {
    const inner = r.c2 ? shades(r.c2)[1] : [58, 64, 78] as RGB;
    for (const [x, y] of [[8, 19], [9, 19]] as const) set(b, x, y, inner);
    for (let y = 20; y < 27; y++) { set(b, 6, y, sh); set(b, 11, y, sh); }
    set(b, 6, 22, hi); set(b, 11, 22, hi);
    for (const [x, y] of [[7, 24], [10, 24]] as const) set(b, x, y, sh);
    if (r.accent) set(b, 9, 21, r.accent);
  } else if (kind === 'hoodie') {
    for (const [x, y] of [[6, 19], [7, 19], [8, 19], [9, 19], [10, 19], [11, 19]] as const) set(b, x, y, sh);
    for (let y = 20; y < 27; y++) set(b, 8, y, sh);
    set(b, 7, 20, hi); set(b, 10, 20, hi);
  } else if (kind === 'suit') {
    const inner = r.c2 ? shades(r.c2)[1] : [40, 44, 54] as RGB;
    for (const [x, y] of [[8, 19], [9, 19], [8, 20], [9, 20], [8, 21], [9, 21]] as const) set(b, x, y, inner);
    for (const [x, y] of [[6, 20], [7, 21], [11, 20], [10, 21]] as const) set(b, x, y, sh);
    if (r.accent) for (let y = 20; y < 26; y++) { set(b, 8, y, r.accent); set(b, 9, y, r.accent); }
  }
}
function collarNeck(b: Buf, skin: string): void { rect(b, 7, 18, 10, 19, SKIN[skin].sh); }

const SHOE: RGB = [44, 40, 48];
function drawSceneLegs(b: Buf, pants: RGB, phase: number): void {
  const [, base, sh] = shades(pants);
  for (const [lx0, lx1] of [[5, 7], [10, 12]] as const) { rect(b, lx0, 25, lx1, 30, base); for (let y = 25; y <= 30; y++) set(b, lx1, y, sh); }
  const leftLow = phase !== 1, rightLow = phase !== 2;
  rect(b, 5, leftLow ? 31 : 30, 7, leftLow ? 31 : 30, SHOE);
  rect(b, 10, rightLow ? 31 : 30, 12, rightLow ? 31 : 30, SHOE);
}
function drawSceneTorso(b: Buf, r: Recipe, back: boolean): void {
  const [hi, base, sh] = shades(r.c1);
  if (r.heavy) { rect(b, 3, 18, 14, 18, base); rect(b, 2, 19, 15, 19, base); rect(b, 2, 20, 15, 24, base); for (let y = 20; y <= 24; y++) { set(b, 2, y, sh); set(b, 15, y, sh); set(b, 14, y, sh); } }
  else { rect(b, 4, 18, 13, 18, base); rect(b, 3, 19, 14, 19, base); rect(b, 4, 20, 13, 24, base); for (let y = 20; y <= 24; y++) { set(b, 3, y, sh); set(b, 14, y, sh); set(b, 13, y, sh); } }
  if (back) { rect(b, 6, 18, 11, 18, sh); for (let y = 19; y <= 24; y++) set(b, 8, y, sh); return; }
  const inner: RGB = r.c2 ? shades(r.c2)[1] : [58, 64, 78];
  if (r.cloth === 'labcoat') { for (let y = 18; y <= 24; y++) { set(b, 8, y, inner); set(b, 9, y, inner); } for (const [x, y] of [[6, 18], [7, 19], [11, 18], [10, 19]] as const) set(b, x, y, sh); }
  else if (r.cloth === 'jumpsuit') { for (let y = 18; y <= 24; y++) set(b, 8, y, sh); for (let x = 6; x <= 11; x++) set(b, x, 18, hi); if (r.accent) { set(b, 8, 19, r.accent); set(b, 8, 23, r.accent); } }
  else if (r.cloth === 'tacvest') { for (const [x, y] of [[8, 18], [9, 18]] as const) set(b, x, y, inner); for (let y = 19; y <= 24; y++) { set(b, 6, y, sh); set(b, 11, y, sh); } if (r.accent) set(b, 9, 20, r.accent); }
  else if (r.cloth === 'hoodie') { for (const [x, y] of [[6, 18], [7, 18], [8, 18], [9, 18], [10, 18], [11, 18]] as const) set(b, x, y, sh); for (let y = 19; y <= 24; y++) set(b, 8, y, sh); }
  else if (r.cloth === 'suit') { for (const [x, y] of [[8, 18], [9, 18], [8, 19], [9, 19], [8, 20], [9, 20]] as const) set(b, x, y, inner); if (r.accent) for (let y = 18; y <= 24; y++) { set(b, 8, y, r.accent); set(b, 9, y, r.accent); } }
}
function drawHeadBack(b: Buf, r: Recipe): void {
  const s = SKIN[r.skin];
  const rows: [number, number, number][] = [[2, 6, 11], [3, 5, 12], [4, 4, 13], [5, 4, 13], [6, 4, 13], [7, 4, 13], [8, 4, 13], [9, 4, 13], [10, 4, 13], [11, 4, 13], [12, 4, 13], [13, 5, 12], [14, 6, 11]];
  if (r.hair === 'styleBald') {
    const [shi, sbase, ssh] = shades(s.base, 1.1, 0.82);
    for (const [y, a, bb] of rows) rect(b, a, y, bb, y, sbase);
    for (let y = 4; y <= 12; y++) { set(b, 4, y, ssh); set(b, 13, y, ssh); }
    for (const [x, y] of [[7, 2], [8, 2], [9, 2], [8, 3]] as const) set(b, x, y, shi);
    const [, base, sh] = shades(r.hairc);
    for (let x = 4; x <= 13; x++) { set(b, x, 11, base); set(b, x, 12, base); } for (const x of [4, 13]) { set(b, x, 11, sh); set(b, x, 12, sh); }
    rect(b, 7, 14, 10, 14, s.sh); rect(b, 7, 15, 10, 17, s.sh); rect(b, 7, 15, 9, 15, s.base); return;
  }
  const [hi, base, sh] = shades(r.hairc);
  for (const [y, a, bb] of rows) rect(b, a, y, bb, y, base);
  const len = r.hair === 'styleFrame' ? (r.hairargs?.length ?? 17) : r.hair === 'styleMessy' ? (r.hairargs?.length ?? 9) : 0;
  for (let y = 11; y <= len; y++) { set(b, HX0 - 1, y, base); set(b, HX0, y, base); set(b, HX1, y, base); set(b, HX1 + 1, y, base); }
  for (let y = 4; y <= 12; y++) { set(b, 4, y, sh); set(b, 13, y, sh); }
  for (const [x, y] of [[7, 2], [8, 2], [9, 2], [10, 2], [7, 3], [8, 3], [9, 3]] as const) set(b, x, y, hi);
  for (let y = 4; y <= 11; y++) set(b, 9, y, hi); for (let y = 4; y <= 12; y++) set(b, 8, y, sh);
  rect(b, 7, 14, 10, 14, sh); rect(b, 7, 15, 10, 17, s.sh); rect(b, 7, 15, 9, 15, s.base);
}
function drawHeavyFace(b: Buf, skin: string): void {
  const s = SKIN[skin];
  for (let y = 11; y <= 15; y++) { set(b, HX0 - 1, y, s.base); set(b, HX1 + 1, y, s.base); }
  set(b, HX0 - 1, 15, s.sh); set(b, HX1 + 1, 15, s.sh);
  for (const x of [5, 6, 11, 12]) set(b, x, 16, s.base);
  rect(b, 6, 17, 11, 18, s.base); for (const x of [6, 7, 8, 9, 10, 11]) set(b, x, 18, s.sh);
  set(b, 7, 17, s.sh); set(b, 10, 17, s.sh);
}
function outlinePass(b: Buf): void {
  const pts: [number, number][] = [];
  for (let y = 0; y < CUR_H; y++) for (let x = 0; x < CUR_W; x++) {
    if (alphaAt(b, x, y) !== 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) if (alphaAt(b, x + dx, y + dy) === 255) { pts.push([x, y]); break; }
  }
  for (const [x, y] of pts) set(b, x, y, OUTLINE);
}
function drawHeadGroup(b: Buf, r: Recipe): void {
  const skinBase = SKIN[r.skin].base;
  drawHead(b, r.skin);
  if (r.heavy) drawHeavyFace(b, r.skin);
  drawFace(b, r.skin, r.brow ?? 'flat', r.mouth ?? 'neutral', r.blush ?? false, r.lashes ?? false, r.visor ?? false);
  if (r.facial) drawFacial(b, r.facial, r.hairc);
  HAIR_FNS[r.hair](b, r.hairc, skinBase, r.hairargs ?? {});
  if (r.visor) drawVisor(b, r.visorColor ?? [90, 210, 255]);
  else if (r.glasses) drawGlasses(b);
}
const defaultPants = (r: Recipe): RGB => r.pants ?? (r.cloth === 'suit' ? shades(r.c1)[2] : [50, 54, 68]);

export interface Recipe {
  skin: string; hairc: RGB; hair: HairStyle; hairargs?: HairArgs;
  cloth: Cloth; c1: RGB; c2?: RGB; accent?: RGB; pants?: RGB;
  brow?: Brow; mouth?: Mouth; blush?: boolean; facial?: Facial;
  glasses?: boolean; visor?: boolean; visorColor?: RGB; lashes?: boolean; heavy?: boolean;
}

export function compose(r: Recipe): Buf {
  CUR_W = PORTRAIT_W; CUR_H = PORTRAIT_H;
  const b = new Uint8ClampedArray(PORTRAIT_W * PORTRAIT_H * 4);
  drawClothing(b, r); collarNeck(b, r.skin); drawHeadGroup(b, r); outlinePass(b); return b;
}
export function composeScene(r: Recipe, phase: number, back: boolean): Buf {
  CUR_W = SCENE_W; CUR_H = SCENE_H;
  const b = new Uint8ClampedArray(SCENE_W * SCENE_H * 4);
  drawSceneTorso(b, r, back); drawSceneLegs(b, defaultPants(r), phase);
  if (back) drawHeadBack(b, r); else drawHeadGroup(b, r); outlinePass(b); return b;
}
export interface SceneFrames { front: Buf[]; back: Buf[] }
export function sceneFrameBufs(r: Recipe): SceneFrames {
  return {
    front: [composeScene(r, 0, false), composeScene(r, 1, false), composeScene(r, 2, false)],
    back: [composeScene(r, 0, true), composeScene(r, 1, true), composeScene(r, 2, true)],
  };
}

// ─── presets (the gallery) ─────────────────────────────────────────────────────
const CYAN: RGB = [90, 210, 255], AMBER: RGB = [230, 190, 90], MINT: RGB = [120, 240, 170], VIOLET: RGB = [180, 140, 240], RED: RGB = [190, 60, 60];

export interface Preset { id: string; label: string; recipe: Recipe }
export const PRESETS: Preset[] = [
  { id: 'operative',   label: 'Operative',    recipe: { skin: 'tan',   hairc: [40, 34, 30], hair: 'styleShort', cloth: 'tacvest', c1: [46, 52, 64], c2: [30, 34, 42], visor: true, brow: 'flat', mouth: 'neutral' } },
  { id: 'engineer',    label: 'Engineer',     recipe: { skin: 'light', hairc: [70, 50, 32], hair: 'styleShort', hairargs: { part: 'R' }, cloth: 'jumpsuit', c1: [150, 120, 54], accent: AMBER, facial: 'goatee', brow: 'flat', mouth: 'smile' } },
  { id: 'scientist',   label: 'Scientist',    recipe: { skin: 'light', hairc: [90, 66, 40], hair: 'styleFloppy', cloth: 'labcoat', c1: [222, 226, 232], c2: [70, 96, 120], glasses: true, brow: 'raised', mouth: 'smile' } },
  { id: 'pilot',       label: 'Pilot',        recipe: { skin: 'brown', hairc: [30, 24, 20], hair: 'styleSpiky', cloth: 'jumpsuit', c1: [54, 70, 92], accent: CYAN, visor: true, brow: 'flat', mouth: 'neutral' } },
  { id: 'analyst',     label: 'Analyst',      recipe: { skin: 'light', hairc: [50, 38, 28], hair: 'styleShort', cloth: 'suit', c1: [44, 48, 60], c2: [60, 150, 180], glasses: true, brow: 'flat', mouth: 'neutral' } },
  { id: 'medic',       label: 'Medic',        recipe: { skin: 'light', hairc: [150, 120, 70], hair: 'styleBun', cloth: 'labcoat', c1: [226, 228, 232], c2: [180, 80, 80], brow: 'soft', mouth: 'smile', lashes: true } },
  { id: 'hacker',      label: 'Hacker',       recipe: { skin: 'dark', hairc: [24, 20, 22], hair: 'styleMessy', cloth: 'hoodie', c1: [52, 46, 62], brow: 'flat', mouth: 'neutral' } },
  { id: 'commander',   label: 'Commander',    recipe: { skin: 'light', hairc: [60, 54, 48], hair: 'styleRecede', cloth: 'suit', c1: [40, 42, 52], accent: RED, brow: 'angry', mouth: 'neutral', facial: 'mustache' } },
  { id: 'sentinel',    label: 'Sentinel',     recipe: { skin: 'dark', hairc: [40, 36, 34], hair: 'styleBald', cloth: 'tacvest', c1: [40, 46, 56], c2: [28, 32, 40], facial: 'stubble', brow: 'flat', mouth: 'neutral', heavy: true } },
  { id: 'specialist',  label: 'Specialist',   recipe: { skin: 'tan', hairc: [30, 24, 26], hair: 'styleCurly', cloth: 'jumpsuit', c1: [70, 60, 92], accent: VIOLET, brow: 'soft', mouth: 'smile', lashes: true } },
  { id: 'recon',       label: 'Recon',        recipe: { skin: 'brown', hairc: [36, 28, 22], hair: 'styleFrame', hairargs: { length: 16, vol: 1 }, cloth: 'tacvest', c1: [50, 58, 50], c2: [34, 40, 34], visor: true, visorColor: MINT, brow: 'flat', mouth: 'neutral', lashes: true } },
  { id: 'architect',   label: 'Architect',    recipe: { skin: 'brown', hairc: [28, 22, 18], hair: 'styleShort', hairargs: { part: 'L' }, cloth: 'labcoat', c1: [220, 224, 230], c2: [90, 90, 110], brow: 'flat', mouth: 'smile' } },
  { id: 'droneop',     label: 'Drone Op',     recipe: { skin: 'light', hairc: [180, 150, 90], hair: 'styleSpiky', cloth: 'jumpsuit', c1: [52, 60, 74], accent: CYAN, visor: true, brow: 'raised', mouth: 'smile' } },
  { id: 'quartermaster', label: 'Quartermaster', recipe: { skin: 'tan', hairc: [50, 46, 40], hair: 'styleShort', cloth: 'tacvest', c1: [58, 54, 48], c2: [40, 38, 34], facial: 'mustache', brow: 'flat', mouth: 'neutral', heavy: true } },
];
export const DEFAULT_PRESET = 'operative';
const PRESET_BY_ID: Record<string, Preset> = Object.fromEntries(PRESETS.map((p) => [p.id, p]));

// Old sprite-library ids (pre-procedural) → a sensible preset, so migrated configs render.
const LEGACY_SPRITE_MAP: Record<string, string> = {
  sentinel: 'commander', oracle: 'architect', mechanic: 'engineer',
  scout: 'recon', artisan: 'specialist', warden: 'operative',
};

/** Resolve an agent's `figure` (preset id, JSON recipe, or legacy id) to a Recipe. */
export function resolveRecipe(figure: string | undefined): Recipe {
  const f = (figure ?? '').trim();
  if (f.startsWith('{')) {
    try { return JSON.parse(f) as Recipe; } catch { /* fall through */ }
  }
  if (PRESET_BY_ID[f]) return PRESET_BY_ID[f].recipe;
  if (LEGACY_SPRITE_MAP[f]) return PRESET_BY_ID[LEGACY_SPRITE_MAP[f]].recipe;
  return PRESET_BY_ID[DEFAULT_PRESET].recipe;
}

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
const HAIR_COLORS: RGB[] = [[30, 24, 20], [50, 38, 28], [90, 66, 40], [150, 120, 70], [180, 150, 90], [60, 54, 48], [24, 20, 22], [110, 60, 40]];
const CLOTH_COLORS: RGB[] = [[46, 52, 64], [54, 70, 92], [70, 60, 92], [50, 58, 50], [58, 54, 48], [40, 42, 52], [150, 120, 54], [222, 226, 232]];
const GLOWS: RGB[] = [CYAN, AMBER, MINT, VIOLET];

/** A random, coherent sci-fi character recipe. */
export function randomizeRecipe(): Recipe {
  const cloth = pick(['tacvest', 'jumpsuit', 'labcoat', 'hoodie', 'suit'] as const);
  const c1 = cloth === 'labcoat' ? pick([[222, 226, 232], [226, 228, 232], [220, 224, 230]] as RGB[]) : pick(CLOTH_COLORS);
  const useVisor = Math.random() < 0.4;
  return {
    skin: pick(['light', 'tan', 'brown', 'dark']),
    hairc: pick(HAIR_COLORS),
    hair: pick(Object.keys(HAIR_FNS) as HairStyle[]),
    hairargs: { part: pick(['L', 'R'] as const) },
    cloth,
    c1,
    c2: pick(CLOTH_COLORS),
    accent: cloth === 'labcoat' ? undefined : (Math.random() < 0.5 ? pick(GLOWS) : undefined),
    brow: pick(['flat', 'angry', 'raised', 'soft'] as const),
    mouth: pick(['neutral', 'smile'] as const),
    visor: useVisor,
    visorColor: pick(GLOWS),
    glasses: !useVisor && Math.random() < 0.25,
    facial: Math.random() < 0.3 ? pick(['mustache', 'goatee', 'stubble'] as const) : undefined,
    lashes: Math.random() < 0.35,
    heavy: Math.random() < 0.2,
  };
}

export const serializeRecipe = (r: Recipe): string => JSON.stringify(r);

// ─── browser render (portrait to a 2D canvas) ──────────────────────────────────
export function paintPortrait(ctx: CanvasRenderingContext2D, r: Recipe, scale = 3): void {
  const buf = compose(r);
  const stage = document.createElement('canvas');
  stage.width = PORTRAIT_W; stage.height = PORTRAIT_H;
  const sctx = stage.getContext('2d')!;
  const img = sctx.createImageData(PORTRAIT_W, PORTRAIT_H);
  img.data.set(buf); sctx.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
  ctx.drawImage(stage, 0, 0, PORTRAIT_W, PORTRAIT_H, 0, 0, PORTRAIT_W * scale, PORTRAIT_H * scale);
}

/** Accent identity palette (selection glow / labels), independent of the character. */
export const PALETTE: string[] = [
  '#59cfff', '#4fd0ff', '#7cf5c4', '#6ee7b7', '#e8c06a', '#ff9e64',
  '#ff6b78', '#e86b9a', '#c08cff', '#8ab4ff', '#b8c4d0', '#f2f7fc',
];
