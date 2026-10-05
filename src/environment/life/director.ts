// The room's director: what each agent is doing, moment to moment.
//
// An agent lives at their station (the room's own pixels, animated in place)
// and gets up when there's a reason: to hand work to a colleague (brief), to
// report back on work they were handed (report), to hand finished work in at
// the room's review spot (deliver), or — only while idle — for a pastime: a
// coffee, the bookshelf, a chat with another idle colleague, a stretch.
// Thinking agents sometimes pace to a board or a window. Working agents stay
// heads-down, and an agent waiting on you heads straight back to their desk.
//
// Pure state and timing; the renderer draws whatever view() returns.
import { Nav, along, dirToward, pathLength } from "./nav";
import { StationLoop } from "./stationLoop";
import { toPoint, type Activity, type ActorView, type CastJson, type Dir, type LifeEvent, type LifeJson, type Point, type SpotJson } from "./types";

export interface Motion {
  /** Standing height, px. */
  height: number;
  /** Px travelled per walk cycle (two steps): moving at this rate keeps planted feet still. */
  stride: number;
  /** Frames in a walk cycle. */
  walkFrames: number;
}

export interface CastMember {
  slotId: string;
  agentId: string;
  activity: Activity;
}

type Why = "chat" | "brief" | "report";
type Step =
  | { kind: "rise" }
  | { kind: "walk"; to: string }
  | { kind: "hold"; poses: readonly string[]; dir: Dir; seconds: number }
  | { kind: "talk"; with: string; why: Why; lead: boolean; seconds: number }
  | { kind: "sit" };

/** Pastimes give way to work; errands for work (brief, report, deliver, answering a visit) don't. */
type PlanKind = "pastime" | "work";

interface Running {
  step: Step;
  t: number;
  path?: Point[];
  length?: number;
  travelled?: number;
  /** Talk: seconds both have been there. */
  together?: number;
  /** Talk: seconds spent waiting for the other. */
  waited?: number;
  /** Sit: getting back down has started. */
  sitting?: boolean;
}

interface Actor {
  slotId: string;
  agentId: string;
  activity: Activity;
  cast: CastJson;
  motion: Motion | null;
  loop: StationLoop;
  view: ActorView;
  pos: Point;
  /** The last walkway point they stood on; null while at the station or getting up. */
  node: string | null;
  dir: Dir;
  /** Out of the station: drawn as a character rather than the room's cut-out. */
  up: boolean;
  plan: Step[];
  planKind: PlanKind | null;
  current: Running | null;
  claims: string[];
  queue: LifeEvent[];
  nextChoice: number;
  /** Seconds left nodding along while a colleague talks to them at their station. */
  attentive: number;
}

const RISE_SECONDS = 0.45;
const SETTLE_SECONDS = 0.25;
const WALK_CYCLE_SECONDS = 1.1;
const TALK_TURN_SECONDS = 2.4;
const BREATH_SECONDS = 1.15;
const PARTNER_WAIT_SECONDS = 12;
const QUEUE_LIMIT = 3;

type Rng = () => number;

/** Small, seedable PRNG (mulberry32), so tests and captures are repeatable. */
export function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rng: Rng, lo: number, hi: number) => lo + rng() * (hi - lo);
const pick = <T>(rng: Rng, items: readonly T[]): T | undefined => items[Math.floor(rng() * items.length)];

export class Director {
  private readonly nav: Nav;
  private readonly actors = new Map<string, Actor>();
  private readonly claims = new Map<string, string>();
  private readonly rng: Rng;

  constructor(
    private readonly life: LifeJson,
    private readonly motions: Readonly<Record<string, Motion | undefined>>,
    seed = Date.now(),
  ) {
    this.nav = new Nav(life.nodes, life.edges);
    this.rng = seeded(seed);
  }

  /** Who is in the room and what they're up to. Agents keep their state across calls. */
  setCast(cast: readonly CastMember[]): void {
    const live = new Set(cast.map((c) => c.slotId));
    for (const [slotId, actor] of this.actors) {
      if (!live.has(slotId)) {
        this.release(actor);
        this.actors.delete(slotId);
      }
    }
    for (const member of cast) {
      const castJson = this.life.cast[member.slotId];
      if (!castJson) continue;
      let actor = this.actors.get(member.slotId);
      if (!actor || actor.agentId !== member.agentId) {
        if (actor) this.release(actor);
        actor = this.newActor(member, castJson);
        this.actors.set(member.slotId, actor);
      }
      actor.activity = member.activity;
    }
  }

  /** Things that should send someone across the room. Unknown agents are ignored. */
  push(events: readonly LifeEvent[]): void {
    for (const event of events) {
      const actor = this.byAgent(event.from);
      if (!actor || !actor.motion) continue;
      if (actor.queue.some((q) => q.kind === event.kind && q.to === event.to)) continue;
      if (actor.queue.length < QUEUE_LIMIT) actor.queue.push(event);
    }
  }

  update(dt: number): void {
    for (const actor of this.actors.values()) this.tick(actor, dt);
  }

  view(slotId: string): ActorView | null {
    return this.actors.get(slotId)?.view ?? null;
  }

  /** Feet of everyone out of their station, by slot. */
  walkers(): Map<string, Point> {
    const out = new Map<string, Point>();
    for (const a of this.actors.values()) if (a.up) out.set(a.slotId, a.pos);
    return out;
  }

  /** Dev: send someone idle on a pastime right now; false when nobody can go. */
  liven(): boolean {
    const free = [...this.actors.values()].filter((a) => this.available(a));
    for (const actor of free.sort(() => this.rng() - 0.5)) {
      if (this.planPastime(actor, true)) return true;
    }
    return false;
  }

  // ─── actors ────────────────────────────────────────────────────────────────

  private newActor(member: CastMember, cast: CastJson): Actor {
    const motion = this.motions[member.slotId] ?? null;
    const home = this.nav.point(cast.node);
    return {
      slotId: member.slotId,
      agentId: member.agentId,
      activity: member.activity,
      cast,
      motion,
      loop: new StationLoop(cast.parts.hands?.length ?? 0, this.rng),
      view: { kind: "station", head: "rest", hand: -1 },
      pos: home,
      node: null,
      dir: cast.face,
      up: false,
      plan: [],
      planKind: null,
      current: null,
      claims: [],
      queue: [],
      // Stagger the first moves so the room wakes up gradually.
      nextChoice: between(this.rng, 4, 22),
      attentive: 0,
    };
  }

  private byAgent(agentId: string): Actor | undefined {
    for (const a of this.actors.values()) if (a.agentId === agentId) return a;
    return undefined;
  }

  /** At their station with nothing planned, and free to get up. */
  private available(a: Actor): boolean {
    return Boolean(a.motion) && !a.up && !a.current && a.plan.length === 0 && a.activity !== "waiting" && a.attentive <= 0;
  }

  private seat(a: Actor): Point {
    return a.cast.rise ? toPoint(a.cast.rise) : this.nav.point(a.cast.node);
  }

  private standDir(a: Actor): Dir {
    return a.cast.seated ? (`S${a.cast.face[1]}` as Dir) : a.cast.face;
  }

  // ─── the frame loop ──────────────────────────────────────────────────────────

  private tick(a: Actor, dt: number): void {
    this.enforce(a);
    if (!a.current && a.plan.length) this.begin(a);
    if (a.current) {
      this.run(a, dt);
      return;
    }
    // At the station.
    a.attentive = Math.max(0, a.attentive - dt);
    a.view = a.loop.update(dt, a.activity, a.attentive > 0);
    if (!a.motion || a.attentive > 0) return;
    a.nextChoice -= dt;
    if (a.queue.length && a.activity !== "waiting") {
      const event = a.queue.shift()!;
      this.planEvent(a, event);
      return;
    }
    if (a.nextChoice <= 0) this.decide(a);
  }

  /** Status wins over pastimes: work calls them back, and waiting on you sends them straight to their desk. */
  private enforce(a: Actor): void {
    if (!a.up) return;
    const heading = a.plan.length > 0 || a.current !== null;
    if (!heading) return;
    if (a.activity === "waiting" && a.planKind !== null) {
      this.goHome(a);
      a.planKind = null;
      return;
    }
    if (a.planKind === "pastime" && (a.activity === "working" || a.activity === "thinking" || a.activity === "waiting")) {
      // Wrap up what they're doing (finish the sentence), then head back.
      const cur = a.current;
      if (cur && (cur.step.kind === "hold" || cur.step.kind === "talk")) {
        const seconds = cur.step.seconds;
        const done = cur.step.kind === "talk" ? (cur.together ?? 0) : cur.t;
        if (seconds - done > 0.8) cur.step = { ...cur.step, seconds: done + 0.8 };
      }
      a.planKind = "work";
    }
  }

  private goHome(a: Actor): void {
    this.endTalk(a);
    a.plan = [{ kind: "walk", to: a.cast.node }, { kind: "sit" }];
    a.current = null;
  }

  private begin(a: Actor): void {
    const step = a.plan.shift()!;
    a.current = { step, t: 0 };
    if (step.kind === "rise") {
      a.up = true;
      if (a.cast.seated) {
        a.pos = this.seat(a);
        a.node = null;
        a.dir = this.standDir(a);
      } else {
        a.node = a.cast.node;
        a.pos = this.nav.point(a.cast.node);
        a.dir = a.cast.face;
      }
    } else if (step.kind === "walk") {
      const from = a.node ?? a.cast.node;
      const route = this.nav.route(from, step.to);
      if (!route) {
        // No way there from here: give up on the plan and go back.
        a.current = null;
        if (step.to !== a.cast.node) this.goHome(a);
        else a.plan = a.plan.filter((s) => s.kind === "sit");
        return;
      }
      const points = [a.pos, ...route.map((id) => this.nav.point(id))].filter(
        (p, i, all) => i === 0 || Math.hypot(p.x - all[i - 1].x, p.y - all[i - 1].y) > 0.5,
      );
      a.current.path = points;
      a.current.length = pathLength(points);
      a.current.travelled = 0;
    }
  }

  private run(a: Actor, dt: number): void {
    const cur = a.current!;
    cur.t += dt;
    const step = cur.step;
    switch (step.kind) {
      case "rise": {
        if (!a.cast.seated) return this.finish(a);
        const pose = cur.t < RISE_SECONDS ? "rise" : "stand";
        a.view = this.pose(a, pose, a.dir, false);
        if (cur.t >= RISE_SECONDS + SETTLE_SECONDS) this.finish(a);
        return;
      }
      case "walk":
        return this.walk(a, cur, dt, step.to);
      case "hold": {
        const share = step.seconds / step.poses.length;
        const pose = step.poses[Math.min(step.poses.length - 1, Math.floor(cur.t / share))];
        a.dir = step.dir;
        a.view = this.pose(a, pose, step.dir, Math.floor(cur.t / BREATH_SECONDS) % 2 === 1);
        if (cur.t >= step.seconds) this.finish(a);
        return;
      }
      case "talk":
        return this.talk(a, cur, step, dt);
      case "sit":
        return this.sit(a, cur, dt);
    }
  }

  private walk(a: Actor, cur: Running, dt: number, to: string): void {
    const motion = a.motion!;
    const path = cur.path!;
    const length = cur.length!;
    const speed = motion.stride / WALK_CYCLE_SECONDS;
    cur.travelled = Math.min(length, cur.travelled! + speed * dt);
    const { at, from, to: next } = along(path, cur.travelled);
    a.pos = at;
    if (Math.hypot(next.x - from.x, next.y - from.y) > 0.5) a.dir = dirToward(from, next, a.dir);
    const frame = Math.floor((cur.travelled / motion.stride) * motion.walkFrames) % motion.walkFrames;
    a.view = { kind: "walker", pose: "walk", frame, breath: false, dir: a.dir, x: at.x, y: at.y };
    if (cur.travelled >= length) {
      a.node = to;
      a.pos = this.nav.point(to);
      // Arrived: stand still (feet together) rather than freeze mid-stride.
      a.view = this.pose(a, "stand", a.dir, false);
      this.finish(a);
    }
  }

  private talk(a: Actor, cur: Running, step: Extract<Step, { kind: "talk" }>, dt: number): void {
    const other = this.actors.get(step.with);
    const there = other ? this.partnerPoint(other) : a.pos;
    a.dir = dirToward(a.pos, there, a.dir);
    if (!other) return this.finish(a);
    // Someone up and about is here once they're in this conversation too; someone at their station always is.
    const present = other.up ? other.current?.step.kind === "talk" && other.current.step.with === a.slotId : true;
    if (!present) {
      cur.waited = (cur.waited ?? 0) + dt;
      a.view = this.pose(a, "stand", a.dir, Math.floor(cur.t / BREATH_SECONDS) % 2 === 1);
      if (cur.waited > PARTNER_WAIT_SECONDS) this.finish(a);
      return;
    }
    if (!other.up) {
      // At their desk: if they can stand to talk, they do; else they nod along.
      if (step.lead && this.canAnswer(other)) this.answer(other, a, step.seconds - (cur.together ?? 0));
      else other.attentive = 0.5;
    }
    cur.together = (cur.together ?? 0) + dt;
    const together = cur.together;
    const leadSpeaks = Math.floor(together / TALK_TURN_SECONDS) % 2 === 0;
    const speaking = step.lead === leadSpeaks;
    let pose: string;
    if (step.why === "report" && step.lead && together < 1.6) pose = "folder";
    else if (speaking) pose = Math.floor(together * 1.6) % 3 === 2 ? "stand" : "talk";
    else pose = Math.floor(together / 1.7) % 4 === 3 ? "think" : "listen";
    a.view = this.pose(a, pose, a.dir, !speaking && Math.floor(together / BREATH_SECONDS) % 2 === 1);
    if (together >= step.seconds) this.finish(a);
  }

  /** Where to look when talking to someone: at them if they're up, else at their seat. */
  private partnerPoint(other: Actor): Point {
    return other.up ? other.pos : this.seat(other);
  }

  /** A standing station's agent, free, can turn and talk to a visitor. */
  private canAnswer(other: Actor): boolean {
    return !other.cast.seated && this.available(other) && other.activity !== "offline";
  }

  private answer(other: Actor, visitor: Actor, seconds: number): void {
    other.plan = [{ kind: "rise" }, { kind: "talk", with: visitor.slotId, why: "brief", lead: false, seconds: Math.max(1, seconds) }, { kind: "sit" }];
    other.planKind = "work";
  }

  private sit(a: Actor, cur: Running, dt: number): void {
    if (!a.cast.seated) {
      a.up = false;
      a.node = null;
      a.dir = a.cast.face;
      return this.finish(a);
    }
    const seat = this.seat(a);
    const gap = Math.hypot(seat.x - a.pos.x, seat.y - a.pos.y);
    if (!cur.sitting && gap > 1 && a.motion) {
      // Step over to the chair.
      const speed = a.motion.stride / WALK_CYCLE_SECONDS;
      const move = Math.min(gap, speed * dt);
      const from = a.pos;
      a.pos = { x: from.x + ((seat.x - from.x) / gap) * move, y: from.y + ((seat.y - from.y) / gap) * move };
      a.dir = dirToward(from, seat, a.dir);
      cur.travelled = (cur.travelled ?? 0) + move;
      const frame = Math.floor((cur.travelled / a.motion.stride) * a.motion.walkFrames) % a.motion.walkFrames;
      a.view = { kind: "walker", pose: "walk", frame, breath: false, dir: a.dir, x: a.pos.x, y: a.pos.y };
      cur.t = 0;
      return;
    }
    cur.sitting = true;
    a.dir = this.standDir(a);
    a.view = this.pose(a, "rise", a.dir, false);
    if (cur.t >= RISE_SECONDS) {
      a.up = false;
      a.node = null;
      a.pos = this.nav.point(a.cast.node);
      a.dir = a.cast.face;
      this.finish(a);
    }
  }

  private finish(a: Actor): void {
    const step = a.current?.step;
    a.current = null;
    if (step?.kind === "walk") this.releaseExcept(a, step.to);
    if (a.plan.length === 0) {
      this.release(a);
      a.planKind = null;
      if (!a.up) {
        a.view = a.loop.update(0, a.activity);
        a.nextChoice = this.restAfter(a);
      }
    }
  }

  private endTalk(a: Actor): void {
    // Whoever was talking to them stops too.
    for (const other of this.actors.values()) {
      const step = other.current?.step;
      if (other !== a && step?.kind === "talk" && step.with === a.slotId) other.current!.step = { ...step, seconds: 0 };
    }
  }

  private pose(a: Actor, pose: string, dir: Dir, breath: boolean): ActorView {
    return { kind: "walker", pose, frame: 0, breath, dir, x: a.pos.x, y: a.pos.y };
  }

  // ─── choosing what to do ──────────────────────────────────────────────────────

  private restAfter(a: Actor): number {
    switch (a.activity) {
      case "idle":
        return between(this.rng, 14, 38);
      case "offline":
        return between(this.rng, 22, 55);
      case "thinking":
        return between(this.rng, 25, 55);
      default:
        return between(this.rng, 30, 60);
    }
  }

  private decide(a: Actor): void {
    a.nextChoice = this.restAfter(a);
    if (!this.available(a)) return;
    if (a.activity === "thinking") {
      // Sometimes pace over to a board or a window to think it through.
      if (this.rng() < 0.5) this.planSpot(a, (s) => s.kind === "think" || (s.kind === "local" && s.for === a.slotId), "work");
      return;
    }
    if (a.activity === "idle" || a.activity === "offline") this.planPastime(a, false);
  }

  private planPastime(a: Actor, eager: boolean): boolean {
    const roll = this.rng();
    const mine = (s: SpotJson) => s.kind === "local" && s.for === a.slotId;
    if (roll < 0.25 || eager) {
      if (this.planChat(a)) return true;
    }
    if (roll < 0.7 || eager) {
      if (this.planSpot(a, (s) => s.kind === "errand" || s.kind === "think" || mine(s), "pastime")) return true;
    }
    if (roll < 0.85 || eager) {
      if (this.planSpot(a, mine, "pastime")) return true;
    }
    // A stretch where they are.
    a.plan = [{ kind: "rise" }, { kind: "hold", poses: ["stretch", "stand"], dir: this.standDir(a), seconds: 3.2 }, { kind: "sit" }];
    a.planKind = "pastime";
    return true;
  }

  /** Go to a free spot that matches, do what it's for, and come back. */
  private planSpot(a: Actor, match: (s: SpotJson) => boolean, kind: PlanKind): boolean {
    const options = this.life.spots.filter((s) => match(s) && !this.claimedByOther(s.node, a) && this.nav.reachable(a.cast.node, s.node));
    const spot = pick(this.rng, options);
    if (!spot) return false;
    this.claim(a, spot.node);
    const seconds = between(this.rng, spot.dwell[0], spot.dwell[1] ?? spot.dwell[0]);
    a.plan = [{ kind: "rise" }, { kind: "walk", to: spot.node }, { kind: "hold", poses: spot.poses, dir: spot.face, seconds }, { kind: "walk", to: a.cast.node }, { kind: "sit" }];
    a.planKind = kind;
    return true;
  }

  /** Two idle colleagues meet halfway for a chat. */
  private planChat(a: Actor): boolean {
    const partners = [...this.actors.values()].filter(
      (b) => b !== a && this.available(b) && (b.activity === "idle" || b.activity === "offline"),
    );
    for (const b of partners.sort(() => this.rng() - 0.5)) {
      for (const pair of [...this.life.meets].sort(() => this.rng() - 0.5)) {
        for (const [mine, theirs] of [[pair[0], pair[1]], [pair[1], pair[0]]]) {
          if (this.claimedByOther(mine, a) || this.claimedByOther(theirs, b)) continue;
          if (!this.nav.reachable(a.cast.node, mine) || !this.nav.reachable(b.cast.node, theirs)) continue;
          const seconds = between(this.rng, 8, 14);
          this.claim(a, mine);
          this.claim(b, theirs);
          a.plan = [{ kind: "rise" }, { kind: "walk", to: mine }, { kind: "talk", with: b.slotId, why: "chat", lead: true, seconds }, { kind: "walk", to: a.cast.node }, { kind: "sit" }];
          b.plan = [{ kind: "rise" }, { kind: "walk", to: theirs }, { kind: "talk", with: a.slotId, why: "chat", lead: false, seconds }, { kind: "walk", to: b.cast.node }, { kind: "sit" }];
          a.planKind = "pastime";
          b.planKind = "pastime";
          return true;
        }
      }
    }
    return false;
  }

  private planEvent(a: Actor, event: LifeEvent): void {
    if (event.kind === "deliver") {
      if (!this.planSpot(a, (s) => s.kind === "review", "work")) return;
      // Hand it in: show the report, then put it down.
      const hold = a.plan.find((s) => s.kind === "hold");
      if (hold && hold.kind === "hold") Object.assign(hold, { poses: ["folder", "reach", "reach"], seconds: 3.6 });
      return;
    }
    const target = event.to ? this.byAgent(event.to) : undefined;
    const visit = target?.cast.visit;
    if (!target || target === a || !visit || this.claimedByOther(visit, a) || !this.nav.reachable(a.cast.node, visit)) return;
    this.claim(a, visit);
    const seconds = event.kind === "brief" ? between(this.rng, 6, 9) : between(this.rng, 5, 7);
    a.plan = [{ kind: "rise" }, { kind: "walk", to: visit }, { kind: "talk", with: target.slotId, why: event.kind, lead: true, seconds }, { kind: "walk", to: a.cast.node }, { kind: "sit" }];
    a.planKind = "work";
  }

  // ─── claims: one person per spot ─────────────────────────────────────────────

  private claimedByOther(node: string, a: Actor): boolean {
    const owner = this.claims.get(node);
    return owner !== undefined && owner !== a.slotId;
  }

  private claim(a: Actor, node: string): void {
    this.claims.set(node, a.slotId);
    a.claims.push(node);
  }

  private releaseExcept(a: Actor, keep: string): void {
    // Walking away from a claimed spot frees it.
    for (const node of a.claims) if (node !== keep && this.claims.get(node) === a.slotId && a.node !== node) this.claims.delete(node);
    a.claims = a.claims.filter((n) => this.claims.get(n) === a.slotId);
  }

  private release(a: Actor): void {
    for (const node of a.claims) if (this.claims.get(node) === a.slotId) this.claims.delete(node);
    a.claims = [];
  }
}
