import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from "pixi.js";
import type { CharacterDirection, CharacterPose } from "./characterRig";
import cityUrl from "../assets/themes/after-hours-rnd/runtime/city-rain.png";
import architectureUrl from "../assets/themes/after-hours-rnd/runtime/architecture.png";
import modulesUrl from "../assets/themes/after-hours-rnd/runtime/environment-modules.png";

export const WORLD_WIDTH = 1584;
export const WORLD_HEIGHT = 993;

export interface StationAnchor {
  x: number;
  y: number;
  pose: CharacterPose;
  direction: CharacterDirection;
  labelOffset?: { x: number; y: number };
}

export const AFTER_HOURS_STATIONS: Record<string, StationAnchor> = {
  jarvis: {
    x: 675,
    y: 250,
    pose: "working",
    direction: "s",
    labelOffset: { x: 88, y: -92 },
  },
  friday: {
    x: 390,
    y: 735,
    pose: "working",
    direction: "n",
    labelOffset: { x: -170, y: -88 },
  },
  vision: {
    x: 1010,
    y: 515,
    pose: "standing",
    direction: "e",
    labelOffset: { x: -172, y: -104 },
  },
  edith: {
    x: 760,
    y: 845,
    pose: "standing",
    direction: "n",
    labelOffset: { x: 42, y: -124 },
  },
  karen: {
    x: 1100,
    y: 775,
    pose: "standing",
    direction: "e",
    labelOffset: { x: -174, y: -108 },
  },
  veronica: {
    x: 260,
    y: 370,
    pose: "seated",
    direction: "se",
    labelOffset: { x: 34, y: -105 },
  },
  "dum-e": {
    x: 650,
    y: 820,
    pose: "standing",
    direction: "s",
    labelOffset: { x: 38, y: -92 },
  },
};

export interface AfterHoursScene {
  container: Container;
  peopleLayer: Container;
  effectsLayer: Container;
  tick: (time: number) => void;
}

interface AtlasFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ModulePlacement {
  frame: AtlasFrame;
  x: number;
  y: number;
  scale: number;
  kind: "station" | "prop" | "foreground";
}

const MODULES: ModulePlacement[] = [
  { frame: { x: 27, y: 23, width: 741, height: 504 }, x: 485, y: 65, scale: 0.58, kind: "station" },
  { frame: { x: 787, y: 61, width: 328, height: 402 }, x: 159, y: 118, scale: 0.72, kind: "station" },
  { frame: { x: 1099, y: 116, width: 415, height: 377 }, x: 1032, y: 302, scale: 0.72, kind: "station" },
  { frame: { x: 34, y: 532, width: 491, height: 282 }, x: 255, y: 568, scale: 0.68, kind: "station" },
  { frame: { x: 576, y: 490, width: 352, height: 321 }, x: 1132, y: 656, scale: 0.66, kind: "prop" },
  { frame: { x: 1286, y: 535, width: 213, height: 278 }, x: 1320, y: 565, scale: 0.69, kind: "station" },
  { frame: { x: 35, y: 825, width: 244, height: 178 }, x: 550, y: 486, scale: 0.58, kind: "prop" },
  { frame: { x: 300, y: 797, width: 126, height: 196 }, x: 915, y: 355, scale: 0.55, kind: "prop" },
  { frame: { x: 443, y: 826, width: 126, height: 169 }, x: 895, y: 713, scale: 0.52, kind: "prop" },
  { frame: { x: 680, y: 850, width: 108, height: 148 }, x: 690, y: 726, scale: 0.55, kind: "prop" },
  { frame: { x: 816, y: 859, width: 139, height: 138 }, x: 986, y: 820, scale: 0.58, kind: "prop" },
  { frame: { x: 1181, y: 857, width: 114, height: 140 }, x: 408, y: 415, scale: 0.54, kind: "prop" },
  { frame: { x: 1325, y: 879, width: 174, height: 113 }, x: 382, y: 835, scale: 0.62, kind: "foreground" },
];

function atlasTexture(atlas: Texture, frame: AtlasFrame) {
  return new Texture({
    source: atlas.source,
    frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
  });
}

function addModule(layer: Container, atlas: Texture, placement: ModulePlacement) {
  const sprite = new Sprite(atlasTexture(atlas, placement.frame));
  sprite.position.set(placement.x, placement.y);
  sprite.scale.set(placement.scale);
  sprite.eventMode = placement.kind === "station" ? "static" : "none";
  if (placement.kind === "station") {
    sprite.cursor = "pointer";
    sprite.on("pointerover", () => { sprite.alpha = 0.93; });
    sprite.on("pointerout", () => { sprite.alpha = 1; });
  }
  layer.addChild(sprite);
  return sprite;
}

function createRain(layer: Container) {
  const drops = Array.from({ length: 76 }, (_, index) => ({
    x: (index * 193) % WORLD_WIDTH,
    y: (index * 83) % WORLD_HEIGHT,
    length: 6 + (index % 5) * 3,
    speed: 34 + (index % 7) * 9,
  }));
  const rain = new Graphics();
  layer.addChild(rain);
  return (time: number) => {
    rain.clear();
    for (const drop of drops) {
      const y = (drop.y + time * drop.speed) % WORLD_HEIGHT;
      rain.moveTo(drop.x, y).lineTo(drop.x - 4, y + drop.length)
        .stroke({ color: 0x8fdfff, width: 1, alpha: 0.16 });
    }
  };
}

export async function createAfterHoursScene(): Promise<AfterHoursScene> {
  const [cityTexture, architectureTexture, modulesTexture] = await Promise.all([
    Assets.load<Texture>(cityUrl),
    Assets.load<Texture>(architectureUrl),
    Assets.load<Texture>(modulesUrl),
  ]);
  cityTexture.source.scaleMode = "linear";
  architectureTexture.source.scaleMode = "linear";
  modulesTexture.source.scaleMode = "linear";

  const container = new Container({ isRenderGroup: true });
  container.sortableChildren = true;

  const background = new Container();
  background.zIndex = 0;
  const architecture = new Container();
  architecture.zIndex = 10;
  const rearProps = new Container();
  rearProps.zIndex = 20;
  const effectsLayer = new Container();
  effectsLayer.zIndex = 30;
  const peopleLayer = new Container();
  peopleLayer.sortableChildren = true;
  peopleLayer.zIndex = 40;
  const foreground = new Container();
  foreground.zIndex = 50;
  container.addChild(background, architecture, rearProps, effectsLayer, peopleLayer, foreground);

  const city = new Sprite(cityTexture);
  city.width = WORLD_WIDTH;
  city.height = WORLD_HEIGHT;
  city.alpha = 0.72;
  background.addChild(city);

  const cityShade = new Graphics();
  cityShade.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
    .fill({ color: 0x02080d, alpha: 0.28 });
  background.addChild(cityShade);

  const shell = new Sprite(architectureTexture);
  shell.width = WORLD_WIDTH;
  shell.height = WORLD_HEIGHT;
  architecture.addChild(shell);

  const stationSprites: Sprite[] = [];
  for (const placement of MODULES) {
    const target = placement.kind === "foreground" ? foreground : rearProps;
    const sprite = addModule(target, modulesTexture, placement);
    if (placement.kind === "station") stationSprites.push(sprite);
  }

  const glassWash = new Graphics();
  glassWash.rect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)
    .fill({ color: 0x0a3344, alpha: 0.035 });
  foreground.addChild(glassWash);

  const drawRain = createRain(effectsLayer);
  const tick = (time: number) => {
    drawRain(time);
    stationSprites.forEach((sprite, index) => {
      sprite.alpha = 0.97 + Math.sin(time * 1.15 + index) * 0.025;
    });
    city.x = Math.sin(time * 0.035) * 5;
  };

  return { container, peopleLayer, effectsLayer, tick };
}
