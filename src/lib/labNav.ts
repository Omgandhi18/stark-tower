// Facility navigation: a tile-graph over the lab so agents walk *through doors
// and along aisles* instead of cutting straight through walls and machines.
//
// The floor (labArt) is partitioned into rooms joined only by door gaps. We model
// that as a 4-connected grid where big fixtures are un-walkable tiles and each
// partition blocks the edge between two tiles except at its door. A* then returns
// axis-aligned waypoints that read as corridor-following.

import { BULLPEN_DESKS, LAB_GH, LAB_GW, LAB_TILE } from "./labArt";

const GW = LAB_GW;
const GH = LAB_GH;
const T = LAB_TILE;

export interface Pt { x: number; y: number }

// --- fixtures agents route around (tiles they can't stand on) ------------------
const BLOCKED = new Set<number>();
const block = (tx: number, ty: number) => BLOCKED.add(ty * GW + tx);
for (let x = 3; x <= 5; x++) for (let y = 2; y <= 4; y++) block(x, y); // reactor core
for (let x = 13; x <= 15; x++) block(x, 3); // meeting holo-table
for (const [x, y] of [[20, 2], [20, 4], [24, 2], [24, 4]] as const) block(x, y); // server racks
block(16, 9); // fabricator
for (const [x, y] of [[20, 9], [24, 9], [22, 11]] as const) block(x, y); // coffee / fridge / cooler
for (let x = 21; x <= 23; x++) for (let y = 14; y <= 16; y++) block(x, y); // containment unit

// Desks are soft-blocked: agents route *around* the bullpen workstations rather
// than walking over them — but the start/goal tile is always allowed so an agent
// can still reach (and leave) its own desk.
const DESKS = new Set<number>();
for (const [tx, ty] of BULLPEN_DESKS) DESKS.add(ty * GW + tx);

function walkable(tx: number, ty: number, allow?: Set<number>): boolean {
  if (tx < 1 || tx > GW - 2 || ty < 0 || ty > GH - 1) return false;
  const k = ty * GW + tx;
  if (BLOCKED.has(k)) return false;
  if (DESKS.has(k) && !(allow && allow.has(k))) return false;
  return true;
}

// --- partition walls: block an edge between adjacent tiles, except at doors -----
const H_DOORS = new Set([5, 14, 22]); // main horizontal wall (row 6|7)
function edgeOpen(ax: number, ay: number, bx: number, by: number): boolean {
  if (ax === bx) {
    const lo = Math.min(ay, by), hi = Math.max(ay, by);
    if (lo === 6 && hi === 7 && !H_DOORS.has(ax)) return false; // reactor/meeting/server ↔ floor
    if (lo === 12 && hi === 13 && ax >= 20 && ax !== 22) return false; // canteen ↔ containment
  } else if (ay === by) {
    const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
    if (lo === 8 && hi === 9 && ay >= 1 && ay <= 6 && ay !== 4) return false; // reactor ↔ meeting
    if (lo === 18 && hi === 19 && ay >= 1 && ay <= 6 && ay !== 3) return false; // meeting ↔ server
    if (lo === 18 && hi === 19 && ay >= 8 && ay <= 18 && ay !== 12) return false; // bullpen ↔ canteen
  }
  return true;
}

const tileOf = (p: Pt): [number, number] => [
  Math.min(GW - 1, Math.max(0, Math.floor(p.x / T))),
  Math.min(GH - 1, Math.max(0, Math.floor(p.y / T))),
];
const tileCenter = (tx: number, ty: number): Pt => ({ x: tx * T + T / 2, y: ty * T + T * 0.72 });

function nearestWalkable(tx: number, ty: number, allow?: Set<number>): [number, number] {
  if (walkable(tx, ty, allow)) return [tx, ty];
  for (let r = 1; r < 8; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (walkable(tx + dx, ty + dy, allow)) return [tx + dx, ty + dy];
  return [tx, ty];
}

/** A* over the tile graph. Returns world-space waypoints ending exactly at `to`. */
export function findPath(from: Pt, to: Pt): Pt[] {
  const [rsx, rsy] = tileOf(from);
  const [rgx, rgy] = tileOf(to);
  // Always let the agent stand on its own start/goal desk tile.
  const allow = new Set<number>([rsy * GW + rsx, rgy * GW + rgx]);
  let [sx, sy] = nearestWalkable(rsx, rsy, allow);
  let [gx, gy] = nearestWalkable(rgx, rgy, allow);
  if (sx === gx && sy === gy) return [to];

  const N = GW * GH;
  const key = (x: number, y: number) => y * GW + x;
  const came = new Int32Array(N).fill(-1);
  const g = new Float32Array(N).fill(Infinity);
  const open: number[] = [];
  const start = key(sx, sy), goal = key(gx, gy);
  g[start] = 0;
  open.push(start);
  const h = (x: number, y: number) => Math.abs(x - gx) + Math.abs(y - gy);
  const f = new Float32Array(N);
  f[start] = h(sx, sy);

  while (open.length) {
    // pick lowest f (small graph — linear scan is fine)
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (f[open[i]] < f[open[bi]]) bi = i;
    const cur = open.splice(bi, 1)[0];
    if (cur === goal) break;
    const cx = cur % GW, cy = (cur / GW) | 0;
    for (const [nx, ny] of [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]] as const) {
      if (!walkable(nx, ny, allow) || !edgeOpen(cx, cy, nx, ny)) continue;
      const nk = key(nx, ny), ng = g[cur] + 1;
      if (ng < g[nk]) {
        came[nk] = cur;
        g[nk] = ng;
        f[nk] = ng + h(nx, ny);
        if (!open.includes(nk)) open.push(nk);
      }
    }
  }

  if (came[goal] === -1 && goal !== start) return [to]; // unreachable → direct fallback
  const tiles: number[] = [];
  for (let c = goal; c !== -1 && c !== start; c = came[c]) tiles.push(c);
  tiles.reverse();
  const pts = tiles.map((c) => tileCenter(c % GW, (c / GW) | 0));
  if (pts.length) pts[pts.length - 1] = to; // land exactly on the requested spot
  else pts.push(to);
  return pts;
}

/** Attractions offline agents wander between (world-space, with a dwell range). */
export const POIS: { name: string; x: number; y: number; dwell: [number, number] }[] = [
  { name: "coffee", ...tileCenter(20, 10), dwell: [3, 6] },
  { name: "cooler", ...tileCenter(22, 12), dwell: [2, 5] },
  { name: "servers", ...tileCenter(22, 3), dwell: [2, 4] },
  { name: "ultron", ...tileCenter(22, 17), dwell: [3, 6] }, // poke Ultron in containment
  { name: "meeting", ...tileCenter(14, 5), dwell: [2, 4] },
  { name: "fabricator", ...tileCenter(16, 10), dwell: [2, 4] },
  { name: "plantW", ...tileCenter(1, 18), dwell: [1, 3] },
  { name: "plantE", ...tileCenter(28, 18), dwell: [1, 3] },
];
