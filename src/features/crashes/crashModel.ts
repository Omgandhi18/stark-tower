// How the crash log reads: which crashes still need a decision, and how each is described.
import type { Crash } from "../../lib/types";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Crashes nobody has been asked about yet, oldest first. */
export function unasked(crashes: readonly Crash[]): Crash[] {
  return crashes.filter((c) => c.status === "new").sort((a, b) => a.crashedAt - b.crashedAt);
}

/** The log as it's listed: the latest crash first. */
export function newestFirst(crashes: readonly Crash[]): Crash[] {
  return [...crashes].sort((a, b) => b.crashedAt - a.crashedAt);
}

/** Crashes that can still be handed to the maintenance agent. */
export function undiagnosed(crashes: readonly Crash[]): Crash[] {
  return crashes.filter((c) => c.status !== "diagnosing");
}

/** "Starkline quit unexpectedly", or how many times it did. */
export function promptTitle(count: number): string {
  return count === 1 ? "Starkline quit unexpectedly" : `Starkline quit unexpectedly ${count} times`;
}

const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "today at 12:34", "yesterday at 22:40", "8 Oct at 22:40". */
export function crashTime(at: number, now: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return `today at ${time}`;
  if (days === 1) return `yesterday at ${time}`;
  const date = new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  return `${date} at ${time}`;
}

/** The same, starting a sentence or a row. */
export const crashTimeLabel = (at: number, now: number) => {
  const text = crashTime(at, now);
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export type CrashTone = "attention" | "neutral" | "accent";

/** A crash's status, as its row shows it. */
export function presentStatus(crash: Crash, maintainerName: string): { label: string; tone: CrashTone } {
  switch (crash.status) {
    case "new":
      return { label: "Not looked at", tone: "attention" };
    case "later":
      return { label: "Kept for later", tone: "neutral" };
    case "diagnosing":
      return { label: `With ${maintainerName}`, tone: "accent" };
  }
}
