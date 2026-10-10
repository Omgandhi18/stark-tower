import type { TerminalInfo, TerminalOutput } from "../../lib/bindings";

export const MIN_HEIGHT = 120;
export const DEFAULT_HEIGHT = 240;
export const clampHeight = (height: number, column: number) => Math.max(MIN_HEIGHT, Math.min(height, Math.max(MIN_HEIGHT, column * 0.7)));
const folderName = (folder: string) => folder.split("/").filter(Boolean).pop() || "Home";

/**
 * Each terminal's tab name: the program it's running, else its shell ("zsh"), numbered in the
 * order they were opened when names repeat ("zsh", "zsh 2"). One from another folder than
 * `folder` says which, so a tab never hides where its shell is.
 */
export function terminalLabels(items: readonly TerminalInfo[], folder: string): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const t of items) {
    const program = t.title && t.title !== t.shell ? t.title : t.shell || "Shell";
    const base = t.folder === folder ? program : `${program} · ${folderName(t.folder)}`;
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    labels.set(t.id, `${nth > 1 ? `${base} ${nth}` : base}${t.alive ? "" : " · Exited"}`);
  }
  return labels;
}
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
