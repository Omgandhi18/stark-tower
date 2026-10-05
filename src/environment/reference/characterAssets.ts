// Animated characters for the reference scene (scripts/mockup-extract/build_characters.py).
import fridayJson from "../../assets/themes/after-hours-rnd/characters/friday/friday.json";

export interface AnimationSpec {
  frames: readonly string[];
  fps: number;
  /** Torso x / feet y inside each frame; seated cut-outs are placed by their own rect instead. */
  anchor: readonly [number, number];
  cutout?: boolean;
  /** Walks: world px travelled per loop. Moving at exactly this rate keeps planted feet still. */
  stride?: number;
  /** Walks: the frame where the feet pass each other (closest to standing); walks start and stop on it. */
  startFrame?: number;
}

export interface CharacterSpec {
  id: string;
  height: number;
  animations: Record<string, AnimationSpec>;
}

export const CHARACTERS: Record<string, CharacterSpec> = {
  friday: fridayJson as unknown as CharacterSpec,
};

const urls = import.meta.glob<string>("../../assets/themes/after-hours-rnd/characters/*/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

export function frameUrl(characterId: string, file: string): string {
  const match = Object.entries(urls).find(([path]) => path.endsWith(`/${characterId}/${file}`));
  if (!match) throw new Error(`Character frame missing from bundle: ${characterId}/${file}`);
  return match[1];
}

export function allFrameUrls(character: CharacterSpec): string[] {
  const files = new Set(Object.values(character.animations).flatMap((a) => a.frames));
  return [...files].map((file) => frameUrl(character.id, file));
}
