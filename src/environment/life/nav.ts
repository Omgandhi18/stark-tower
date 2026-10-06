// Where people can walk in a room: named points joined by straight walkways.
// Shortest routes by Dijkstra; small graphs, so a linear scan is plenty.
import { toPoint, type Dir, type Point } from "./types";

export class Nav {
  readonly points: ReadonlyMap<string, Point>;
  private readonly links = new Map<string, Array<{ to: string; cost: number }>>();

  constructor(nodes: Record<string, number[]>, edges: readonly string[][]) {
    const points = new Map<string, Point>();
    for (const [id, p] of Object.entries(nodes)) points.set(id, toPoint(p));
    this.points = points;
    for (const id of points.keys()) this.links.set(id, []);
    for (const [a, b] of edges) {
      const pa = points.get(a);
      const pb = points.get(b);
      if (!pa || !pb) throw new Error(`Walkway ${a}–${b} names a point the room doesn't have.`);
      const cost = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      this.links.get(a)!.push({ to: b, cost });
      this.links.get(b)!.push({ to: a, cost });
    }
  }

  point(id: string): Point {
    const p = this.points.get(id);
    if (!p) throw new Error(`The room has no point called ${id}.`);
    return p;
  }

  /** Node ids from `from` to `to`, both included; null when no walkway joins them. */
  route(from: string, to: string): string[] | null {
    if (from === to) return [from];
    const dist = new Map<string, number>([[from, 0]]);
    const prev = new Map<string, string>();
    const open = new Set([from]);
    while (open.size) {
      let best: string | null = null;
      for (const id of open) if (best === null || dist.get(id)! < dist.get(best)!) best = id;
      const here = best!;
      open.delete(here);
      if (here === to) break;
      for (const { to: next, cost } of this.links.get(here) ?? []) {
        const d = dist.get(here)! + cost;
        if (d < (dist.get(next) ?? Infinity)) {
          dist.set(next, d);
          prev.set(next, here);
          open.add(next);
        }
      }
    }
    if (!dist.has(to)) return null;
    const out = [to];
    while (out[0] !== from) out.unshift(prev.get(out[0])!);
    return out;
  }

  reachable(from: string, to: string): boolean {
    return this.route(from, to) !== null;
  }
}

/** Facing from one point toward another: toward the viewer unless clearly heading away. */
export function dirToward(from: Point, to: Point, previous?: Dir): Dir {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const ew = Math.abs(dx) < 1 && previous ? previous[1] : dx >= 0 ? "E" : "W";
  // Nearly level: keep the way they were facing, else face the viewer.
  const ns = Math.abs(dy) < Math.max(4, Math.abs(dx) * 0.12) ? (previous?.[0] ?? "S") : dy > 0 ? "S" : "N";
  return `${ns}${ew}` as Dir;
}

export function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return total;
}

/** The point `distance` along a path, and the direction of the segment it's on. */
export function along(path: readonly Point[], distance: number): { at: Point; from: Point; to: Point } {
  let left = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= step || i === path.length - 1) {
      const t = step === 0 ? 1 : Math.min(left / step, 1);
      return { at: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, from: a, to: b };
    }
    left -= step;
  }
  const last = path[path.length - 1];
  return { at: last, from: last, to: last };
}
