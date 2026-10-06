import type { TerminalOutput } from "../../lib/bindings";

export const MIN_HEIGHT = 120;
export const DEFAULT_HEIGHT = 240;
export const clampHeight = (height: number, column: number) => Math.max(MIN_HEIGHT, Math.min(height, Math.max(MIN_HEIGHT, column * 0.7)));
export const terminalLabel = (folder: string, title: string, shell: string) => {
  const name = folder.split("/").filter(Boolean).pop() || "Home";
  return title && title !== shell ? `${name} · ${title}` : name;
};
export function localTerminalLink(uri: string) {
  try {
    const url = new URL(uri);
    return ["http:", "https:"].includes(url.protocol) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}

/** Trim live bytes already included in a replay, including a wrapping counter. */
export function unseenOutput(output: TerminalOutput, offset: number) {
  const advance = (output.offset - offset) >>> 0;
  return advance === 0 || advance > 0x7fffffff ? new Uint8Array() : new Uint8Array(output.data.slice(-Math.min(advance, output.data.length)));
}
