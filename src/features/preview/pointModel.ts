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
  return `In the browser at ${pick.url}, I'm pointing at:\n${element} "${pick.accessible_name || pick.text}" (${pick.selector})\n${n(b.width)} × ${n(b.height)} at ${n(b.x)}, ${n(b.y)}${styleText ? ` · ${styleText}` : ""}${metadata}${html}\n`;
}
export function simulatorPointText(point: SimulatorPoint): string {
  const el = point.element;
  const f = el?.frame;
  const element = el
    ? `${el.role || "Element"} “${el.label || ""}”${el.value ? ` · value ${el.value}` : ""}${f ? ` (${n(f.x)}, ${n(f.y)}, ${n(f.width)} × ${n(f.height)})` : ""}`
    : "No accessibility element was available.";
  return `On ${point.device}, at ${n(point.x)}, ${n(point.y)} (points): ${element}\n`;
}
export function insertPoint(draft: string, text: string, start: number, end = start) {
  const at = Math.max(0, Math.min(start, draft.length));
  const block = `${at && draft[at - 1] !== "\n" ? "\n" : ""}${text}`;
  return { text: draft.slice(0, at) + block + draft.slice(Math.max(at, end)), caret: at + block.length };
}
