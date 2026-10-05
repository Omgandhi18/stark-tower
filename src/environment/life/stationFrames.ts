// A station's cut-out, animated in place: copies of the room's own pixels with
// the head moved a pixel (breathing, a glance, a nod) or a hand pressed a pixel
// down (a keystroke). The block that moves leaves its edge row behind, so the
// picture never tears; the plate under the cut-out fills the rest.
import { Texture } from "pixi.js";
import type { CastJson, HeadPose } from "./types";

const SHIFT: Record<HeadPose, readonly [number, number]> = {
  rest: [0, 0],
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** Move the pixels inside `rect` by (dx, dy), in place; pixels the block leaves keep their old value. */
function shift(dst: Uint8ClampedArray, src: Uint8ClampedArray, w: number, h: number, rect: readonly number[], dx: number, dy: number): void {
  const [x0, y0, x1, y1] = rect;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    const ty = y + dy;
    if (ty < 0 || ty >= h) continue;
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const tx = x + dx;
      if (tx < 0 || tx >= w) continue;
      const s = (y * w + x) * 4;
      if (src[s + 3] === 0) continue; // transparent pixels don't paint over what's there
      const d = (ty * w + tx) * 4;
      dst[d] = src[s];
      dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2];
      dst[d + 3] = src[s + 3];
    }
  }
}

export class StationFrames {
  private readonly cache = new Map<string, Texture>();
  private readonly pixels: Uint8ClampedArray | null;
  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly base: Texture,
    private readonly parts: CastJson["parts"],
  ) {
    this.width = base.width;
    this.height = base.height;
    this.pixels = readPixels(base);
    this.cache.set("rest:-1", base);
  }

  texture(head: HeadPose, hand: number): Texture {
    const hands = this.parts.hands ?? [];
    const handBox = hand >= 0 ? hands[hand] : undefined;
    const key = `${head}:${handBox ? hand : -1}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (!this.pixels) return this.base;
    const out = new Uint8ClampedArray(this.pixels);
    const [dx, dy] = SHIFT[head];
    if (dx || dy) shift(out, this.pixels, this.width, this.height, this.parts.head, dx, dy);
    if (handBox) {
      const before = new Uint8ClampedArray(out);
      shift(out, before, this.width, this.height, handBox, 0, 1);
    }
    const texture = toTexture(out, this.width, this.height);
    this.cache.set(key, texture);
    return texture;
  }

  /** Every texture made so far (the renderer sets their scale mode with the camera). */
  textures(): Texture[] {
    return [...this.cache.values()];
  }

  destroy(): void {
    for (const [key, texture] of this.cache) if (key !== "rest:-1") texture.destroy(true);
    this.cache.clear();
  }
}

function readPixels(texture: Texture): Uint8ClampedArray | null {
  const resource = texture.source.resource as CanvasImageSource | undefined;
  if (!resource) return null;
  const canvas = document.createElement("canvas");
  canvas.width = texture.width;
  canvas.height = texture.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(resource, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function toTexture(pixels: Uint8ClampedArray, width: number, height: number): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx?.putImageData(new ImageData(new Uint8ClampedArray(pixels), width, height), 0, 0);
  return Texture.from(canvas);
}
