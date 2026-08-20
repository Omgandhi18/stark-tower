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
import type { Agent, AgentStatus, AssistLink } from "../lib/types";
import { COLORS, TILE } from "../lib/theme";
import { resolveRecipe, sceneFrameBufs, SCENE_H, SCENE_W } from "../lib/charArt";
import { type Buf, LAB_GH, LAB_GW, renderFloor } from "../lib/labArt";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  assistLinks: AssistLink[];
  onSelect: (id: string) => void;
}

// Procedural characters are 18x32 buffers (from charArt); scaled up on the floor.
const SCALE = 1.3;
const SPEED = 40; // px/sec walk speed
const WALK_CYCLE = [0, 1, 0, 2]; // stand, step-L, stand, step-R

const GRID_W = LAB_GW;
const GRID_H = LAB_GH;

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
  target: { x: number; y: number } | null;
  status: AgentStatus;
  selected: boolean;
  accent: number;
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
  onSelect,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
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

        app.ticker.add((ticker) => {
          const dt = Math.min(0.05, ticker.deltaMS / 1000);
          const t = performance.now() / 1000;

          // who is currently assisting whom
          const helperOf = new Map<string, string>();
          for (const l of linksRef.current) helperOf.set(l.to, l.from);

          spritesRef.current.forEach((s) =>
            updateSprite(s, dt, t, helperOf, spritesRef.current),
          );

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
        });
      });

    return () => {
      disposed = true;
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
        map.set(agent.id, s);
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
        s.nameText.text = agent.name;
      }
      s.status = agent.status;
      s.selected = agent.id === selectedId;
    }

    // Drop sprites for agents that were removed.
    for (const [id, s] of map) {
      if (!live.has(id)) {
        s.container.destroy({ children: true });
        map.delete(id);
      }
    }
  }, [agents, selectedId, ready, onSelect]);

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
  nameText.y = 8;
  container.addChild(nameText);

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
    target: null,
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

  if (s.status === "offline") {
    s.char.alpha = 0.9;
    s.target = null;
    s.animPhase = 0;
  } else {
    s.char.alpha = 1;
    const reqId = helperOf.get(s.id);
    const requester = reqId ? all.get(reqId) : undefined;

    if (requester) {
      // walk next to the agent that asked for help
      const side = s.x < requester.x ? -30 : 30;
      s.target = { x: requester.x + side, y: requester.y };
    } else if (s.status === "blocked") {
      // awaiting your decision — hold position (the alert reads as "needs you")
      s.target = null;
    } else {
      // working, thinking, idle all keep pacing near home so nobody freezes
      if (!s.target) {
        if (s.waitTimer > 0) {
          s.waitTimer -= dt;
        } else {
          s.target = {
            x: s.homeX + (Math.random() * 2 - 1) * TILE * 1.6,
            y: s.homeY + (Math.random() * 2 - 1) * TILE * 1.1,
          };
        }
      }
    }

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
        s.target = null;
        s.waitTimer = 0.6 + Math.random() * 2.4;
        if (s.status === "working" || requester) s.facingBack = false; // face camera
      }
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
  }

  const set = s.facingBack ? s.frames.back : s.frames.front;
  s.char.texture = set[WALK_CYCLE[s.animPhase]] ?? set[0];
  s.container.x = s.x;
  s.container.y = s.y;
  s.container.zIndex = s.y;

  drawRing(s, t);
  drawBubble(s, t);
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
