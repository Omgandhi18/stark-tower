// Folder listings for the @ file picker, scanned on demand and reused briefly
// (agents create files as they work, so a listing goes stale quickly).
import { listFiles } from "../../lib/api";
import type { PathEntry } from "../../lib/types";

const FRESH_MS = 30_000;

interface Scan {
  at: number;
  entries: Promise<PathEntry[]>;
}

const scans = new Map<string, Scan>();

export function scanFolder(folder: string, now = Date.now()): Promise<PathEntry[]> {
  const cached = scans.get(folder);
  if (cached && now - cached.at < FRESH_MS) return cached.entries;
  const entries = listFiles(folder).catch((error: unknown) => {
    scans.delete(folder);
    throw error;
  });
  scans.set(folder, { at: now, entries });
  return entries;
}

/** Test hook: forget every cached listing. */
export function clearScans() {
  scans.clear();
}
