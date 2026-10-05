// Pixi scene for the reference environment: the mockup plate (every station
// empty) plus the parts of it that can change — each station's character and
// light, the build-bay seat with FRIDAY when she gets up, and her helper bots —
// in a camera-driven world. The ticker only runs while something is animating.
import { Application, Assets, Container, Sprite, Texture } from "pixi.js";
import type { Camera, Point, Size } from "./camera";
import { CHARACTERS, allFrameUrls, frameUrl } from "./characterAssets";
import { ENVIRONMENT_RECT, assetUrl, reference } from "./referenceAssets";
import { VisitRoutine, type ActorFrame } from "./visitRoutine";
import scene from "./rnd-scene.json";

/** What a station's light says: its agent is working, or waiting on the developer. */
export type StationLight = "working" | "waiting";

export interface SceneState {
  /** Temporary helpers the build-bay agent has running: the room draws up to three, then "+1". */
  helpers: number;
  /** Stations whose character is in place, by slot id; the rest show their station empty. */
  occupied: Readonly<Record<string, boolean>>;
  /** Whether the build-bay character is typing right now. */
  buildBayTyping: boolean;
  /** Each station's light, by slot id; a station without one is unlit (as the mockup paints it). */
  lights: Readonly<Record<string, StationLight>>;
}

/** Head position of a character away from their seat (world px), or null when seated. */
export type ActorMoveListener = (slotId: string, head: Point | null) => void;

export interface ReferenceRenderer {
  setCamera(camera: Camera): void;
  resize(view: Size): void;
  setState(state: SceneState): void;
  /** Send the build-bay character to visit a colleague; false if nobody is seated there. */
  startVisit(): boolean;
  /** Put everyone back where the mockup shows them. */
  resetActors(): void;
  destroy(): void;
}

const ORIGIN = { x: ENVIRONMENT_RECT[0], y: ENVIRONMENT_RECT[1] };
const toWorld = (p: readonly number[]): Point => ({ x: p[0] - ORIGIN.x, y: p[1] - ORIGIN.y });
const BUILD_BAY = "buildBay";
const SECONDS_PER_MS = 1 / 1000;
/** The painted helper bots, before the "+1" badge takes over. */
const DRAWN_HELPERS = 3;

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
function lightSprite(glow: Texture, ellipse: readonly number[], look: { tint: number; alpha: number }): Sprite {
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

export async function createReferenceRenderer(host: HTMLElement, initialView: Size, onActorMove: ActorMoveListener): Promise<ReferenceRenderer> {
  let view = initialView;
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

  const actor = scene.actors.buildBay;
  const character = CHARACTERS[actor.character];
  const cutoutUrl = (id: string) => assetUrl(reference.cutouts[id].file);
  const stations = Object.entries(scene.stations);
  const urls = [
    assetUrl(reference.plates.environment.file),
    ...stations.map(([, station]) => cutoutUrl(station.cutout)),
    ...scene.helpers.flatMap((h) => h.parts.map(cutoutUrl)),
    ...allFrameUrls(character),
  ];
  let loaded: Record<string, Texture>;
  try {
    loaded = (await Assets.load<Texture>(urls)) as Record<string, Texture>;
  } catch (error) {
    app.destroy(true);
    throw error;
  }
  const textures = Object.values(loaded);
  const texture = (url: string) => loaded[url];

  // Layers, back to front: plate, screen light, helper shadows, depth-sorted actors,
  // the light pooling at their feet (cutouts carry their own floor), overlay badges.
  const world = new Container();
  const lights = new Container();
  const ground = new Container();
  const actors = new Container({ sortableChildren: true });
  const pools = new Container();
  const overlay = new Container();
  world.addChild(new Sprite(texture(urls[0])), lights, ground, actors, pools, overlay);
  app.stage.addChild(world);
  // Attach only once everything loaded, so a failure never leaves an empty canvas.
  host.appendChild(app.canvas);
  // The scene renders on demand, so redraw ourselves when WebKit hands back a lost context.
  const onContextRestored = () => draw();
  app.canvas.addEventListener("webglcontextrestored", onContextRestored);

  // Each station's character, depth-sorted with anyone walking past.
  const stationSprites = stations.map(([slotId, station]) => {
    const sprite = new Sprite(texture(cutoutUrl(station.cutout)));
    const at = toWorld(reference.cutouts[station.cutout].rect);
    sprite.position.set(at.x, at.y);
    sprite.zIndex = station.floorY - ORIGIN.y;
    actors.addChild(sprite);
    return { slotId, sprite };
  });

  // Each station's light: screens (or a lamp) while its agent works, amber underfoot while it waits.
  const glow = glowTexture();
  const stationLights = Object.entries(scene.lights)
    .filter(([slotId]) => slotId !== "$comment")
    .map(([slotId, spec]) => {
      const light = spec as { screen: number[]; floor: number[]; warm?: boolean };
      const screen = lightSprite(glow, light.screen, light.warm ? LIGHT.lamp : LIGHT.screen);
      const floor = lightSprite(glow, light.floor, LIGHT.waiting);
      lights.addChild(screen);
      pools.addChild(floor);
      return { slotId, screen, floor };
    });

  // Helper bots in order: the painted three, then the "+1" badge for any more.
  const helperParts: Array<{ sprites: Sprite[]; overflow: boolean }> = [];
  for (const helper of scene.helpers) {
    const sprites: Sprite[] = [];
    helperParts.push({ sprites, overflow: Boolean(helper.overlay) });
    for (const part of helper.parts) {
      const sprite = new Sprite(texture(cutoutUrl(part)));
      const at = toWorld(reference.cutouts[part].rect);
      sprite.position.set(at.x, at.y);
      const isGround = part.endsWith("-ground");
      if (isGround) ground.addChild(sprite);
      else if (helper.overlay) overlay.addChild(sprite);
      else {
        sprite.zIndex = helper.floorY - ORIGIN.y;
        actors.addChild(sprite);
      }
      sprites.push(sprite);
    }
  }

  const seated = character.animations.seated;
  const seatFrames = seated.frames.map((file) => texture(frameUrl(character.id, file)));
  const seat = new Sprite(seatFrames[0]);
  const seatAt = toWorld(reference.cutouts[actor.seatCutout].rect);
  seat.position.set(seatAt.x, seatAt.y);
  seat.zIndex = actor.seatFloorY - ORIGIN.y;
  const walker = new Sprite();
  walker.visible = false;
  actors.addChild(seat, walker);

  const routine = new VisitRoutine(
    {
      risePoint: toWorld(actor.risePoint),
      standPoint: toWorld(actor.standPoint),
      route: actor.visitRoute.map(toWorld),
      pause: actor.visitPause,
    },
    character,
  );

  let camera: Camera = { zoom: 1, cx: 0, cy: 0 };
  let state: SceneState = { helpers: DRAWN_HELPERS + 1, occupied: {}, buildBayTyping: false, lights: {} };
  // Stations the state doesn't mention keep their character, as the mockup shows them.
  const isOccupied = (slotId: string) => state.occupied[slotId] ?? true;
  let typingClock = 0;
  let lastSeatFrame = 0;

  const draw = () => {
    // Pixel art stays crisp when magnified; smooth only when shrinking it.
    const scaleMode = camera.zoom >= 1 ? "nearest" : "linear";
    for (const t of textures) t.source.scaleMode = scaleMode;
    world.scale.set(camera.zoom);
    world.position.set(view.width / 2 - camera.cx * camera.zoom, view.height / 2 - camera.cy * camera.zoom);
    app.render();
  };

  const showSeated = (frame: number) => {
    seat.texture = seatFrames[frame];
    seat.visible = isOccupied(BUILD_BAY);
    walker.visible = false;
  };

  const showWalking = (frame: ActorFrame) => {
    const spec = character.animations[frame.animation];
    walker.texture = texture(frameUrl(character.id, spec.frames[frame.frame]));
    walker.position.set(frame.x - spec.anchor[0], frame.y - spec.anchor[1]);
    walker.zIndex = frame.y;
    walker.visible = true;
    seat.visible = false;
    onActorMove(BUILD_BAY, { x: frame.x, y: frame.y - character.height });
  };

  const typing = () => isOccupied(BUILD_BAY) && state.buildBayTyping;
  const animating = () => routine.active || typing();

  const tick = () => {
    const dt = app.ticker.deltaMS * SECONDS_PER_MS;
    if (routine.active) {
      const frame = routine.update(dt);
      if (frame.seated) {
        showSeated(0);
        onActorMove(BUILD_BAY, null);
      } else showWalking(frame);
    } else if (typing()) {
      typingClock += dt;
      const frame = Math.floor(typingClock * seated.fps) % seatFrames.length;
      if (frame === lastSeatFrame) return; // typing is slow; skip renders until the frame changes
      lastSeatFrame = frame;
      showSeated(frame);
    }
    draw();
    if (!animating()) app.ticker.stop();
  };
  app.ticker.add(tick);
  const wake = () => {
    if (animating() && !app.ticker.started) app.ticker.start();
  };

  const applyState = () => {
    for (const { slotId, sprite } of stationSprites) sprite.visible = isOccupied(slotId);
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
    if (!routine.active) showSeated(0);
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
      if (!isOccupied(BUILD_BAY)) routine.stop();
      applyState();
    },
    startVisit() {
      if (!isOccupied(BUILD_BAY) || routine.active) return false;
      routine.start();
      wake();
      return true;
    },
    resetActors() {
      routine.stop();
      typingClock = 0;
      lastSeatFrame = 0;
      onActorMove(BUILD_BAY, null);
      applyState();
    },
    destroy() {
      app.canvas.removeEventListener("webglcontextrestored", onContextRestored);
      app.ticker.remove(tick);
      app.destroy(true, { children: true });
      glow.destroy(true);
    },
  };
}
