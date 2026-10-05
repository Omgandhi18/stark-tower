import { Application, Assets, Container, Graphics, Rectangle, Sprite, Text, TextStyle, Texture } from "pixi.js";
import { Armchair, Footprints, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import architectureAtlasUrl from "../assets/themes/jarvis-cabin/architecture-atlas-v2.png";
import furnitureAtlasUrl from "../assets/themes/jarvis-cabin/furniture-atlas-v2.png";
import jarvisSeatedUrl from "../assets/themes/jarvis-cabin/jarvis-seated-typing-8.png";
import jarvisStandUrl from "../assets/themes/jarvis-cabin/jarvis-stand-16.png";
import jarvisWalkUrl from "../assets/themes/jarvis-cabin/jarvis-walk-16-transparent.png";
import "./JarvisCabinPrototype.css";

interface Props {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

interface Point {
  x: number;
  y: number;
}

interface CabinRuntime {
  moveTo: (point: Point) => void;
  sendToDesk: () => void;
  reset: () => void;
}

interface AtlasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WORLD_WIDTH = 1280;
const WORLD_HEIGHT = 800;
const JARVIS_FRAME_SIZE = 1254 / 4;
const DESK_ANCHOR = { x: 658, y: 394 };
const ENTRY_POINT = { x: 870, y: 648 };
const WALK_SPEED = 128;
const ARRIVAL_DISTANCE = 5;
const DIRECTION_COUNT = 16;
const CAMERA_ZOOM = 1.75;

const ARCHITECTURE = {
  polishedTile: { x: 0, y: 0, width: 384, height: 278 },
  darkTile: { x: 384, y: 0, width: 384, height: 278 },
  cyanTile: { x: 0, y: 278, width: 340, height: 255 },
  amberTile: { x: 330, y: 275, width: 350, height: 260 },
  wall: { x: 320, y: 515, width: 270, height: 509 },
  glassWall: { x: 560, y: 500, width: 300, height: 524 },
  pillar: { x: 820, y: 500, width: 190, height: 524 },
  doorway: { x: 970, y: 500, width: 270, height: 524 },
  railing: { x: 1200, y: 610, width: 336, height: 390 },
} satisfies Record<string, AtlasFrame>;

const FURNITURE = {
  desk: { x: 0, y: 0, width: 900, height: 360 },
  deskForeground: { x: 0, y: 174, width: 900, height: 186 },
  chair: { x: 0, y: 330, width: 330, height: 390 },
  monitors: { x: 520, y: 320, width: 700, height: 365 },
  hologram: { x: 1180, y: 310, width: 356, height: 405 },
  server: { x: 0, y: 680, width: 290, height: 344 },
  plant: { x: 260, y: 635, width: 320, height: 389 },
  cabinet: { x: 530, y: 660, width: 440, height: 364 },
  lamp: { x: 950, y: 665, width: 310, height: 359 },
  mug: { x: 1190, y: 710, width: 250, height: 270 },
} satisfies Record<string, AtlasFrame>;

function textureFrame(atlas: Texture, frame: AtlasFrame): Texture {
  return new Texture({
    source: atlas.source,
    frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
  });
}

function addSprite(
  layer: Container,
  texture: Texture,
  position: Point,
  scale: number,
  anchor: Point = { x: 0.5, y: 1 },
): Sprite {
  const sprite = new Sprite(texture);
  sprite.anchor.set(anchor.x, anchor.y);
  sprite.position.set(position.x, position.y);
  sprite.scale.set(scale);
  layer.addChild(sprite);
  return sprite;
}

function createCityBackdrop(): Container {
  const backdrop = new Container();
  const sky = new Graphics();
  sky.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT).fill(0x02080d);
  sky.rect(0, 0, WORLD_WIDTH, 360).fill({ color: 0x061824, alpha: 0.86 });
  backdrop.addChild(sky);

  const skyline = new Graphics();
  for (let index = 0; index < 30; index += 1) {
    const width = 26 + (index % 4) * 10;
    const height = 90 + ((index * 43) % 210);
    const x = index * 48 - 35;
    const y = 365 - height;
    skyline.rect(x, y, width, height).fill(index % 2 === 0 ? 0x07141e : 0x0a1c27);
    for (let window = 0; window < Math.floor(height / 28); window += 1) {
      if ((window + index) % 3 === 0) {
        skyline.rect(x + 7, y + 12 + window * 26, 4, 3).fill({ color: 0xf4a53f, alpha: 0.72 });
      }
      skyline.rect(x + width - 11, y + 12 + window * 26, 4, 3).fill({ color: 0x24bfe5, alpha: 0.34 });
    }
  }
  backdrop.addChild(skyline);
  return backdrop;
}

function drawRain(layer: Graphics, time: number): void {
  layer.clear();
  for (let index = 0; index < 76; index += 1) {
    const x = (index * 197 + time * 24) % WORLD_WIDTH;
    const y = (index * 89 + time * (48 + (index % 6) * 7)) % WORLD_HEIGHT;
    layer.moveTo(x, y).lineTo(x - 6, y + 17).stroke({ color: 0x75d7ef, width: 1, alpha: 0.17 });
  }
}

function directionForVector(dx: number, dy: number): number {
  const angle = Math.atan2(dx, dy);
  const normalized = (angle + Math.PI * 2) % (Math.PI * 2);
  return Math.round((normalized / (Math.PI * 2)) * DIRECTION_COUNT) % DIRECTION_COUNT;
}

function characterTexture(atlas: Texture, frameIndex: number): Texture {
  const column = frameIndex % 4;
  const row = Math.floor(frameIndex / 4);
  return textureFrame(atlas, {
    x: column * JARVIS_FRAME_SIZE,
    y: row * JARVIS_FRAME_SIZE,
    width: JARVIS_FRAME_SIZE,
    height: JARVIS_FRAME_SIZE,
  });
}

export default function JarvisCabinPrototype({ selectedId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<CabinRuntime | null>(null);
  const selectedRef = useRef(selectedId);
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<"walking" | "working">("working");
  const [direction, setDirection] = useState(0);
  selectedRef.current = selectedId;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;

    void (async () => {
      const app = new Application();
      await app.init({
        background: 0x02080d,
        resizeTo: host,
        antialias: false,
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1),
        preference: "webgl",
      });
      if (disposed) {
        app.destroy(true);
        return;
      }

      app.canvas.className = "jarvis-cabin-canvas";
      host.appendChild(app.canvas);

      const [architectureAtlas, furnitureAtlas, standAtlas, walkAtlas, seatedAtlas] = await Promise.all([
        Assets.load<Texture>(architectureAtlasUrl),
        Assets.load<Texture>(furnitureAtlasUrl),
        Assets.load<Texture>(jarvisStandUrl),
        Assets.load<Texture>(jarvisWalkUrl),
        Assets.load<Texture>(jarvisSeatedUrl),
      ]);
      if (disposed) return;

      [architectureAtlas, furnitureAtlas, standAtlas, walkAtlas, seatedAtlas].forEach((atlas) => {
        atlas.source.scaleMode = "nearest";
      });

      const world = new Container({ isRenderGroup: true });
      world.sortableChildren = true;
      app.stage.addChild(world);

      const backgroundLayer = createCityBackdrop();
      backgroundLayer.zIndex = 0;
      const architectureLayer = new Container();
      architectureLayer.zIndex = 10;
      const rearLayer = new Container();
      rearLayer.zIndex = 20;
      const characterLayer = new Container();
      characterLayer.zIndex = 30;
      const foregroundLayer = new Container();
      foregroundLayer.zIndex = 40;
      const effectsLayer = new Container();
      effectsLayer.zIndex = 50;
      world.addChild(backgroundLayer, architectureLayer, rearLayer, characterLayer, foregroundLayer, effectsLayer);

      const deckShadow = new Graphics();
      deckShadow
        .poly([132, 462, 570, 205, 1164, 508, 726, 766])
        .fill({ color: 0x142b35, alpha: 0.98 })
        .stroke({ color: 0x2ad7f2, width: 2, alpha: 0.34 });
      deckShadow.position.set(0, 10);
      architectureLayer.addChild(deckShadow);

      const floorFrames = [
        ARCHITECTURE.darkTile,
        ARCHITECTURE.polishedTile,
        ARCHITECTURE.darkTile,
        ARCHITECTURE.cyanTile,
        ARCHITECTURE.polishedTile,
        ARCHITECTURE.amberTile,
      ];
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 5; column += 1) {
          const index = (row * 5 + column) % floorFrames.length;
          addSprite(
            architectureLayer,
            textureFrame(architectureAtlas, floorFrames[index]),
            { x: 596 + (column - row) * 116, y: 242 + (column + row) * 63 },
            0.76,
            { x: 0.5, y: 0.5 },
          );
        }
      }

      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.wall), { x: 355, y: 375 }, 0.68);
      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.glassWall), { x: 570, y: 310 }, 0.76);
      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.glassWall), { x: 796, y: 242 }, 0.76);
      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.pillar), { x: 503, y: 312 }, 0.72);
      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.pillar), { x: 930, y: 378 }, 0.72);
      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.doorway), { x: 1050, y: 475 }, 0.68);
      addSprite(architectureLayer, textureFrame(architectureAtlas, ARCHITECTURE.railing), { x: 1040, y: 616 }, 0.7);

      const desk = addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.desk), { x: 630, y: 420 }, 0.58);
      desk.eventMode = "static";
      desk.cursor = "pointer";
      const chair = addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.chair), { x: 658, y: 452 }, 0.52);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.monitors), { x: 658, y: 340 }, 0.48);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.hologram), { x: 900, y: 424 }, 0.48);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.server), { x: 1010, y: 592 }, 0.49);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.plant), { x: 358, y: 555 }, 0.43);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.cabinet), { x: 465, y: 600 }, 0.46);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.lamp), { x: 810, y: 491 }, 0.32);
      addSprite(rearLayer, textureFrame(furnitureAtlas, FURNITURE.mug), { x: 744, y: 410 }, 0.24);

      const jarvis = new Sprite(characterTexture(seatedAtlas, 8));
      jarvis.anchor.set(0.5, 0.82);
      jarvis.position.set(DESK_ANCHOR.x, DESK_ANCHOR.y);
      jarvis.scale.set(0.47);
      jarvis.eventMode = "static";
      jarvis.cursor = "pointer";
      characterLayer.addChild(jarvis);

      const deskForeground = addSprite(
        foregroundLayer,
        textureFrame(furnitureAtlas, FURNITURE.deskForeground),
        { x: 630, y: 420 },
        0.58,
      );
      deskForeground.eventMode = "none";

      const selectionRing = new Graphics();
      selectionRing.ellipse(0, 0, 38, 12).fill({ color: 0x32dcff, alpha: 0.08 }).stroke({ color: 0x32dcff, width: 2, alpha: 0.8 });
      selectionRing.position.set(jarvis.x, jarvis.y + 3);
      characterLayer.addChildAt(selectionRing, 0);

      const label = new Container();
      const labelFrame = new Graphics();
      labelFrame.roundRect(0, 0, 166, 50, 5).fill({ color: 0x06111a, alpha: 0.94 }).stroke({ color: 0x39dcff, width: 1, alpha: 0.72 });
      labelFrame.rect(0, 0, 3, 50).fill(0x39dcff);
      label.addChild(labelFrame);
      const name = new Text({ text: "JARVIS", style: new TextStyle({ fill: 0xf4f8fb, fontSize: 15, fontWeight: "700", letterSpacing: 1 }) });
      name.position.set(14, 8);
      const state = new Text({ text: "At command desk", style: new TextStyle({ fill: 0x72dff5, fontSize: 10, fontFamily: "monospace", letterSpacing: 0.5 }) });
      state.position.set(14, 29);
      label.addChild(name, state);
      label.position.set(jarvis.x + 58, jarvis.y - 148);
      effectsLayer.addChild(label);

      const rain = new Graphics();
      effectsLayer.addChild(rain);

      let target = { ...DESK_ANCHOR };
      let currentMode: "walking" | "working" = "working";
      let currentDirection = 0;
      let walkPhase = 0;

      const updateDirection = (nextDirection: number) => {
        currentDirection = nextDirection;
        setDirection(nextDirection);
      };

      const startWalk = (point: Point) => {
        target = {
          x: Math.max(340, Math.min(970, point.x)),
          y: Math.max(380, Math.min(650, point.y)),
        };
        currentMode = "walking";
        setMode("walking");
        state.text = `Walking · direction ${String(currentDirection + 1).padStart(2, "0")}/16`;
      };

      const sendToDesk = () => {
        target = { ...DESK_ANCHOR };
        if (Math.hypot(jarvis.x - target.x, jarvis.y - target.y) <= ARRIVAL_DISTANCE) {
          currentMode = "working";
          setMode("working");
          updateDirection(0);
          jarvis.texture = characterTexture(seatedAtlas, 8);
          jarvis.anchor.set(0.5, 0.82);
          state.text = "At command desk · typing";
          return;
        }
        currentMode = "walking";
        setMode("walking");
        state.text = "Returning to command desk";
      };

      desk.on("pointertap", sendToDesk);
      chair.on("pointertap", sendToDesk);
      jarvis.on("pointertap", () => onSelect("jarvis"));

      const onCanvasPointer = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const bounds = app.canvas.getBoundingClientRect();
        const scale = world.scale.x;
        const point = {
          x: (event.clientX - bounds.left - world.x) / scale,
          y: (event.clientY - bounds.top - world.y) / scale,
        };
        if (point.y < 330 || point.y > 705) return;
        startWalk(point);
      };
      app.canvas.addEventListener("pointerdown", onCanvasPointer);

      const resize = () => {
        const scale = Math.min(app.screen.width / WORLD_WIDTH, app.screen.height / WORLD_HEIGHT) * CAMERA_ZOOM;
        world.scale.set(scale);
        world.position.set((app.screen.width - WORLD_WIDTH * scale) / 2, (app.screen.height - WORLD_HEIGHT * scale) / 2);
      };
      resize();
      app.renderer.on("resize", resize);

      runtimeRef.current = {
        moveTo: startWalk,
        sendToDesk,
        reset: () => {
          jarvis.position.set(ENTRY_POINT.x, ENTRY_POINT.y);
          startWalk(DESK_ANCHOR);
        },
      };

      app.ticker.add((ticker) => {
        const time = performance.now() / 1000;
        drawRain(rain, time);

        if (currentMode === "walking") {
          const dx = target.x - jarvis.x;
          const dy = target.y - jarvis.y;
          const distance = Math.hypot(dx, dy);
          if (distance <= ARRIVAL_DISTANCE) {
            jarvis.position.set(target.x, target.y);
            if (Math.hypot(target.x - DESK_ANCHOR.x, target.y - DESK_ANCHOR.y) <= ARRIVAL_DISTANCE) {
              currentMode = "working";
              setMode("working");
              updateDirection(0);
              jarvis.texture = characterTexture(seatedAtlas, 8);
              jarvis.anchor.set(0.5, 0.82);
              state.text = "At command desk · typing";
            } else {
              currentMode = "working";
              setMode("working");
              jarvis.texture = characterTexture(standAtlas, currentDirection);
              jarvis.anchor.set(0.5, 0.88);
              state.text = `Standing · direction ${String(currentDirection + 1).padStart(2, "0")}/16`;
            }
          } else {
            const nextDirection = directionForVector(dx, dy);
            if (nextDirection !== currentDirection) updateDirection(nextDirection);
            const step = Math.min(distance, WALK_SPEED * ticker.deltaMS / 1000);
            jarvis.x += dx / distance * step;
            jarvis.y += dy / distance * step;
            walkPhase += ticker.deltaMS;
            const walkingContact = Math.floor(walkPhase / 145) % 2 === 0;
            jarvis.texture = characterTexture(walkingContact ? walkAtlas : standAtlas, nextDirection);
            jarvis.anchor.set(0.5, 0.88);
            jarvis.y += Math.sin(time * 14) * 0.18;
            state.text = `Walking · direction ${String(nextDirection + 1).padStart(2, "0")}/16`;
          }
        } else if (Math.hypot(jarvis.x - DESK_ANCHOR.x, jarvis.y - DESK_ANCHOR.y) <= ARRIVAL_DISTANCE) {
          const typingFrame = 8 + Math.floor(time * 1.8) % 2;
          jarvis.texture = characterTexture(seatedAtlas, typingFrame);
        }

        selectionRing.position.set(jarvis.x, jarvis.y + 3);
        selectionRing.visible = selectedRef.current === "jarvis";
        label.position.set(jarvis.x + 58, jarvis.y - 148);
      });

      setReady(true);
      cleanup = () => {
        app.canvas.removeEventListener("pointerdown", onCanvasPointer);
        app.renderer.off("resize", resize);
        runtimeRef.current = null;
        app.destroy(true, { children: true });
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
      setReady(false);
    };
  }, [onSelect]);

  return (
    <section className="jarvis-cabin" aria-label="JARVIS cabin asset prototype">
      <div ref={hostRef} className="jarvis-cabin-stage" />
      <div className="jarvis-cabin-vignette" aria-hidden="true" />

      <div className="jarvis-cabin-heading">
        <span>Asset prototype · Cabin 01</span>
        <strong>JARVIS Command Cabin</strong>
        <small>16-direction character runtime · layered furniture sockets</small>
      </div>

      <div className="jarvis-cabin-instruction">
        Click the floor to walk. Click the desk to sit and work.
      </div>

      <div className="jarvis-cabin-controls">
        <button type="button" onClick={() => runtimeRef.current?.moveTo(ENTRY_POINT)}>
          <Footprints size={15} />
          Walk
        </button>
        <button type="button" onClick={() => runtimeRef.current?.sendToDesk()}>
          <Armchair size={15} />
          Workstation
        </button>
        <span>{mode === "walking" ? `Direction ${String(direction + 1).padStart(2, "0")}/16` : "Typing · 8-way seated"}</span>
        <button type="button" aria-label="Replay entrance" onClick={() => runtimeRef.current?.reset()}>
          <RotateCcw size={15} />
        </button>
      </div>

      {!ready && <div className="jarvis-cabin-loading">Preparing cabin assets</div>}
    </section>
  );
}
