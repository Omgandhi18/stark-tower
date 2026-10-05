// A seated character getting up, walking to a colleague, talking, and coming
// back to sit down. Pure timing and geometry; the renderer draws whatever
// frame this returns.
import type { Point } from "./camera";
import type { AnimationSpec, CharacterSpec } from "./characterAssets";

export interface VisitPlan {
  risePoint: Point;
  standPoint: Point;
  /** Feet path from the stand point to the person being visited. */
  route: readonly Point[];
  pause: { talk: number; listen: number; stand: number };
}

export interface ActorFrame {
  /** True while the character is in their seat (drawn by the seat cut-out). */
  seated: boolean;
  animation: string;
  frame: number;
  /** Feet position, world px. */
  x: number;
  y: number;
}

/** Hold after standing up / before sitting down. */
const SETTLE_SECONDS = 0.35;
/** Side view held while turning into or out of a walk. */
const TURN_SECONDS = 0.15;
/** The passing pose a walk starts and stops on comes round every half cycle. */
const HALF_CYCLE = 0.5;

type Playback = "loop" | "once" | "reverse";

interface Walk {
  /** World px per loop, stretched slightly so the walk ends on a passing pose. */
  stride: number;
  startFrame: number;
}

interface Segment {
  animation: string;
  duration: number;
  playback: Playback;
  path: readonly Point[];
  /** Walking segments advance their cycle with distance, so planted feet don't slide. */
  walk?: Walk;
}

function pathLength(path: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return total;
}

function pointAlong(path: readonly Point[], distance: number): Point {
  let left = distance;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= step || i === path.length - 1) {
      const t = step === 0 ? 1 : Math.min(left / step, 1);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    left -= step;
  }
  return path[path.length - 1];
}

function walkSegment(animation: string, spec: AnimationSpec, path: readonly Point[]): Segment {
  if (spec.stride === undefined) throw new Error(`Walk animation "${animation}" has no stride`);
  const length = pathLength(path);
  const halfCycles = Math.max(1, Math.round(length / (spec.stride * HALF_CYCLE)));
  const stride = length / (halfCycles * HALF_CYCLE);
  const speed = (stride * spec.fps) / spec.frames.length;
  return { animation, duration: length / speed, playback: "loop", path, walk: { stride, startFrame: spec.startFrame ?? 0 } };
}

/** Frame nearest to where the cycle should be after walking `travelled` px. */
function walkFrame(walk: Walk, travelled: number, count: number): number {
  const cycle = walk.startFrame / count + travelled / walk.stride;
  return Math.round(cycle * count) % count;
}

export class VisitRoutine {
  private segments: Segment[] = [];
  private elapsed = 0;

  constructor(
    private readonly plan: VisitPlan,
    private readonly character: CharacterSpec,
  ) {}

  get active(): boolean {
    return this.segments.length > 0;
  }

  start(): void {
    const { plan, character } = this;
    const spec = (name: string) => character.animations[name];
    const riseSeconds = spec("rise").frames.length / spec("rise").fps;
    const hold = (animation: string, duration: number, p: Point, playback: Playback = "loop"): Segment => ({
      animation,
      duration,
      playback,
      path: [p],
    });
    const out = plan.route;
    const back = [...plan.route].reverse();
    const end = out[out.length - 1];
    this.segments = [
      hold("rise", riseSeconds, plan.risePoint, "once"),
      hold("stand", SETTLE_SECONDS, plan.standPoint),
      hold("sideRight", TURN_SECONDS, plan.standPoint),
      walkSegment("walkRight", spec("walkRight"), out),
      hold("sideRight", TURN_SECONDS, end),
      hold("talk", plan.pause.talk, end),
      hold("listen", plan.pause.listen, end),
      hold("stand", plan.pause.stand, end),
      hold("sideLeft", TURN_SECONDS, end),
      walkSegment("walkLeft", spec("walkLeft"), back),
      hold("sideLeft", TURN_SECONDS, plan.standPoint),
      hold("stand", SETTLE_SECONDS, plan.standPoint),
      hold("rise", riseSeconds, plan.risePoint, "reverse"),
    ];
    this.elapsed = 0;
  }

  stop(): void {
    this.segments = [];
  }

  /** Advance by `dt` seconds; returns the frame to draw, or a seated frame once finished. */
  update(dt: number): ActorFrame {
    this.elapsed += dt;
    let t = this.elapsed;
    for (const segment of this.segments) {
      if (t < segment.duration) return this.frameIn(segment, t);
      t -= segment.duration;
    }
    this.segments = [];
    const seat = this.plan.risePoint;
    return { seated: true, animation: "seated", frame: 0, x: seat.x, y: seat.y };
  }

  private frameIn(segment: Segment, t: number): ActorFrame {
    const count = this.character.animations[segment.animation].frames.length;
    const travelled = (t / segment.duration) * pathLength(segment.path);
    const position = segment.path.length > 1 ? pointAlong(segment.path, travelled) : segment.path[0];
    const frame = segment.walk ? walkFrame(segment.walk, travelled, count) : this.timedFrame(segment, t, count);
    return { seated: false, animation: segment.animation, frame, x: position.x, y: position.y };
  }

  private timedFrame(segment: Segment, t: number, count: number): number {
    const raw = Math.floor(t * this.character.animations[segment.animation].fps);
    if (segment.playback === "loop") return raw % count;
    return segment.playback === "once" ? Math.min(raw, count - 1) : Math.max(count - 1 - raw, 0);
  }
}
