// What Diagnostics says about each runtime check, in plain words.
import type { ShellPathHealth } from "../../lib/bindings";
import type { StateTone } from "../../lib/status";

const MS_PER_SECOND = 1000;
const FALLBACK_FOLDERS = "Homebrew, nvm, ~/.local/bin";

export interface CheckSummary {
  value: string;
  detail: string;
  tone: StateTone;
}

/** A time of day ("2:14 PM"), with the date when it wasn't today. */
export function clockTime(at: number, now = Date.now()): string {
  const when = new Date(at);
  const sameDay = when.toDateString() === new Date(now).toDateString();
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  return sameDay ? when.toLocaleTimeString(undefined, time) : when.toLocaleString(undefined, { month: "short", day: "numeric", ...time });
}

/** The Shell PATH row: whether the login shell's PATH was read, and when. */
export function shellPathSummary(path: ShellPathHealth, now = Date.now()): CheckSummary {
  const at = clockTime(path.readAt, now);
  if (path.reading) {
    return { value: "Reading it again…", detail: `Last read at ${at}. Until it's in, the last reading is used.`, tone: "idle" };
  }
  if (!path.read) {
    return {
      value: "Couldn't be read",
      detail: `${path.error ?? "No answer"} (at ${at}). Looking in the standard install folders instead (${FALLBACK_FOLDERS}).`,
      tone: "attention",
    };
  }
  return {
    value: `Read from ${path.shell} at ${at}, in ${(path.elapsedMs / MS_PER_SECOND).toFixed(1)}s`,
    detail: "Command-line tools are found where your terminal finds them. Installed one into a new folder? Check again.",
    tone: "success",
  };
}
