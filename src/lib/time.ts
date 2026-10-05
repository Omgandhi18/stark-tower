// Durations and "how long ago" in the compact form the UI uses everywhere.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45s", "12m", "1h 12m", "3d 4h". */
export function formatElapsed(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < MINUTE) return `${Math.floor(safe / 1000)}s`;
  if (safe < HOUR) return `${Math.floor(safe / MINUTE)}m`;
  if (safe < DAY) {
    const h = Math.floor(safe / HOUR);
    const m = Math.floor((safe % HOUR) / MINUTE);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(safe / DAY);
  const h = Math.floor((safe % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** "just now", "12m ago", "3h ago", "yesterday", or a date for anything older. */
export function formatRelative(at: number, now = Date.now()): string {
  const diff = now - at;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 2 * DAY) return "yesterday";
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
