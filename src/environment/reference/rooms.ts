// Every theme's room in one shape: the plate (the room with every station
// empty), the cut-outs of the mockup's own pixels that put agents and helpers
// back, and the scene that says which station is whose, where its light falls
// and whose helpers the bots are. After Hours R&D comes from the reference
// extraction (extract.py); the other rooms from rooms.py. A room is only offered
// once its art exists.
import { themeInfo, type ThemeId } from "../../app/theme";
import type { LifeJson } from "../life/types";
import rndLife from "../life/rnd-life.json";
import officeLife from "../life/office-life.json";
import moriLife from "../life/mori-life.json";
import { reference, assetUrl as rndAssetUrl, type Rect } from "./referenceAssets";
import rndScene from "./rnd-scene.json";
import officeScene from "./office-scene.json";
import moriScene from "./mori-scene.json";

export interface LayerEntry {
  file: string;
  rect: Rect;
}

interface SlotJson {
  id: string;
  figure: string;
  /** Painted character bounds; by default the station's cut-out. */
  hit?: number[];
  /** Top of the head, where the status card hangs; by default the top centre of the hit area. */
  head?: number[];
  /** Painted in for the app: the mockup shows this seat empty. */
  added?: boolean;
}

export interface LightJson {
  /** Ellipses in mockup px: [cx, cy, rx, ry]. */
  screen: number[];
  floor: number[];
  /** A reading lamp rather than screens. */
  warm?: boolean;
}

export interface HelperJson {
  id: string;
  parts: string[];
  floorY: number;
  overlay?: boolean;
}

/**
 * Where the agent card sits: beside the head it labels (offset from the head, px),
 * or docked in a corner of the room (inset from that corner, px). `slot` is the
 * station whose card the mockup shows.
 */
export type CardJson = { slot: string; anchor: "head"; offset: number[] } | { slot: string; anchor: "top-right" | "bottom-left"; inset: number[] };

/** Interface a room's mockup draws around it, rebuilt as real UI. */
export interface FrameJson {
  /** A title bar above the room (Studio Office): the theme's name and description, and a two-line motto. */
  header?: { motto: string[] };
  /** The local time and where the room is, top right (Mori Cafe). */
  clock?: { place: string[] };
  /** A pill naming the room, bottom left (Mori Cafe). */
  caption?: { title: string; subtitle: string; note: string[] };
}

/** A painted board whose lines are live counts (Mori Cafe's "Starkline Today"). */
export interface BoardJson {
  /** Left end and vertical centre of the first line, mockup px. */
  at: number[];
  lineHeight: number;
  fontSize: number;
  /** How far the board's lines rise to the right, degrees. */
  slant: number;
  /** The counts the mockup paints: running, awaiting review, blocked. */
  reference: number[];
}

export interface SceneJson {
  card: CardJson;
  frame?: FrameJson;
  /** Name tags beside each station's character: top-left, mockup px. */
  tags?: Record<string, number[]>;
  board?: BoardJson;
  /** The orchestrator's station. */
  orchestratorSlot?: string;
  slots: SlotJson[];
  stations: Record<string, { cutout: string; floorY: number }>;
  lights: Record<string, LightJson | string>;
  helpers: HelperJson[];
  /** Whose helpers the bots stand for; without one, anyone's. */
  helperSlot?: string;
}

export interface Room {
  id: ThemeId;
  /** The plate's rect in its mockup: the world's origin and size. */
  rect: Rect;
  plate: string;
  cutouts: Record<string, LayerEntry>;
  scene: SceneJson;
  /** How the team lives in the room: where they walk, what they do (../life). */
  life: LifeJson;
  /** The theme's asset folder, where its characters are. */
  folder: string;
  url: (file: string) => string;
}

interface RoomManifest {
  plate: LayerEntry;
  cutouts: Record<string, LayerEntry>;
}

const manifests = import.meta.glob<RoomManifest>("../../assets/themes/*/room/manifest.json", { eager: true, import: "default" });
const roomFiles = import.meta.glob<string>("../../assets/themes/*/room/*.png", { eager: true, query: "?url", import: "default" });

function builtRoom(id: ThemeId, scene: SceneJson, life: LifeJson): Room | null {
  const folder = themeInfo(id).folder;
  const manifest = Object.entries(manifests).find(([path]) => path.includes(`/themes/${folder}/room/`))?.[1];
  if (!manifest) return null;
  return {
    id,
    rect: manifest.plate.rect,
    plate: manifest.plate.file,
    cutouts: manifest.cutouts,
    scene,
    life,
    folder,
    url: (file) => {
      const match = Object.entries(roomFiles).find(([path]) => path.endsWith(`/themes/${folder}/room/${file}`));
      if (!match) throw new Error(`Room asset missing from bundle: ${folder}/${file}`);
      return match[1];
    },
  };
}

const RND: Room = {
  id: "rnd",
  rect: reference.plates.environment.rect,
  plate: reference.plates.environment.file,
  cutouts: reference.cutouts,
  scene: rndScene as unknown as SceneJson,
  life: rndLife as unknown as LifeJson,
  folder: themeInfo("rnd").folder,
  url: rndAssetUrl,
};

const ROOMS: Partial<Record<ThemeId, Room>> = {
  rnd: RND,
  ...Object.fromEntries(
    [
      builtRoom("office", officeScene as unknown as SceneJson, officeLife as unknown as LifeJson),
      builtRoom("mori", moriScene as unknown as SceneJson, moriLife as unknown as LifeJson),
    ]
      .filter((room): room is Room => room !== null)
      .map((room) => [room.id, room]),
  ),
};

/** Whether a theme's own room is built. */
export const hasRoom = (theme: ThemeId) => ROOMS[theme] !== undefined;

/** A theme's room, or After Hours R&D while its own isn't built. */
export const roomFor = (theme: ThemeId): Room => ROOMS[theme] ?? RND;
