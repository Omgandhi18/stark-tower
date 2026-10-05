// Renders Lucide's "bot" glyph (the brand mark) as the macOS menu bar template
// image: black strokes on transparent, 22 pt at 2x. Run: node scripts/render-tray-icon.mjs
import { webkit } from "@playwright/test";
import { __iconNode as nodes } from "lucide-react/dist/esm/icons/bot.mjs";

const SIZE = 44;
const STROKE = 2;
const OUT = "src-tauri/icons/tray-template.png";

const body = nodes
  .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
  .join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const browser = await webkit.launch();
const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
await page.locator("svg").screenshot({ path: OUT, omitBackground: true });
await browser.close();
console.log(`wrote ${OUT}`);
