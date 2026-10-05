// Pixi scene for a theme's room: its plate (every station empty) plus
// everything that changes — each station's agent (the room's own cut-out,
// animated in place), the same agent drawn as a character when they get up and
// walk about, each station's light, the helper bots, and furniture redrawn over
// anyone who passes behind it — in a camera-driven world. A director (../life)
// decides who does what. Without a live cast (reference mode, or reduced
// motion) everyone holds still exactly as the mockup paints them, and the
// ticker only runs while something moves.
import { Application, Assets, Container, Rectangle, Sprite, Texture, type TextureSource } from "pixi.js";
import { characterArt, frameFor, motionOf, type CharacterArt } from "../life/characters";
import { Director, type CastMember, type Motion } from "../life/director";
import { StationFrames } from "../life/stationFrames";
import type { LifeEvent, OccluderJson } from "../life/types";
import type { Camera, Point, Size } from "./camera";
import type { LightJson, Room } from "./rooms";

/** What a station's light says: its agent is working, or waiting on the developer. */
export type StationLight = "working" | "waiting";

export interface SceneState {
  /** Temporary helpers running for the room's helper bots: up to three are drawn, then "+1". */
  helpers: number;
  /** Stations whose character is in place, by slot id; the rest show their station empty. */
  occupied: Readonly<Record<string, boolean>>;
  /** Each station's light, by slot id; a station without one is unlit (as the mockup paints it). */
  lights: Readonly<Record<string, StationLight>>;
  /** Who works where and what they're up to: this brings the room to life. Empty holds everyone still. */
  cast: readonly CastMember[];
}

/** Head of a character away from their station (world px), or null when they're at it. */
export type ActorMoveListener = (slotId: string, head: Point | null) => void;

export interface ReferenceRenderer {
  setCamera(camera: Camera): void;
  resize(view: Size): void;
  setState(state: SceneState): void;
  /** Hand-overs, report-backs and finished work that send someone across the room. */
  push(events: readonly LifeEvent[]): void;
  /** Dev: send someone idle off somewhere right now; false if nobody can go. */
  liven(): boolean;
  /** Put everyone back where the mockup shows them. */
  resetActors(): void;
  destroy(): void;
}

const SECONDS_PER_MS = 1 / 1000;
/** Longest step the simulation takes, so a stalled frame never teleports anyone. */
const MAX_STEP_SECONDS = 0.1;
/** The painted helper bots, before the "+1" badge takes over. */
const DRAWN_HELPERS = 3;
/** Walkers' heads are reported to the UI (for clicking them) at most this often, ms. */
const HEAD_REPORT_MS = 90;

/** Light colours: the screens' own cyan, a reading lamp's warm white, and the attention amber. */
const LIGHT = {
  screen: { tint: 0x5fd9e8, alpha: 0.16 },
  lamp: { tint: 0xffdcae, alpha: 0.3 },
  waiting: { tint: 0xf3b03e, alpha: 0.5 },
} as const;
const GLOW_SIZE = 128;

/** A soft round light, white at the centre and gone at the edge, tinted per use. */
function glowTexture(): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_SIZE;
  canvas.height = GLOW_SIZE;
  const ctx = canvas.getContext("2d");
  const r = GLOW_SIZE / 2;
  if (ctx) {
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.5, "rgba(255,255,255,0.45)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, GLOW_SIZE, GLOW_SIZE);
  }
  return Texture.from(canvas);
}

/** A light over an ellipse given in mockup px as [cx, cy, rx, ry]. */
function lightSprite(glow: Texture, ellipse: readonly number[], look: { tint: number; alpha: number }, toWorld: (p: readonly number[]) => Point): Sprite {
  const [cx, cy, rx, ry] = ellipse;
  const sprite = new Sprite(glow);
  const at = toWorld([cx - rx, cy - ry]);
  sprite.position.set(at.x, at.y);
  sprite.width = rx * 2;
  sprite.height = ry * 2;
  sprite.tint = look.tint;
  sprite.alpha = look.alpha;
  sprite.blendMode = "add";
  sprite.visible = false;
  return sprite;
}

const bounds = (poly: readonly number[][]) => {
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  return [Math.floor(Math.min(...xs)), Math.floor(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys))] as const;
};

const overlaps = (a: readonly number[], b: readonly number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Furniture people pass behind: the plate's own pixels inside the outline, drawn over anyone whose feet are above its base. */
function occluderSprite(plate: Texture, occluder: OccluderJson, origin: Point): Sprite | null {
  const [x0, y0, x1, y1] = bounds(occluder.poly);
  const canvas = document.createElement("canvas");
  canvas.width = x1 - x0;
  canvas.height = y1 - y0;
  const ctx = canvas.getContext("2d");
  const image = plate.source.resource as CanvasImageSource | undefined;
  if (!ctx || !image) return null;
  ctx.beginPath();
  occluder.poly.forEach(([x, y], i) => (i ? ctx.lineTo(x - x0, y - y0) : ctx.moveTo(x - x0, y - y0)));
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(image, origin.x - x0, origin.y - y0);
  const sprite = new Sprite(Texture.from(canvas));
  sprite.position.set(x0 - origin.x, y0 - origin.y);
  sprite.zIndex = occluder.baseY - origin.y;
  sprite.visible = false;
  return sprite;
}

interface StationActor {
  slotId: string;
  /** The room's own pixels of the agent at their station. */
  sprite: Sprite;
  frames: StationFrames | null;
  /** The agent as a character, when up and about. */
  walker: Sprite;
  art: CharacterArt | null;
  atlas: Texture | null;
  walkerFrames: Map<string, Texture>;
  head: Point | null;
  reportedAt: number;
}

export async function createReferenceRenderer(host: HTMLElement, initialView: Size, room: Room, onActorMove: ActorMoveListener): Promise<ReferenceRenderer> {
  let view = initialView;
  const origin = { x: room.rect[0], y: room.rect[1] };
  const toWorld = (p: readonly number[]): Point => ({ x: p[0] - origin.x, y: p[1] - origin.y });
  const scene = room.scene;
  const app = new Application();
  await app.init({
    width: view.width,
    height: view.height,
    antialias: false,
    backgroundAlpha: 0,
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
    preference: "webgl",
    autoStart: false,
  });
  app.ticker.stop();

  const cutoutUrl = (id: string) => room.url(room.cutouts[id].file);
  const stations = Object.entries(scene.stations);
  const figureOf = new Map(scene.slots.map((s) => [s.id, s.figure]));
  const arts = new Map<string, CharacterArt>();
  for (const [slotId] of stations) {
    const figure = figureOf.get(slotId);
    const art = figure && room.life.cast[slotId] ? characterArt(room.folder, figure) : null;
    if (art) arts.set(slotId, art);
  }
  const urls = [
    room.url(room.plate),
    ...stations.map(([, station]) => cutoutUrl(station.cutout)),
    ...scene.helpers.flatMap((h) => h.parts.map(cutoutUrl)),
    ...new Set([...arts.values()].map((art) => art.url)),
  ];
  let loaded: Record<string, Texture>;
  try {
    loaded = (await Assets.load<Texture>(urls)) as Record<string, Texture>;
  } catch (error) {
    app.destroy(true);
    throw error;
  }
  const texture = (url: string) => loaded[url];

  // Layers, back to front: plate, screen light, helper shadows, depth-sorted people and
  // furniture, the light pooling at their feet (cut-outs carry their own floor), overlay badges.
  const world = new Container();
  const lights = new Container();
  const ground = new Container();
  const actors = new Container({ sortableChildren: true });
  const pools = new Container();
  const overlay = new Container();
  const plate = texture(urls[0]);
  world.addChild(new Sprite(plate), lights, ground, actors, pools, overlay);
  app.stage.addChild(world);
  // Attach only once everything loaded, so a failure never leaves an empty canvas.
  host.appendChild(app.canvas);
  // The scene renders on demand, so redraw ourselves when WebKit hands back a lost context.
  const onContextRestored = () => draw();
  app.canvas.addEventListener("webglcontextrestored", onContextRestored);

  const occluders = room.life.occluders.map((o) => ({ o, sprite: occluderSprite(plate, o, origin) }));
  for (const { sprite } of occluders) if (sprite) actors.addChild(sprite);

  // Each station's agent: the cut-out (animated in place) and their walking self.
  const people: StationActor[] = stations.map(([slotId, station]) => {
    const base = texture(cutoutUrl(station.cutout));
    const rect = room.cutouts[station.cutout].rect;
    const sprite = new Sprite(base);
    const at = toWorld(rect);
    sprite.position.set(at.x, at.y);
    // The cut-out already paints the furniture in front of its agent: keep it over any outline it overlaps.
    const covering = occluders.filter(({ o }) => overlaps(bounds(o.poly), rect)).map(({ o }) => o.baseY + 1);
    sprite.zIndex = Math.max(station.floorY, ...covering) - origin.y;
    const walker = new Sprite();
    walker.visible = false;
    actors.addChild(sprite, walker);
    const cast = room.life.cast[slotId];
    const art = arts.get(slotId) ?? null;
    return {
      slotId,
      sprite,
      frames: cast ? new StationFrames(base, cast.parts) : null,
      walker,
      art,
      atlas: art ? texture(art.url) : null,
      walkerFrames: new Map(),
      head: null,
      reportedAt: 0,
    };
  });

  // Each station's light: screens (or a lamp) while its agent works, amber underfoot while it waits.
  const glow = glowTexture();
  const stationLights = Object.entries(scene.lights)
    .filter((entry): entry is [string, LightJson] => typeof entry[1] !== "string")
    .map(([slotId, light]) => {
      const screen = lightSprite(glow, light.screen, light.warm ? LIGHT.lamp : LIGHT.screen, toWorld);
      const floor = lightSprite(glow, light.floor, LIGHT.waiting, toWorld);
      lights.addChild(screen);
      pools.addChild(floor);
      return { slotId, screen, floor };
    });

  // Helper bots in order: the painted three, then the "+1" badge for any more. Bodies hover over their shadows.
  const helperParts: Array<{ sprites: Sprite[]; overflow: boolean }> = [];
  const hovering: Array<{ sprite: Sprite; y: number }> = [];
  for (const helper of scene.helpers) {
    const sprites: Sprite[] = [];
    helperParts.push({ sprites, overflow: Boolean(helper.overlay) });
    for (const part of helper.parts) {
      const sprite = new Sprite(texture(cutoutUrl(part)));
      const at = toWorld(room.cutouts[part].rect);
      sprite.position.set(at.x, at.y);
      const isGround = part.endsWith("-ground");
      if (isGround) ground.addChild(sprite);
      else if (helper.overlay) overlay.addChild(sprite);
      else {
        sprite.zIndex = helper.floorY - origin.y;
        actors.addChild(sprite);
        hovering.push({ sprite, y: at.y });
      }
      sprites.push(sprite);
    }
  }

  const motions: Record<string, Motion> = {};
  for (const person of people) if (person.art) motions[person.slotId] = motionOf(person.art.json);
  let director = new Director(room.life, motions);

  let camera: Camera = { zoom: 1, cx: 0, cy: 0 };
  let state: SceneState = { helpers: DRAWN_HELPERS + 1, occupied: {}, lights: {}, cast: [] };
  // Stations the state doesn't mention keep their character, as the mockup shows them.
  const isOccupied = (slotId: string) => state.occupied[slotId] ?? true;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const live = () => state.cast.length > 0 && !still;
  let shown = true;
  let clock = 0;
  let scaleMode: "nearest" | "linear" = "nearest";
  const sources = new Set<TextureSource>(Object.values(loaded).map((t) => t.source));
  for (const { sprite } of occluders) if (sprite) sources.add(sprite.texture.source);

  const adopt = (t: Texture): Texture => {
    if (!sources.has(t.source)) sources.add(t.source);
    if (t.source.scaleMode !== scaleMode) t.source.scaleMode = scaleMode;
    return t;
  };

  const draw = () => {
    // Pixel art stays crisp when magnified; smooth only when shrinking it.
    const mode = camera.zoom >= 1 ? "nearest" : "linear";
    if (mode !== scaleMode) {
      scaleMode = mode;
      for (const source of sources) source.scaleMode = mode;
    }
    world.scale.set(camera.zoom);
    world.position.set(view.width / 2 - camera.cx * camera.zoom, view.height / 2 - camera.cy * camera.zoom);
    app.render();
  };

  const report = (person: StationActor, head: Point | null) => {
    const now = performance.now();
    if (head === null) {
      if (person.head !== null) {
        person.head = null;
        onActorMove(person.slotId, null);
      }
      return;
    }
    if (person.head !== null && now - person.reportedAt < HEAD_REPORT_MS) return;
    person.head = head;
    person.reportedAt = now;
    onActorMove(person.slotId, head);
  };

  const walkerFrame = (person: StationActor, name: string): Texture => {
    let frame = person.walkerFrames.get(name);
    if (!frame) {
      const [x, y, w, h] = person.art!.json.frames[name];
      frame = new Texture({ source: person.atlas!.source, frame: new Rectangle(x, y, w, h) });
      person.walkerFrames.set(name, frame);
    }
    return frame;
  };

  const showPeople = () => {
    const moving = live();
    for (const person of people) {
      if (!isOccupied(person.slotId)) {
        person.sprite.visible = false;
        person.walker.visible = false;
        report(person, null);
        continue;
      }
      const v = moving ? director.view(person.slotId) : null;
      if (v?.kind === "walker" && person.art) {
        const json = person.art.json;
        const { name, mirror } = frameFor(json, v.pose, v.dir, v.breath, v.frame);
        const [, , w, h, ax, ay] = json.frames[name];
        person.walker.texture = walkerFrame(person, name);
        person.walker.anchor.set(ax / w, ay / h);
        person.walker.scale.x = mirror ? -1 : 1;
        person.walker.position.set(Math.round(v.x - origin.x), Math.round(v.y - origin.y));
        person.walker.zIndex = v.y - origin.y;
        person.walker.visible = true;
        person.sprite.visible = false;
        report(person, { x: v.x - origin.x, y: v.y - origin.y - json.height });
      } else {
        const station = v?.kind === "station" ? v : null;
        if (person.frames) person.sprite.texture = adopt(person.frames.texture(station?.head ?? "rest", station?.hand ?? -1));
        person.sprite.visible = true;
        person.walker.visible = false;
        report(person, null);
      }
    }
  };

  const hover = () => {
    const lift = live();
    hovering.forEach(({ sprite, y }, i) => {
      sprite.y = lift ? y + Math.round(Math.sin(clock * 2.4 + i * 1.3) * 1.2) : y;
    });
  };

  const tick = () => {
    const dt = Math.min(MAX_STEP_SECONDS, app.ticker.deltaMS * SECONDS_PER_MS);
    clock += dt;
    if (live()) director.update(dt);
    showPeople();
    hover();
    draw();
    if (!live() || !shown) app.ticker.stop();
  };
  app.ticker.add(tick);
  const wake = () => {
    if (live() && shown && !document.hidden && !app.ticker.started) app.ticker.start();
  };

  // Rest while the room is off screen (another tab of the app, or the window hidden).
  const visibility = new IntersectionObserver(([entry]) => {
    shown = entry?.isIntersecting ?? true;
    if (shown) wake();
    else app.ticker.stop();
  });
  visibility.observe(host);
  const onVisibility = () => (document.hidden ? app.ticker.stop() : wake());
  document.addEventListener("visibilitychange", onVisibility);

  const applyState = () => {
    for (const { slotId, screen, floor } of stationLights) {
      const light = isOccupied(slotId) ? state.lights[slotId] : undefined;
      screen.visible = light === "working";
      floor.visible = light === "waiting";
    }
    let painted = 0;
    for (const { sprites, overflow } of helperParts) {
      const show = overflow ? state.helpers > DRAWN_HELPERS : painted++ < Math.min(state.helpers, DRAWN_HELPERS);
      for (const sprite of sprites) sprite.visible = show;
    }
    for (const { sprite } of occluders) if (sprite) sprite.visible = live();
    director.setCast(live() ? state.cast.filter((c) => isOccupied(c.slotId)) : []);
    showPeople();
    hover();
    draw();
    wake();
  };

  return {
    setCamera(next) {
      camera = next;
      draw();
    },
    resize(next) {
      view = next;
      app.renderer.resize(next.width, next.height);
      draw();
    },
    setState(next) {
      state = next;
      applyState();
    },
    push(events) {
      if (!live()) return;
      director.push(events);
      wake();
    },
    liven() {
      const sent = live() && director.liven();
      wake();
      return sent;
    },
    resetActors() {
      director = new Director(room.life, motions);
      applyState();
    },
    destroy() {
      visibility.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      app.canvas.removeEventListener("webglcontextrestored", onContextRestored);
      app.ticker.remove(tick);
      for (const person of people) {
        person.frames?.destroy();
        for (const frame of person.walkerFrames.values()) frame.destroy(false);
      }
      for (const { sprite } of occluders) sprite?.texture.destroy(true);
      app.destroy(true, { children: true });
      glow.destroy(true);
    },
  };
}
