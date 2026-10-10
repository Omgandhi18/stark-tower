import type { BrowserPick, SimulatorPoint } from "../../lib/types";

const n = (value: number) => Math.round(value);

/** A fence longer than any run of backticks in the code, so the page's own text can't end it early. */
export function fenceFor(code: string): string {
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (run) => run[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function collapsed(summary: string, language: string, code: string): string {
  const fence = fenceFor(code);
  return `\n<details><summary>${summary}</summary>\n\n${fence}${language}\n${code}\n${fence}\n</details>`;
}

export function browserPointText(pick: BrowserPick): string {
  const s = pick.styles,
    b = pick.bounds;
  const element = pick.tag + pick.classes.map((c) => `.${c}`).join("");
  const styleText = [
    s["background-color"] && `background ${s["background-color"]}`,
    s.color && `color ${s.color}`,
    s["font-size"] && `${s["font-size"]}/${s["line-height"] || "normal"} ${s["font-family"] || ""} ${s["font-weight"] || ""}`.trim(),
    s.padding && `padding ${s.padding}`,
    s["border-radius"] && `radius ${s["border-radius"]}`,
  ]
    .filter(Boolean)
    .join(" · ");
  const { outer_html, ...details } = pick;
  const metadata = collapsed("Element details", "json", JSON.stringify(details, null, 2));
  const html = outer_html ? collapsed("Element HTML", "html", outer_html) : "";
  const name = (pick.accessible_name || pick.text).replace(/\s+/g, " ").trim();
  return `In the browser at ${pick.url}, I'm pointing at:\n${element} "${name}" (${pick.selector})\n${n(b.width)} × ${n(b.height)} at ${n(b.x)}, ${n(b.y)}${styleText ? ` · ${styleText}` : ""}${metadata}${html}\n`;
}
export function simulatorPointText(point: SimulatorPoint): string {
  const el = point.element;
  const f = el?.frame;
  const element = el
    ? `${el.role || "Element"} “${(el.label || "").replace(/\s+/g, " ").trim()}”${el.value ? ` · value ${el.value}` : ""}${f ? ` (${n(f.x)}, ${n(f.y)}, ${n(f.width)} × ${n(f.height)})` : ""}`
    : "No accessibility element was available.";
  return `On ${point.device}, at ${n(point.x)}, ${n(point.y)} (points): ${element}\n`;
}

// ---- Reading a point back ---------------------------------------------------------------
// The text above is what the agent receives, and what is saved. These turn it back into
// something to read: the composer's chip and the transcript's card, for a message just sent
// and for one saved long ago.

export interface PointFact {
  label: string;
  value: string;
}

export interface PointSummary {
  kind: "browser" | "simulator";
  /** What was pointed at: `button “Save changes”`. */
  title: string;
  /** Where: a page's host, or the device. */
  place: string;
  /** "120 × 32", when known. */
  size: string | null;
  facts: PointFact[];
  /** The element's own HTML (browser only). */
  html: string | null;
}

export type PointPart = { type: "text"; text: string } | { type: "point"; point: PointSummary; text: string };

const BROWSER_POINT = /^In the browser at (\S+), I'm pointing at:\n(\S+) "(.*)" \((.*)\)\n(\d+) × (\d+) at (-?\d+), (-?\d+)(?: · (.*))?/gm;
const SIMULATOR_POINT = /^On (.+), at (-?\d+), (-?\d+) \(points\): (.*)(?:\n|$)/gm;
const DETAILS_BLOCK = /^\n?<details><summary>(Element details|Element HTML)<\/summary>\n\n(`{3,})(?:json|html)\n([\s\S]*?)\n\2\n<\/details>\n?/;
const TITLE_LENGTH = 48;

const clip = (text: string) => (text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1)}…` : text);
const quoted = (name: string) => (name ? ` “${clip(name)}”` : "");

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The collapsed blocks that follow a browser point: its details as JSON, then its HTML. */
function takeDetails(text: string): { json: Record<string, unknown>; html: string | null; length: number } {
  let json: Record<string, unknown> = {};
  let html: string | null = null;
  let length = 0;
  for (let block = DETAILS_BLOCK.exec(text); block; block = DETAILS_BLOCK.exec(text.slice(length))) {
    length += block[0].length;
    if (block[1] === "Element HTML") html = block[3];
    else
      try {
        json = recordOf(JSON.parse(block[3]));
      } catch {
        // Details that don't parse still leave the rest of the card.
      }
  }
  return { json, html, length };
}

function browserSummary(m: RegExpExecArray, after: string): { point: PointSummary; length: number } {
  const [, url, element, nameLine, selectorLine, width, height, x, y, styleLine] = m;
  const { json, html, length } = takeDetails(after);
  const tag = String(json.tag ?? element.split(/[.#]/)[0]);
  const name = String(json.accessible_name || json.text || nameLine);
  const selector = String(json.selector ?? selectorLine);
  const styles = Object.entries(recordOf(json.styles)).map(([key, value]) => `${key}: ${value}`);
  const viewport = recordOf(json.viewport);
  const page = [json.title, url].filter(Boolean).join(" · ");
  const facts: PointFact[] = [
    { label: "Page", value: page },
    { label: "Selector", value: selector },
    ...(json.role ? [{ label: "Role", value: String(json.role) }] : []),
    { label: "Size", value: `${width} × ${height} at ${x}, ${y}` },
    ...(styles.length || styleLine ? [{ label: "Styles", value: styles.length ? styles.join("\n") : (styleLine ?? "") }] : []),
    ...(viewport.width && viewport.height ? [{ label: "Window", value: `${viewport.width} × ${viewport.height}` }] : []),
  ];
  return { point: { kind: "browser", title: `${tag}${quoted(name.replace(/\s+/g, " ").trim())}`, place: hostOf(url), size: `${width} × ${height}`, facts, html }, length };
}

function simulatorSummary(m: RegExpExecArray): PointSummary {
  const [, device, x, y, element] = m;
  const found = /^(.*?) “(.*)”(?: · value (.*?))?(?: \((-?\d+), (-?\d+), (-?\d+) × (-?\d+)\))?$/.exec(element);
  const frame = found?.[4] ? `${found[6]} × ${found[7]}` : null;
  return {
    kind: "simulator",
    title: found ? `${found[1]}${quoted(found[2])}` : "A point on the screen",
    place: device,
    size: frame,
    facts: [
      { label: "Device", value: device },
      { label: "Position", value: `${x}, ${y} (points)` },
      ...(found?.[3] ? [{ label: "Value", value: found[3] }] : []),
      ...(frame ? [{ label: "Frame", value: `${frame} at ${found?.[4]}, ${found?.[5]}` }] : []),
      ...(!found ? [{ label: "Element", value: element }] : []),
    ],
    html: null,
  };
}

const next = (pattern: RegExp, text: string, from: number) => {
  pattern.lastIndex = from;
  return pattern.exec(text);
};

/** A message split into plain text and the points in it, in order. A message with no point is one text part. */
export function parsePoints(text: string): PointPart[] {
  const parts: PointPart[] = [];
  const addText = (chunk: string) => {
    const trimmed = chunk.replace(/^\n+|\s+$/g, "");
    if (trimmed) parts.push({ type: "text", text: trimmed });
  };
  let cursor = 0;
  for (;;) {
    const browser = next(BROWSER_POINT, text, cursor);
    const simulator = next(SIMULATOR_POINT, text, cursor);
    const found = browser && (!simulator || browser.index <= simulator.index) ? browser : simulator;
    if (!found) break;
    addText(text.slice(cursor, found.index));
    let end = found.index + found[0].length;
    let point: PointSummary;
    if (found === browser) {
      const read = browserSummary(browser, text.slice(end));
      point = read.point;
      end += read.length;
    } else {
      point = simulatorSummary(found);
    }
    parts.push({ type: "point", point, text: text.slice(found.index, end).trimEnd() });
    cursor = end;
  }
  addText(text.slice(cursor));
  return parts;
}
