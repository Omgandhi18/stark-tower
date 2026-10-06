import { describe, expect, it } from "vitest";
import { THEMES } from "../../app/theme";
import type { Task } from "../../lib/types";
import { roomFor } from "../reference/rooms";
import { characterArt, frameFor, motionOf } from "./characters";
import { Director, type CastMember, type Motion } from "./director";
import { lifeEvents } from "./events";
import { Nav, dirToward } from "./nav";
import { StationLoop } from "./stationLoop";
import type { Activity, LifeJson } from "./types";

const THEME_IDS = THEMES.map((t) => t.id);
const MOTION: Motion = { height: 165, stride: 100, walkFrames: 8 };
const FRAME = 1 / 30;

/** Everyone in the room can walk (the art is generated separately; the director only needs sizes). */
function motionsFor(life: LifeJson): Record<string, Motion> {
  return Object.fromEntries(Object.keys(life.cast).map((slot) => [slot, MOTION]));
}

function castOf(life: LifeJson, activity: Activity | ((slot: string) => Activity)): CastMember[] {
  return Object.keys(life.cast).map((slotId) => ({ slotId, agentId: `agent-${slotId}`, activity: typeof activity === "string" ? activity : activity(slotId) }));
}

function run(director: Director, seconds: number, each?: () => void): void {
  for (let t = 0; t < seconds; t += FRAME) {
    director.update(FRAME);
    each?.();
  }
}

describe("each room's life data", () => {
  it.each(THEME_IDS)("%s: names only points, stations and spots that exist", (id) => {
    const room = roomFor(id);
    const life = room.life;
    const nav = new Nav(life.nodes, life.edges);
    for (const [slot, cast] of Object.entries(life.cast)) {
      expect(room.scene.stations[slot], slot).toBeDefined();
      expect(nav.points.has(cast.node), `${slot}.node`).toBe(true);
      if (cast.visit) expect(nav.points.has(cast.visit), `${slot}.visit`).toBe(true);
      if (cast.seated) expect(cast.rise, `${slot}.rise`).toHaveLength(2);
      const cutout = room.cutouts[room.scene.stations[slot].cutout].rect;
      const [w, h] = [cutout[2] - cutout[0], cutout[3] - cutout[1]];
      for (const box of [cast.parts.head, ...(cast.parts.hands ?? [])]) {
        expect(box[0] >= 0 && box[1] >= 0 && box[2] <= w && box[3] <= h && box[0] < box[2] && box[1] < box[3], `${slot} box ${box}`).toBe(true);
      }
    }
    for (const spot of life.spots) {
      expect(nav.points.has(spot.node), spot.id).toBe(true);
      if (spot.for) expect(life.cast[spot.for], spot.id).toBeDefined();
    }
    for (const pair of life.meets) for (const node of pair) expect(nav.points.has(node), node).toBe(true);
  });

  it.each(THEME_IDS)("%s: lets every agent reach their own spots and every visit point be reached by a colleague", (id) => {
    const life = roomFor(id).life;
    const nav = new Nav(life.nodes, life.edges);
    for (const spot of life.spots.filter((s) => s.for)) expect(nav.reachable(life.cast[spot.for!].node, spot.node), spot.id).toBe(true);
    for (const [slot, cast] of Object.entries(life.cast)) {
      if (!cast.visit) continue;
      const others = Object.entries(life.cast).filter(([other]) => other !== slot);
      expect(
        others.some(([, other]) => nav.reachable(other.node, cast.visit!)),
        `${slot} can be visited`,
      ).toBe(true);
    }
  });

  it.each(THEME_IDS)("%s: has character art for every station, with every pose the director asks for", (id) => {
    const room = roomFor(id);
    for (const slot of room.scene.slots) {
      if (!room.life.cast[slot.id]) continue;
      const art = characterArt(room.folder, slot.figure);
      if (!art) continue; // art is generated per theme; a missing figure just stays at their station
      for (const pose of ["stand", "talk", "listen", "think", "coffee", "read", "reach", "stretch", "rise", "folder", "walk"]) {
        for (const dir of ["SE", "SW", "NE", "NW"] as const) {
          const { name } = frameFor(art.json, pose, dir, false, 0);
          expect(art.json.frames[name], `${id}/${slot.figure} ${pose} ${dir}`).toBeDefined();
        }
      }
      const motion = motionOf(art.json);
      expect(motion.stride).toBeGreaterThan(0);
      expect(motion.walkFrames).toBeGreaterThanOrEqual(8);
    }
  });
});

describe("the director", () => {
  const life = roomFor("rnd").life;

  it("starts everyone at their station, as the room paints them", () => {
    const director = new Director(life, motionsFor(life), 1);
    director.setCast(castOf(life, "idle"));
    director.update(FRAME);
    for (const slot of Object.keys(life.cast)) expect(director.view(slot)?.kind, slot).toBe("station");
  });

  it("keeps working agents heads-down at their desks", () => {
    const director = new Director(life, motionsFor(life), 2);
    director.setCast(castOf(life, "working"));
    let typed = false;
    run(director, 240, () => {
      for (const slot of Object.keys(life.cast)) {
        const view = director.view(slot);
        expect(view?.kind, slot).toBe("station");
        if (view?.kind === "station" && view.hand >= 0) typed = true;
      }
    });
    expect(typed).toBe(true);
  });

  it("lets idle agents get up, go somewhere and come back", () => {
    const director = new Director(life, motionsFor(life), 3);
    director.setCast(castOf(life, "idle"));
    const walked = new Set<string>();
    const poses = new Set<string>();
    run(director, 240, () => {
      for (const slot of Object.keys(life.cast)) {
        const view = director.view(slot);
        if (view?.kind === "walker") {
          poses.add(view.pose);
          if (view.pose === "walk") walked.add(slot);
        }
      }
    });
    expect(walked.size).toBeGreaterThanOrEqual(3);
    expect(poses).toContain("walk");
    // Everyone gets home again once the room is told they're working.
    director.setCast(castOf(life, "working"));
    run(director, 40);
    for (const slot of Object.keys(life.cast)) expect(director.view(slot)?.kind, slot).toBe("station");
  });

  it("never sends a working agent on a break", () => {
    const director = new Director(life, motionsFor(life), 7);
    director.setCast(castOf(life, "working"));
    director.update(FRAME);
    expect(director.liven()).toBe(false);
  });

  it("sends an agent waiting on you straight back to their desk", () => {
    const director = new Director(life, motionsFor(life), 4);
    director.setCast(castOf(life, (slot) => (slot === "buildBay" ? "idle" : "working")));
    director.update(FRAME);
    expect(director.liven()).toBe(true);
    run(director, 2);
    expect(director.view("buildBay")?.kind).toBe("walker");
    director.setCast(castOf(life, (slot) => (slot === "buildBay" ? "waiting" : "working")));
    run(director, 25);
    expect(director.view("buildBay")?.kind).toBe("station");
  });

  it("walks over to brief a colleague, talks, and comes back", () => {
    const director = new Director(life, motionsFor(life), 5);
    director.setCast(castOf(life, "working"));
    director.push([{ kind: "brief", from: "agent-buildBay", to: "agent-reviewWall" }]);
    const visit = new Nav(life.nodes, life.edges).point(life.cast.reviewWall.visit!);
    let talkedThere = false;
    let answered = false;
    run(director, 45, () => {
      const view = director.view("buildBay");
      if (view?.kind === "walker" && view.pose === "talk" && Math.hypot(view.x - visit.x, view.y - visit.y) < 2) talkedThere = true;
      const host = director.view("reviewWall");
      if (host?.kind === "walker" && (host.pose === "talk" || host.pose === "listen")) answered = true;
    });
    expect(talkedThere).toBe(true);
    // VISION stands at the review wall, so he turns round to talk it through rather than nodding along.
    expect(answered).toBe(true);
    expect(director.view("buildBay")?.kind).toBe("station");
    expect(director.view("reviewWall")?.kind).toBe("station");
  });

  it("drops a visit nobody can walk to", () => {
    const director = new Director(life, motionsFor(life), 6);
    director.setCast(castOf(life, "working"));
    // VERONICA's corner has no walkway to the rest of the floor.
    director.push([{ kind: "brief", from: "agent-bottomDesk", to: "agent-buildBay" }]);
    run(director, 20, () => expect(director.view("bottomDesk")?.kind).toBe("station"));
  });
});

describe("station loops", () => {
  it("type in bursts while working and keep hands still while waiting", () => {
    const loop = new StationLoop(2, () => 0.42);
    let taps = 0;
    for (let t = 0; t < 20; t += FRAME) if (loop.update(FRAME, "working").hand >= 0) taps++;
    expect(taps).toBeGreaterThan(20);
    const waiting = new StationLoop(2, () => 0.42);
    for (let t = 0; t < 20; t += FRAME) expect(waiting.update(FRAME, "waiting").hand).toBe(-1);
  });
});

describe("walkways", () => {
  const nav = new Nav({ a: [0, 0], b: [100, 0], c: [100, 100], d: [500, 500] }, [["a", "b"], ["b", "c"]]);

  it("route along walkways and know when there's none", () => {
    expect(nav.route("a", "c")).toEqual(["a", "b", "c"]);
    expect(nav.route("a", "d")).toBeNull();
  });

  it("face the viewer unless heading away", () => {
    expect(dirToward({ x: 0, y: 0 }, { x: 10, y: 10 })).toBe("SE");
    expect(dirToward({ x: 0, y: 0 }, { x: -10, y: -10 })).toBe("NW");
    expect(dirToward({ x: 0, y: 0 }, { x: 50, y: 1 })).toBe("SE");
    expect(dirToward({ x: 0, y: 0 }, { x: 50, y: 1 }, "NW")).toBe("NE");
  });
});

describe("task cards as moments in the room", () => {
  const task = (id: string, status: string, requested_by: string, assignee = "friday"): Task =>
    ({ id, status, requested_by, assignee, ts: 0, updated: 0, title: id, cwd: "", conversation_id: null, parent_id: null, prompt: "", branch: "", started: null, finished: null, plan_done: null, plan_total: null }) as Task;
  const agents = [{ id: "jarvis" }, { id: "friday" }];

  it("treat the first look as history", () => {
    expect(lifeEvents(null, [task("t1", "doing", "jarvis")], agents).events).toEqual([]);
  });

  it("brief on a new hand-over, report back when it's done, and hand in the developer's work", () => {
    const first = lifeEvents(null, [], agents).marks;
    const handed = lifeEvents(first, [task("t1", "todo", "jarvis"), task("t2", "doing", "you")], agents);
    expect(handed.events).toEqual([{ kind: "brief", from: "jarvis", to: "friday" }]);
    const done = lifeEvents(handed.marks, [task("t1", "done", "jarvis"), task("t2", "done", "you")], agents);
    expect(done.events).toEqual([
      { kind: "report", from: "friday", to: "jarvis" },
      { kind: "deliver", from: "friday" },
    ]);
    expect(lifeEvents(done.marks, [task("t1", "done", "jarvis")], agents).events).toEqual([]);
  });
});
