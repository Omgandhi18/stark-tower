import type { Bounds, Output } from "../../lib/types";

export const BROWSER_SIZES = [
  { value: "fit", label: "Fit panel", width: 0, height: 0 },
  { value: "phone", label: "Phone 390 × 844", width: 390, height: 844 },
  { value: "large-phone", label: "Large phone 430 × 932", width: 430, height: 932 },
  { value: "tablet", label: "Tablet 820 × 1180", width: 820, height: 1180 },
  { value: "laptop", label: "Laptop 1280 × 800", width: 1280, height: 800 },
] as const;
export type BrowserSize = (typeof BROWSER_SIZES)[number]["value"];

const EMPTY_TAB = "New tab";

/** What a tab is called: its page's title, else the site it's on, else that it's empty. */
export function tabLabel(tab: { url: string; title: string }): string {
  const title = tab.title.trim();
  if (title) return title;
  try {
    return new URL(tab.url).host || EMPTY_TAB;
  } catch {
    return EMPTY_TAB;
  }
}

export function fitBrowser(panel: Bounds, size: BrowserSize) {
  const device = BROWSER_SIZES.find((s) => s.value === size) ?? BROWSER_SIZES[0];
  if (!device.width) return { bounds: panel, zoom: 1, label: "" };
  const zoom = Math.max(0.01, Math.min(1, Math.max(0, panel.width - 24) / device.width, Math.max(0, panel.height - 24) / device.height));
  const width = device.width * zoom;
  const height = device.height * zoom;
  return {
    bounds: { x: panel.x + (panel.width - width) / 2, y: panel.y + (panel.height - height) / 2, width, height },
    zoom,
    label: `${device.width} × ${device.height} · ${Math.round(zoom * 100)}%`,
  };
}

/** Snapshots and streamed batches can overlap while the output pane opens. */
export function mergeOutput(current: Output | undefined, incoming: Output): Output {
  if (!current || incoming.generation > current.generation) return { ...incoming, lines: incoming.lines.slice(-2000) };
  if (incoming.generation < current.generation) return current;
  const currentStart = current.cursor - current.lines.length;
  const incomingStart = incoming.cursor - incoming.lines.length;
  if (incoming.cursor <= current.cursor) {
    if (incomingStart >= currentStart) return current;
    const prefix = incoming.lines.slice(0, Math.max(0, currentStart - incomingStart));
    return { ...current, lines: [...prefix, ...current.lines].slice(-2000) };
  }
  if (incomingStart <= currentStart) return { ...incoming, lines: incoming.lines.slice(-2000) };
  const fresh = incoming.lines.slice(-Math.min(incoming.lines.length, incoming.cursor - current.cursor));
  return { ...incoming, lines: [...current.lines, ...fresh].slice(-2000) };
}
