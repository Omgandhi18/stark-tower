// "@path" mentions in a chat message: find the token being typed, and rank
// files and folders that match it.
import type { PathEntry } from "../../lib/types";

export interface MentionQuery {
  /** Where the "@" starts in the text. */
  start: number;
  query: string;
}

/** The `@token` the caret is inside, if any. */
export function detectMention(text: string, caret: number): MentionQuery | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const start = i + 1;
  const token = text.slice(start, caret);
  return token.startsWith("@") ? { start, query: token.slice(1) } : null;
}

export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

const SUGGESTION_LIMIT = 12;

/** Best matches first: name starts with the query, then contains it, then path matches. */
export function rankPaths(entries: readonly PathEntry[], query: string): PathEntry[] {
  const q = query.toLowerCase();
  const pool = q ? entries.filter((e) => e.path.toLowerCase().includes(q)) : [...entries];
  return pool
    .map((entry) => {
      const name = baseName(entry.path).toLowerCase();
      const score = name.startsWith(q) ? 0 : name.includes(q) ? 1 : entry.path.toLowerCase().startsWith(q) ? 2 : 3;
      return { entry, score };
    })
    .sort((a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length)
    .slice(0, SUGGESTION_LIMIT)
    .map((s) => s.entry);
}

/** Replace the mention being typed with the chosen path (folders end in "/"). */
export function insertMention(text: string, mention: MentionQuery, caret: number, entry: PathEntry) {
  const before = text.slice(0, mention.start);
  const after = text.slice(caret);
  const insert = `@${entry.path}${entry.dir ? "/" : ""} `;
  return { text: before + insert + after, caret: (before + insert).length };
}

/** How far the folder scan behind the picker has got. */
export type ScanStatus = "idle" | "loading" | "ready" | "error";

/** The DOM id of a picker option, for aria-activedescendant. */
export const optionId = (listId: string, index: number) => `${listId}-${index}`;
