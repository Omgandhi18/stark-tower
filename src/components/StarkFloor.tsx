import { useEffect, useRef, useState } from "react";
import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
} from "pixi.js";
import type { Agent, AgentStatus, AssistLink, LightPhase } from "../lib/types";
import { COLORS, TILE } from "../lib/theme";
import { resolveRecipe, sceneFrameBufs, SCENE_H, SCENE_W } from "../lib/charArt";
import { type Buf, LAB_GH, LAB_GW, type LightSource, lightSources, renderFloor } from "../lib/labArt";
import { renderLightmap } from "../lib/labLight";
import { findPath, POIS, type Pt } from "../lib/labNav";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  assistLinks: AssistLink[];
  lighting: LightPhase;
  onSelect: (id: string) => void;
}

// Procedural characters are 18x32 buffers (from charArt); scaled up on the floor.
const SCALE = 1.3;
const SPEED = 40; // px/sec walk speed
const WALK_CYCLE = [0, 1, 0, 2]; // stand, step-L, stand, step-R

const GRID_W = LAB_GW;
const GRID_H = LAB_GH;

// Boot-in entrance (bottom-centre) — agents spawn here and walk to their desks.
const DOOR = { x: 15 * TILE, y: (GRID_H - 1) * TILE + TILE * 0.6 };

interface CharFrames {
  front: Texture[];
  back: Texture[];
}

interface FloorSprite {
  id: string;
  figure: string;
  container: Container;
  char: Sprite;
  ring: Graphics;
  nameText: Text;
  bubbleGfx: Graphics;
  frames: CharFrames;
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  facingBack: boolean;
  animPhase: number;
  animTimer: number;
  waitTimer: number;
  poiDwell: number;
  target: Pt | null; // current waypoint
  dest: Pt | null; // final goal the path leads to
  path: Pt[]; // remaining waypoints after target
  isBoss: boolean; // orchestrator — anchored at the reactor, faces the user
  status: AgentStatus;
  selected: boolean;
  accent: number;
}

/** Route a sprite to a world-space goal, following aisles/doors (A*). No-op if
 *  it's already heading there, so it's cheap to call every frame. */
function routeTo(s: FloorSprite, x: number, y: number) {
  if (s.dest && Math.abs(s.dest.x - x) < 2 && Math.abs(s.dest.y - y) < 2) return;
  s.dest = { x, y };
  s.path = findPath({ x: s.x, y: s.y }, { x, y });
  s.target = s.path.shift() ?? { x, y };
}

function stopHere(s: FloorSprite) {
  s.dest = null;
  s.path = [];
  s.target = null;
}

function hexToNum(hex: string): number {
  return parseInt(hex.replace("#", ""), 16);
}

/** Rasterize an RGBA buffer into a nearest-neighbor Pixi texture. */
function bufToTexture(buf: Uint8ClampedArray): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = SCENE_W;
  canvas.height = SCENE_H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(SCENE_W, SCENE_H);
  img.data.set(buf);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** A smoothly-scaled (linear) texture from a raw RGBA light-map layer. */
function lightTexture(data: Uint8ClampedArray, w: number, h: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(w, h);
  img.data.set(data);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "linear";
  return tex;
}

/** Rasterize a labArt RGBA buffer (arbitrary size) into a nearest texture. */
function labTexture(buf: Buf): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = buf.w;
  canvas.height = buf.h;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(buf.w, buf.h);
  img.data.set(buf.d);
  ctx.putImageData(img, 0, 0);
  const tex = Texture.from(canvas);
  tex.source.scaleMode = "nearest";
  return tex;
}

/** Build (front + back) walk textures for an agent's character recipe. */
function framesForFigure(figure: string): CharFrames {
  const bufs = sceneFrameBufs(resolveRecipe(figure));
  return {
    front: bufs.front.map(bufToTexture),
    back: bufs.back.map(bufToTexture),
  };
}

function feetPos(agent: Agent): { x: number; y: number } {
  // Position comes from the agent's configured home tile, so custom agents place
  // themselves and edits move them live. Clamp into the grid as a safety net.
  const tx = Math.min(GRID_W - 1, Math.max(0, agent.home_x || 1));
  const ty = Math.min(GRID_H - 1, Math.max(0, agent.home_y || 1));
  return {
    x: tx * TILE + TILE / 2,
    y: ty * TILE + TILE * 0.72,
  };
}

export default function StarkFloor({
  agents,
  selectedId,
  assistLinks,
  lighting,
  onSelect,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const darknessRef = useRef<Sprite | null>(null);
  const glowRef = useRef<Sprite | null>(null);
  const labelLayerRef = useRef<Container | null>(null);
  const ultronRef = useRef<Graphics | null>(null);
  const sourcesRef = useRef<LightSource[]>([]);
  const bootRef = useRef(true);
  const linkLayerRef = useRef<Graphics | null>(null);
  const spriteLayerRef = useRef<Container | null>(null);
  const spritesRef = useRef<Map<string, FloorSprite>>(new Map());
  const framesRef = useRef<Map<string, CharFrames>>(new Map());
  const linksRef = useRef<AssistLink[]>(assistLinks);
  const [ready, setReady] = useState(false);
  linksRef.current = assistLinks;

  // Init Pixi + load sprite sheets once.
  useEffect(() => {
    let disposed = false;
    let bgTimer: number | undefined;
    const host = hostRef.current!;
    const app = new Application();

    app
      .init({
        background: COLORS.bg,
        resizeTo: host,
        antialias: false,
        roundPixels: true,
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
      })
      .then(async () => {
        if (disposed) {
          app.destroy(true);
          return;
        }
        appRef.current = app;
        host.appendChild(app.canvas);

        const world = new Container();
        app.stage.addChild(world);
        worldRef.current = world;

        // Procedural sci-fi lab facility (tiles + walls + rooms + furniture),
        // baked into a single nearest-neighbor texture. Desks are part of the
        // floor; agents stand at their assigned desk tiles.
        const floorSprite = new Sprite(labTexture(renderFloor()));
        world.addChild(floorSprite);

        const linkLayer = new Graphics();
        world.addChild(linkLayer);
        linkLayerRef.current = linkLayer;

        const spriteLayer = new Container();
        // sort by y so lower sprites overlap correctly
        spriteLayer.sortableChildren = true;
        world.addChild(spriteLayer);
        spriteLayerRef.current = spriteLayer;

        // Day/night lighting: a darkness layer (normal blend) + a glow layer
        // (additive) above everything, driven by the light-map. Light pools from
        // the reactor, lamps and screens reveal the floor; the rest sits in dark.
        sourcesRef.current = lightSources();
        const darkness = new Sprite();
        darkness.eventMode = "none";
        world.addChild(darkness);
        darknessRef.current = darkness;
        const glow = new Sprite();
        glow.eventMode = "none";
        glow.blendMode = "add";
        world.addChild(glow);
        glowRef.current = glow;

        // Ultron's eyes + rage flash glow ABOVE the lighting (he burns through the
        // dark), but below the labels.
        const ultron = new Graphics();
        ultron.eventMode = "none";
        world.addChild(ultron);
        ultronRef.current = ultron;

        // Name labels ride ABOVE the lighting so they stay crisp day or night.
        const labelLayer = new Container();
        labelLayer.eventMode = "none";
        world.addChild(labelLayer);
        labelLayerRef.current = labelLayer;

        const layout = () => {
          const lw = GRID_W * TILE;
          const lh = GRID_H * TILE;
          const pad = 20;
          const scale = Math.max(
            0.1,
            Math.min((app.screen.width - pad) / lw, (app.screen.height - pad) / lh),
          );
          world.scale.set(scale);
          world.x = Math.round((app.screen.width - lw * scale) / 2);
          world.y = Math.round((app.screen.height - lh * scale) / 2);
        };
        layout();
        app.renderer.on("resize", layout);

        // Characters are drawn procedurally (charArt), generated on demand per
        // agent in the sync effect below — no sprite sheets to preload.
        if (disposed) return;
        setReady(true);

        // Per-frame simulation + draw. Driven by the Pixi ticker (rAF) normally,
        // but a webview throttles requestAnimationFrame when the window is
        // unfocused/occluded — so a timer fallback keeps the office alive and
        // renders manually whenever rAF stalls. dt is derived from wall-clock and
        // clamped, so resuming from a pause never teleports anyone.
        let lastTick = performance.now();
        let lastRaf = performance.now();
        const step = (render: boolean) => {
          const now = performance.now();
          const dt = Math.min(0.05, (now - lastTick) / 1000);
          lastTick = now;
          const t = now / 1000;

          // who is currently assisting whom
          const helperOf = new Map<string, string>();
          for (const l of linksRef.current) helperOf.set(l.to, l.from);

          spritesRef.current.forEach((s) =>
            updateSprite(s, dt, t, helperOf, spritesRef.current),
          );

          drawUltron(ultronRef.current, t);

          // assist beams
          const layer = linkLayerRef.current;
          if (layer) {
            layer.clear();
            for (const link of linksRef.current) {
              const a = spritesRef.current.get(link.from);
              const b = spritesRef.current.get(link.to);
              if (!a || !b) continue;
              const ay = a.y - 34;
              const by = b.y - 34;
              layer
                .moveTo(a.x, ay)
                .lineTo(b.x, by)
                .stroke({
                  width: 2,
                  color: COLORS.reactorCore,
                  alpha: 0.3 + Math.sin(t * 6) * 0.2,
                });
              const k = Math.sin(t * 2 + link.id) * 0.5 + 0.5;
              layer
                .circle(a.x + (b.x - a.x) * k, ay + (by - ay) * k, 3.5)
                .fill({ color: 0x9be8ff, alpha: 0.9 });
            }
          }

          if (render) app.render();
        };

        app.ticker.add(() => {
          lastRaf = performance.now();
          step(false); // Pixi auto-renders after ticker callbacks
        });
        // Fallback: if rAF hasn't fired for >40ms, step + render ourselves.
        bgTimer = window.setInterval(() => {
          if (disposed) return;
          if (performance.now() - lastRaf > 40) step(true);
        }, 1000 / 30);
      });

    return () => {
      disposed = true;
      if (bgTimer) clearInterval(bgTimer);
      const a = appRef.current;
      if (a) {
        a.destroy(true, { children: true });
        appRef.current = null;
      }
      spritesRef.current.clear();
      framesRef.current.clear();
    };
  }, []);

  // Sync sprites with roster + status + selection + appearance.
  useEffect(() => {
    const layer = spriteLayerRef.current;
    if (!ready || !layer) return;
    const map = spritesRef.current;
    const live = new Set(agents.map((a) => a.id));

    for (const agent of agents) {
      const figure = agent.figure || "";
      let frames = framesRef.current.get(figure);
      if (!frames) {
        frames = framesForFigure(figure);
        framesRef.current.set(figure, frames);
      }

      let s = map.get(agent.id);
      if (!s) {
        s = createSprite(agent, figure, frames, () => onSelect(agent.id));
        layer.addChild(s.container);
        labelLayerRef.current?.addChild(s.nameText);
        map.set(agent.id, s);
        // Boot-in: the first roster enters through the door and walks to desks.
        if (bootRef.current) {
          s.x = DOOR.x + (Math.random() * 2 - 1) * TILE * 1.6;
          s.y = DOOR.y;
          s.container.x = s.x;
          s.container.y = s.y;
          routeTo(s, s.homeX, s.homeY);
        }
      } else {
        // Live-apply appearance edits (character / accent / home / name).
        if (s.figure !== figure) {
          s.figure = figure;
          s.frames = frames;
        }
        s.accent = hexToNum(agent.accent);
        const pos = feetPos(agent);
        s.homeX = pos.x;
        s.homeY = pos.y;
        s.isBoss = agent.kind === "orchestrator";
        s.nameText.text = agent.name;
      }
      s.status = agent.status;
      s.selected = agent.id === selectedId;
    }
    if (map.size > 0) bootRef.current = false; // entrance only plays once

    // Drop sprites for agents that were removed.
    for (const [id, s] of map) {
      if (!live.has(id)) {
        s.container.destroy({ children: true });
        s.nameText.destroy();
        map.delete(id);
      }
    }
  }, [agents, selectedId, ready, onSelect]);

  // Rebuild the light-map when the phase changes.
  useEffect(() => {
    if (!ready) return;
    const darkness = darknessRef.current, glow = glowRef.current;
    if (!darkness || !glow) return;
    const W = GRID_W * TILE, H = GRID_H * TILE;
    const lm = renderLightmap(lighting, sourcesRef.current);
    const apply = (sprite: Sprite, data: Uint8ClampedArray) => {
      const old = sprite.texture;
      sprite.texture = lightTexture(data, lm.w, lm.h);
      sprite.setSize(W, H);
      if (old && old !== Texture.EMPTY) old.destroy(true);
    };
    apply(darkness, lm.darkness);
    apply(glow, lm.glow);
  }, [lighting, ready]);

  return <div ref={hostRef} className="stark-floor" />;
}

function createSprite(
  agent: Agent,
  figure: string,
  frames: CharFrames,
  onClick: () => void,
): FloorSprite {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  container.on("pointertap", onClick);

  const ring = new Graphics();
  container.addChild(ring);

  const char = new Sprite(frames.front[0]);
  char.anchor.set(0.5, 1);
  char.scale.set(SCALE);
  container.addChild(char);

  const nameText = new Text({
    text: agent.name,
    style: new TextStyle({
      fontFamily: "monospace",
      fontSize: 10,
      fill: COLORS.text,
      letterSpacing: 1,
    }),
  });
  nameText.anchor.set(0.5, 0);
  // Not a child of the container — it lives in the label layer (above lighting),
  // positioned in world coords each frame.

  const bubbleGfx = new Graphics();
  bubbleGfx.y = -SCENE_H * SCALE - 6;
  container.addChild(bubbleGfx);

  const pos = feetPos(agent);
  container.x = pos.x;
  container.y = pos.y;

  return {
    id: agent.id,
    figure,
    container,
    char,
    ring,
    nameText,
    bubbleGfx,
    frames,
    x: pos.x,
    y: pos.y,
    homeX: pos.x,
    homeY: pos.y,
    facingBack: false,
    animPhase: 0,
    animTimer: 0,
    waitTimer: Math.random() * 2,
    poiDwell: 0,
    target: null,
    dest: null,
    path: [],
    isBoss: agent.kind === "orchestrator",
    status: agent.status,
    selected: false,
    accent: hexToNum(agent.accent),
  };
}

function updateSprite(
  s: FloorSprite,
  dt: number,
  t: number,
  helperOf: Map<string, string>,
  all: Map<string, FloorSprite>,
) {
  let moving = false;
  const reqId = helperOf.get(s.id);
  const requester = reqId ? all.get(reqId) : undefined;
  const atHome = Math.hypot(s.x - s.homeX, s.y - s.homeY) < 8;

  s.char.alpha = 1;

  if (s.isBoss) {
    // The orchestrator runs the room from the reactor and always faces the team.
    if (!atHome) routeTo(s, s.homeX, s.homeY);
    else stopHere(s);
  } else if (requester) {
    // pair up beside whoever asked for help
    const side = s.x < requester.x ? -30 : 30;
    routeTo(s, requester.x + side, requester.y);
  } else if (s.status === "blocked") {
    // awaiting your decision — hold position (the alert reads as "needs you")
    stopHere(s);
  } else if (s.status === "working" || s.status === "thinking") {
    // heads-down: at the desk (walk there if displaced), then stay put
    if (!atHome) routeTo(s, s.homeX, s.homeY);
    else stopHere(s);
  } else {
    // idle or offline → free-roam the facility: coffee, servers, poke Ultron in
    // containment, the fabricator, then drift back to the desk. Full pathfinding.
    if (!s.dest && !s.target) {
      if (s.waitTimer > 0) {
        s.waitTimer -= dt;
      } else if (Math.random() < 0.32) {
        routeTo(s, s.homeX, s.homeY); // back to the desk for a bit
        s.poiDwell = 2 + Math.random() * 3;
      } else {
        const p = POIS[Math.floor(Math.random() * POIS.length)];
        routeTo(s, p.x, p.y);
        s.poiDwell = p.dwell[0] + Math.random() * (p.dwell[1] - p.dwell[0]);
      }
    }
  }

  // Follow the current path: advance waypoint-to-waypoint toward the goal.
  if (!s.target && s.path.length) s.target = s.path.shift() ?? null;
  if (s.target) {
    const dx = s.target.x - s.x;
    const dy = s.target.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d > 2) {
      const step = Math.min(SPEED * dt, d);
      const ux = dx / d;
      const uy = dy / d;
      s.x += ux * step;
      s.y += uy * step;
      // Only front + back views exist; face away only when heading up-screen.
      if (uy < -0.35) s.facingBack = true;
      else if (uy > 0.1 || Math.abs(ux) > 0.3) s.facingBack = false;
      moving = true;
    } else {
      s.x = s.target.x;
      s.y = s.target.y;
      s.target = s.path.length ? (s.path.shift() ?? null) : null;
      if (!s.target) {
        // reached the final destination — linger, then decide again
        s.dest = null;
        s.waitTimer = s.poiDwell > 0 ? s.poiDwell : 0.6 + Math.random() * 2.4;
        s.poiDwell = 0;
      }
    }
  }

  // Face the user when settled at a "presenting" spot (boss always; desk work).
  if (!s.target) {
    if (s.isBoss || s.status === "working" || s.status === "thinking" || requester)
      s.facingBack = false;
  }

  if (moving) {
    s.animTimer += dt;
    if (s.animTimer > 0.16) {
      s.animTimer = 0;
      s.animPhase = (s.animPhase + 1) % WALK_CYCLE.length;
    }
  } else {
    s.animPhase = 0;
  }

  const set = s.facingBack ? s.frames.back : s.frames.front;
  s.char.texture = set[WALK_CYCLE[s.animPhase]] ?? set[0];
  s.container.x = s.x;
  s.container.y = s.y;
  s.container.zIndex = s.y;
  s.nameText.position.set(s.x, s.y + 8);

  drawRing(s, t);
  drawBubble(s, t);
}

// Ultron rages in the containment unit (tile 22,15). His eyes simmer, flare on a
// slow anger surge, and rattle the cell — glowing over the night lighting.
const ULTRON = { ex1: 625, ex2: 633, ey: 406, cellX: 598, cellY: 383, cellS: 64, mouthX: 629, mouthY: 410 };
function drawUltron(g: Graphics | null, t: number) {
  if (!g) return;
  g.clear();
  const surge = Math.max(0, Math.sin(t * 0.8)) ** 8; // rare, sharp rage peaks
  const flick = 0.7 + Math.sin(t * 19) * 0.09 + Math.sin(t * 6.3) * 0.07; // restless flicker
  const eyeA = Math.min(1, flick + surge * 0.4);
  const rattle = surge > 0.25 ? Math.sin(t * 46) * 1.3 : 0; // shaking the bars

  if (surge > 0.04) {
    g.rect(ULTRON.cellX, ULTRON.cellY, ULTRON.cellS, ULTRON.cellS)
      .fill({ color: 0xff2a34, alpha: 0.04 + surge * 0.16 });
    g.rect(ULTRON.mouthX - 5, ULTRON.mouthY, 10, 2)
      .fill({ color: 0xff3a42, alpha: surge * 0.55 });
  }
  for (const ex of [ULTRON.ex1, ULTRON.ex2]) {
    g.circle(ex + rattle, ULTRON.ey, 3.4).fill({ color: 0xff3038, alpha: 0.26 * eyeA });
    g.circle(ex + rattle, ULTRON.ey, 1.4).fill({ color: 0xffd2d2, alpha: 0.92 * eyeA });
  }
}

function drawRing(s: FloorSprite, t: number) {
  const status = s.status;
  s.ring.clear();
  if (status === "offline" && !s.selected) return;
  const color =
    status === "blocked"
      ? COLORS.danger
      : status === "working"
        ? COLORS.gold
        : status === "thinking"
          ? COLORS.reactorCore
          : status === "idle"
            ? 0x7cf5c4
            : s.accent;
  const pulse = 0.5 + Math.sin(t * (status === "blocked" ? 10 : 3)) * 0.3;
  s.ring
    .ellipse(0, 0, 18, 6)
    .stroke({ width: s.selected ? 3 : 2, color, alpha: s.selected ? 0.95 : pulse });
  if (s.selected) {
    s.ring.ellipse(0, 0, 22, 8).stroke({ width: 1, color, alpha: 0.4 });
  }
}

function drawBubble(s: FloorSprite, t: number) {
  const status = s.status;
  const g = s.bubbleGfx;
  g.clear();
  if (status === "working") {
    const on = Math.floor(t * 3) % 2 === 0;
    g.roundRect(-12, -8, 24, 14, 3).fill({ color: 0x0a0f18, alpha: 0.9 });
    g.roundRect(-12, -8, 24, 14, 3).stroke({ width: 1, color: COLORS.gold, alpha: 0.7 });
    if (on) g.rect(-6, -4, 3, 6).fill(COLORS.gold);
    g.rect(0, -4, 3, 6).fill({ color: COLORS.gold, alpha: 0.5 });
    g.rect(6, -4, 3, 6).fill({ color: COLORS.gold, alpha: 0.3 });
  } else if (status === "thinking") {
    const a = 0.4 + Math.sin(t * 4) * 0.4;
    g.circle(-6, 0, 2).fill({ color: COLORS.reactorCore, alpha: a });
    g.circle(0, 0, 2).fill({ color: COLORS.reactorCore, alpha: a * 0.8 });
    g.circle(6, 0, 2).fill({ color: COLORS.reactorCore, alpha: a * 0.6 });
  } else if (status === "blocked") {
    const flash = Math.floor(t * 5) % 2 === 0;
    g.roundRect(-8, -10, 16, 18, 3).fill({ color: COLORS.danger, alpha: flash ? 0.9 : 0.4 });
    g.rect(-1.5, -7, 3, 8).fill(0xffffff);
    g.rect(-1.5, 3, 3, 3).fill(0xffffff);
  }
}
