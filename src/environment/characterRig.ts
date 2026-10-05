import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { AgentStatus } from "../lib/types";
import jarvisAtlasUrl from "../assets/themes/after-hours-rnd/runtime/jarvis-directional.png";
import fridayAtlasUrl from "../assets/themes/after-hours-rnd/runtime/friday-directional.png";
import fridaySeatedAtlasUrl from "../assets/themes/after-hours-rnd/runtime/friday-seated-directional.png";
import visionAtlasUrl from "../assets/themes/after-hours-rnd/runtime/vision-directional.png";
import edithAtlasUrl from "../assets/themes/after-hours-rnd/runtime/edith-directional.png";
import karenAtlasUrl from "../assets/themes/after-hours-rnd/runtime/karen-directional.png";
import veronicaAtlasUrl from "../assets/themes/after-hours-rnd/runtime/veronica-directional.png";

export type CharacterPose = "standing" | "seated" | "working" | "thinking" | "walking";
export type CharacterDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

export interface PixelCharacter {
  container: Container;
  setPose: (pose: CharacterPose) => void;
  setDirection: (direction: CharacterDirection) => void;
  setStatus: (status: AgentStatus) => void;
  tick: (time: number) => void;
}

interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DIRECTIONAL_COLUMNS = 8;
const POSE_ROWS = 4;
const SEATED_POSE_ROWS = 2;
const CHARACTER_HEIGHT = 122;

type NamedAgentId = "jarvis" | "friday" | "vision" | "edith" | "karen" | "veronica";

const directionColumn: Record<NamedAgentId, Record<CharacterDirection, number>> = {
  jarvis: { s: 0, se: 1, e: 2, ne: 3, n: 4, nw: 5, w: 6, sw: 7 },
  friday: { n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 },
  vision: { s: 0, se: 1, e: 2, ne: 3, n: 4, nw: 5, w: 6, sw: 7 },
  edith: { n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 },
  karen: { n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 },
  veronica: { n: 0, ne: 1, e: 2, se: 3, s: 4, sw: 5, w: 6, nw: 7 },
};

const poseRow: Record<CharacterPose, number> = {
  standing: 0,
  thinking: 0,
  walking: 1,
  seated: 2,
  working: 3,
};

let jarvisAtlas: Texture | null = null;
let fridayAtlas: Texture | null = null;
let fridaySeatedAtlas: Texture | null = null;
let visionAtlas: Texture | null = null;
let edithAtlas: Texture | null = null;
let karenAtlas: Texture | null = null;
let veronicaAtlas: Texture | null = null;

export async function preloadCharacterAtlases() {
  [
    jarvisAtlas,
    fridayAtlas,
    fridaySeatedAtlas,
    visionAtlas,
    edithAtlas,
    karenAtlas,
    veronicaAtlas,
  ] = await Promise.all([
    Assets.load<Texture>(jarvisAtlasUrl),
    Assets.load<Texture>(fridayAtlasUrl),
    Assets.load<Texture>(fridaySeatedAtlasUrl),
    Assets.load<Texture>(visionAtlasUrl),
    Assets.load<Texture>(edithAtlasUrl),
    Assets.load<Texture>(karenAtlasUrl),
    Assets.load<Texture>(veronicaAtlasUrl),
  ]);
  [
    jarvisAtlas,
    fridayAtlas,
    fridaySeatedAtlas,
    visionAtlas,
    edithAtlas,
    karenAtlas,
    veronicaAtlas,
  ].forEach((atlas) => {
    atlas.source.scaleMode = "linear";
  });
}

function frameTexture(atlas: Texture, frame: FrameRect) {
  return new Texture({
    source: atlas.source,
    frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
  });
}

function directionalTexture(
  id: NamedAgentId,
  atlas: Texture,
  pose: CharacterPose,
  direction: CharacterDirection,
) {
  const frameWidth = atlas.width / DIRECTIONAL_COLUMNS;
  const frameHeight = atlas.height / POSE_ROWS;
  const column = directionColumn[id][direction];
  const row = poseRow[pose];
  return frameTexture(atlas, {
    x: column * frameWidth,
    y: row * frameHeight,
    width: frameWidth,
    height: frameHeight,
  });
}

function fridaySeatedTexture(
  atlas: Texture,
  pose: "seated" | "working",
  direction: CharacterDirection,
) {
  const frameWidth = atlas.width / DIRECTIONAL_COLUMNS;
  const frameHeight = atlas.height / SEATED_POSE_ROWS;
  const column = directionColumn.friday[direction];
  const row = pose === "working" ? 1 : 0;
  return frameTexture(atlas, {
    x: column * frameWidth,
    y: row * frameHeight,
    width: frameWidth,
    height: frameHeight,
  });
}

function isNamedAgent(id: string): id is NamedAgentId {
  return id in directionColumn;
}

function createRobot(): PixelCharacter {
  const container = new Container();
  const body = new Graphics();
  body.roundRect(-20, -43, 40, 29, 3).fill(0xa4abb0).stroke({ color: 0x071018, width: 3 });
  body.rect(-15, -38, 30, 20).fill(0x59636b);
  body.roundRect(-11, -57, 22, 17, 3).fill(0x222c34).stroke({ color: 0x071018, width: 3 });
  body.circle(0, -49, 7).fill(0x07141a);
  body.circle(0, -49, 4).fill(0x35dcff);
  body.rect(-18, -15, 13, 15).fill(0x3a444c);
  body.rect(5, -15, 13, 15).fill(0x3a444c);
  body.rect(-27, -39, 9, 24).fill(0x4b555d);
  body.rect(18, -39, 9, 24).fill(0x4b555d);
  container.addChild(body);
  let status: AgentStatus = "offline";

  return {
    container,
    setPose: () => {},
    setDirection: () => {},
    setStatus: (next) => {
      status = next;
      container.alpha = 1;
      body.alpha = 1;
    },
    tick: (time) => {
      const active = status === "working" || status === "thinking";
      container.alpha = 1;
      body.alpha = 1;
      body.y = active ? Math.sin(time * 4.4) : 0;
    },
  };
}

export function createPixelCharacter(
  id: string,
  initialPose: CharacterPose,
  initialDirection: CharacterDirection,
): PixelCharacter {
  if (id === "dum-e") return createRobot();
  if (
    !jarvisAtlas
    || !fridayAtlas
    || !fridaySeatedAtlas
    || !visionAtlas
    || !edithAtlas
    || !karenAtlas
    || !veronicaAtlas
  ) {
    throw new Error("Character atlases must be preloaded before creating rigs");
  }
  const directionalAtlases: Record<NamedAgentId, Texture> = {
    jarvis: jarvisAtlas,
    friday: fridayAtlas,
    vision: visionAtlas,
    edith: edithAtlas,
    karen: karenAtlas,
    veronica: veronicaAtlas,
  };
  const loadedFridaySeatedAtlas = fridaySeatedAtlas;

  const container = new Container();
  const sprite = new Sprite();
  sprite.anchor.set(0.5, 1);
  container.addChild(sprite);
  let pose = initialPose;
  let direction = initialDirection;
  let status: AgentStatus = "offline";

  const redraw = () => {
    if (id === "friday" && (pose === "seated" || pose === "working")) {
      sprite.texture = fridaySeatedTexture(loadedFridaySeatedAtlas, pose, direction);
    } else if (isNamedAgent(id)) {
      sprite.texture = directionalTexture(id, directionalAtlases[id], pose, direction);
    } else {
      sprite.texture = directionalTexture("vision", directionalAtlases.vision, pose, direction);
    }
    sprite.height = pose === "seated" || pose === "working" ? CHARACTER_HEIGHT * 0.9 : CHARACTER_HEIGHT;
    sprite.scale.x = sprite.scale.y;
  };
  redraw();

  return {
    container,
    setPose: (next) => {
      if (next === pose) return;
      pose = next;
      redraw();
    },
    setDirection: (next) => {
      if (next === direction) return;
      direction = next;
      redraw();
    },
    setStatus: (next) => {
      status = next;
      container.alpha = 1;
      sprite.alpha = 1;
    },
    tick: (time) => {
      const active = status === "working" || status === "thinking";
      container.alpha = 1;
      sprite.alpha = 1;
      sprite.y = active ? Math.sin(time * 2.1 + id.length) * 0.9 : 0;
    },
  };
}
