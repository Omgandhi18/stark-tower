// Each theme's characters as the room draws them away from their station: one
// atlas per figure (scripts/mockup-extract/characters.py) with poses facing
// toward and away from the viewer and a walk cycle each way. Left-facing
// directions mirror the right-facing art.
import type { Motion } from "./director";
import type { Dir } from "./types";

export interface CharacterJson {
  id: string;
  /** Standing height, px. */
  height: number;
  /** Which way each sheet's art faces. */
  faces: Record<string, "left" | "right">;
  walks: Record<string, { frames: number; stride: number }>;
  /** Frame name → [x, y, w, h, anchorX, anchorY] in the atlas; the anchor is the torso over the feet. */
  frames: Record<string, number[]>;
}

export interface CharacterArt {
  json: CharacterJson;
  url: string;
}

const JSONS = import.meta.glob<CharacterJson>("../../assets/themes/*/characters/*.json", { eager: true, import: "default" });
const ATLASES = import.meta.glob<string>("../../assets/themes/*/characters/*.png", { eager: true, query: "?url", import: "default" });

/** A figure's character art in a theme (by its asset folder), or null when the theme has none for it. */
export function characterArt(folder: string, figure: string): CharacterArt | null {
  const suffix = `/themes/${folder}/characters/${figure}`;
  const json = Object.entries(JSONS).find(([path]) => path.endsWith(`${suffix}.json`))?.[1];
  const url = Object.entries(ATLASES).find(([path]) => path.endsWith(`${suffix}.png`))?.[1];
  return json && url ? { json, url } : null;
}

// Poses by name, facing the viewer (front sheets) and facing away (back sheet). A pose a
// sheet doesn't draw borrows the nearest one it does.
const FRONT: Record<string, string> = {
  stand: "front.stand",
  talk: "front.talk",
  listen: "front.listen",
  think: "front.think",
  coffee: "front.coffee",
  read: "front.read",
  wave: "front2.wave",
  present: "front2.present",
  reach: "front2.present",
  stretch: "front2.stretch",
  rise: "front2.rise",
  folder: "front2.folder",
};
const BACK: Record<string, string> = {
  stand: "back.stand",
  talk: "back.talk",
  listen: "back.listen",
  think: "back.think",
  coffee: "back.coffee",
  reach: "back.reach",
  present: "back.reach",
  read: "back.think",
  wave: "back.talk",
  stretch: "back.stand",
  folder: "back.stand",
  rise: "front2.rise",
};

/** The atlas frame for a pose facing `dir`, and whether to mirror it. */
export function frameFor(json: CharacterJson, pose: string, dir: Dir, breath: boolean, walkFrame: number): { name: string; mirror: boolean } {
  const toward = dir[0] === "S";
  let name = pose === "walk" ? `${toward ? "walkFront" : "walkBack"}.${walkFrame}` : ((toward ? FRONT : BACK)[pose] ?? "");
  if (!json.frames[name]) name = toward ? "front.stand" : "back.stand";
  if (breath && json.frames[`${name}~`]) name = `${name}~`;
  const sheet = name.slice(0, name.indexOf("."));
  const artFacesRight = (json.faces[sheet] ?? "right") === "right";
  return { name, mirror: artFacesRight !== (dir[1] === "E") };
}

/** How a character walks: the stride is measured from the art, kept to a natural range. */
export function motionOf(json: CharacterJson): Motion {
  const walk = json.walks.walkFront ?? json.walks.walkBack;
  const measured = walk?.stride ?? json.height * 0.6;
  return {
    height: json.height,
    stride: Math.min(json.height * 0.75, Math.max(json.height * 0.5, measured)),
    walkFrames: walk?.frames ?? 8,
  };
}
