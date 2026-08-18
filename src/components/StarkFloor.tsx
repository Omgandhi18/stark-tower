import { useEffect, useRef, useState } from "react";
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Text,
  TextStyle,
  Texture,
  TilingSprite,
} from "pixi.js";
import type { Agent, AgentStatus, AssistLink } from "../lib/types";
import { COLORS, TILE } from "../lib/theme";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  assistLinks: AssistLink[];
  onSelect: (id: string) => void;
}

// Chrome District sheet contract: rows = 8 directions (front, clockwise),
// cols = 6 walk frames, 56x84 px per cell.
const CELL_W = 56;
const CELL_H = 84;
const DIRS = 8;
const FRAMES = 6;
const SCALE = 0.8;
const SPEED = 46; // px/sec walk speed

const GRID_W = 17;
const GRID_H = 13;

// Floor positions are defined here (frontend) so the lab layout can be tuned
// without touching the Rust roster. Falls back to the agent's home_x/home_y.
const POSITIONS: Record<string, [number, number]> = {
  jarvis: [8, 6],
  vision: [12, 4],
  friday: [3, 9],
  edith: [6, 10],
  karen: [10, 9],
  veronica: [13, 7],
};

interface FloorSprite {
  id: string;
  container: Container;
  char: Sprite;
  ring: Graphics;
  bubbleGfx: Graphics;
  frames: Texture[][];
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  dir: number;
  animFrame: number;
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

/** Sheet row for a movement vector. Row 0 = facing camera (down). */
function angleToRow(vx: number, vy: number): number {
  const theta = Math.atan2(vx, vy);
  const d = Math.round((theta / (2 * Math.PI)) * DIRS);
  return ((d % DIRS) + DIRS) % DIRS;
}

function feetPos(agent: Agent): { x: number; y: number } {
  const [tx, ty] = POSITIONS[agent.id] ?? [agent.home_x, agent.home_y];
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
  const reactorRef = useRef<Sprite | null>(null);
  const reactorBaseRef = useRef<number>(1);
  const linkLayerRef = useRef<Graphics | null>(null);
  const spriteLayerRef = useRef<Container | null>(null);
  const spritesRef = useRef<Map<string, FloorSprite>>(new Map());
  const framesRef = useRef<Map<string, Texture[][]>>(new Map());
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

        // Load lab textures first so the floor/props render underneath.
        let floorTex: Texture | null = null;
        let propsTex: Texture | null = null;
        try {
          floorTex = await Assets.load<Texture>("/tiles/floor.png");
          floorTex.source.scaleMode = "nearest";
        } catch {
          /* fall back to drawn floor */
        }
        try {
          propsTex = await Assets.load<Texture>("/tiles/props.png");
          propsTex.source.scaleMode = "nearest";
        } catch {
          /* fall back to drawn reactor/cell */
        }
        if (disposed) {
          app.destroy(true);
          return;
        }

        const built = drawLab(world, floorTex, propsTex);
        reactorRef.current = built.reactor;
        reactorBaseRef.current = built.reactorBase;

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

        // Load + slice character sheets
        const ids = [
          "jarvis",
          "vision",
          "friday",
          "edith",
          "karen",
          "veronica",
        ];
        for (const id of ids) {
          try {
            const tex = await Assets.load<Texture>(`/sprites/${id}.png`);
            if (disposed) return;
            tex.source.scaleMode = "nearest";
            framesRef.current.set(id, buildFrames(tex));
          } catch {
            /* sprite missing -> agent will be skipped */
          }
        }
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

  // Sync sprites with roster + status + selection.
  useEffect(() => {
    const layer = spriteLayerRef.current;
    if (!ready || !layer) return;
    const map = spritesRef.current;

    for (const agent of agents) {
      const frames = framesRef.current.get(agent.id);
      if (!frames) continue;
      let s = map.get(agent.id);
      if (!s) {
        s = createSprite(agent, frames, () => onSelect(agent.id));
        layer.addChild(s.container);
        map.set(agent.id, s);
      }
      s.status = agent.status;
      s.selected = agent.id === selectedId;
    }
  }, [agents, selectedId, ready, onSelect]);

  return <div ref={hostRef} className="stark-floor" />;
}

function buildFrames(base: Texture): Texture[][] {
  const rows: Texture[][] = [];
  for (let d = 0; d < DIRS; d++) {
    const row: Texture[] = [];
    for (let f = 0; f < FRAMES; f++) {
      row.push(
        new Texture({
          source: base.source,
          frame: new Rectangle(f * CELL_W, d * CELL_H, CELL_W, CELL_H),
        }),
      );
    }
    rows.push(row);
  }
  return rows;
}

function createSprite(
  agent: Agent,
  frames: Texture[][],
  onClick: () => void,
): FloorSprite {
  const container = new Container();
  container.eventMode = "static";
  container.cursor = "pointer";
  container.on("pointertap", onClick);

  const ring = new Graphics();
  container.addChild(ring);

  const char = new Sprite(frames[0][0]);
  char.anchor.set(0.5, 1);
  char.scale.set(SCALE);
  container.addChild(char);

  const name = new Text({
    text: agent.name,
    style: new TextStyle({
      fontFamily: "monospace",
      fontSize: 10,
      fill: COLORS.text,
      letterSpacing: 1,
    }),
  });
  name.anchor.set(0.5, 0);
  name.y = 8;
  container.addChild(name);

  const bubbleGfx = new Graphics();
  bubbleGfx.y = -CELL_H * SCALE - 6;
  container.addChild(bubbleGfx);

  const pos = feetPos(agent);
  container.x = pos.x;
  container.y = pos.y;

  return {
    id: agent.id,
    container,
    char,
    ring,
    bubbleGfx,
    frames,
    x: pos.x,
    y: pos.y,
    homeX: pos.x,
    homeY: pos.y,
    dir: 0,
    animFrame: 0,
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
    s.animFrame = 0;
    s.dir = 0;
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
        s.dir = angleToRow(ux, uy);
        moving = true;
      } else {
        s.target = null;
        s.waitTimer = 0.6 + Math.random() * 2.4;
        if (s.status === "working" || requester) s.dir = 0; // face camera at desk
      }
    }

    if (moving) {
      s.animTimer += dt;
      if (s.animTimer > 0.11) {
        s.animTimer = 0;
        s.animFrame = (s.animFrame + 1) % FRAMES;
      }
    } else {
      s.animFrame = 0;
    }
  }

  s.char.texture = s.frames[s.dir][s.animFrame];
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

// Prop crop rectangles within tiles/props.png (1024x1024 composite).
const REACTOR_CROP = new Rectangle(8, 8, 496, 496);
const CONTAIN_CROP = new Rectangle(262, 520, 512, 494);

// Interior of tiles/floor.png (drop the outer gold frame) tiled across the grid.
const FLOOR_CROP = new Rectangle(72, 72, 880, 880);
const FLOOR_TILE_SCALE = 0.2;
const FLOOR_ALPHA = 0.5;

/** Build the lab from art: floor backdrop + arc-reactor + containment cell.
 *  Falls back to drawn shapes if the textures failed to load.
 *  Returns the reactor sprite (+ its base scale) so the ticker can pulse it. */
function drawLab(
  world: Container,
  floorTex: Texture | null,
  propsTex: Texture | null,
): { reactor: Sprite | null; reactorBase: number } {
  const W = GRID_W * TILE;
  const H = GRID_H * TILE;

  // --- Floor (tiled, not stretched) ---
  if (floorTex) {
    const tileTex = new Texture({ source: floorTex.source, frame: FLOOR_CROP });
    const floor = new TilingSprite({ texture: tileTex, width: W, height: H });
    floor.tileScale.set(FLOOR_TILE_SCALE);
    floor.alpha = FLOOR_ALPHA;
    world.addChild(floor);
  } else {
    const floor = new Graphics();
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const alt = (x + y) % 2 === 0;
        floor.rect(x * TILE, y * TILE, TILE, TILE).fill(alt ? COLORS.floor : COLORS.floorAlt);
      }
    }
    floor.rect(0, 0, W, H).stroke({ width: 3, color: COLORS.reactorGlow, alpha: 0.6 });
    world.addChild(floor);
  }

  let reactor: Sprite | null = null;
  let reactorBase = 1;

  if (propsTex) {
    // --- Arc reactor ---
    const reactorPx = 150;
    reactor = new Sprite(
      new Texture({ source: propsTex.source, frame: REACTOR_CROP }),
    );
    reactor.anchor.set(0.5);
    reactor.x = 8 * TILE + TILE / 2;
    reactor.y = 3 * TILE + TILE / 2;
    reactorBase = reactorPx / REACTOR_CROP.width;
    reactor.scale.set(reactorBase);
    world.addChild(reactor);

    // --- Containment cell (bottom-right) ---
    const cellPx = 118;
    const cell = new Sprite(
      new Texture({ source: propsTex.source, frame: CONTAIN_CROP }),
    );
    cell.anchor.set(0.5);
    cell.x = 14.5 * TILE;
    cell.y = 10.5 * TILE;
    cell.scale.set(cellPx / CONTAIN_CROP.width);
    world.addChild(cell);

    const label = new Text({
      text: "CONTAINMENT",
      style: new TextStyle({
        fontFamily: "monospace",
        fontSize: 9,
        fill: 0xff8080,
        letterSpacing: 1,
      }),
    });
    label.anchor.set(0.5, 1);
    label.x = cell.x;
    label.y = cell.y - cellPx / 2 - 4;
    world.addChild(label);
  }

  return { reactor, reactorBase };
}
