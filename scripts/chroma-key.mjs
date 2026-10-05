import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { PNG } from "pngjs";

const [, , inputPath, outputPath, mode] = process.argv;

if (!inputPath || !outputPath) {
  console.error("Usage: node scripts/chroma-key.mjs <input.png> <output.png> [--global]");
  process.exit(1);
}

const image = PNG.sync.read(readFileSync(inputPath));
const { width, height, data } = image;
const visited = new Uint8Array(width * height);
const queue = new Int32Array(width * height);
let head = 0;
let tail = 0;

function isGreen(index) {
  const offset = index * 4;
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return green > 105 && green - red > 32 && green - blue > 32;
}

function enqueue(index) {
  if (index < 0 || index >= width * height || visited[index] || !isGreen(index)) return;
  visited[index] = 1;
  queue[tail] = index;
  tail += 1;
}

if (mode === "--global") {
  for (let index = 0; index < width * height; index += 1) {
    if (isGreen(index)) visited[index] = 1;
  }
} else {
  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const index = queue[head];
    head += 1;
    const x = index % width;
    const y = Math.floor(index / width);
    if (x > 0) enqueue(index - 1);
    if (x + 1 < width) enqueue(index + 1);
    if (y > 0) enqueue(index - width);
    if (y + 1 < height) enqueue(index + width);
  }
}

let removed = 0;
for (let index = 0; index < visited.length; index += 1) {
  if (!visited[index]) continue;
  data[index * 4 + 3] = 0;
  removed += 1;
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, PNG.sync.write(image));
console.log(`${outputPath}: removed ${removed.toLocaleString()} background pixels`);
