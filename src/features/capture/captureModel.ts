import { whenChoices } from "../reminders/reminderModel";

export type CaptureMode = "task" | "reminder" | "todo";

/** The modes in their tab order; Tab moves to the next. */
export const CAPTURE_MODES: readonly CaptureMode[] = ["task", "reminder", "todo"];
export const toggleMode = (mode: CaptureMode): CaptureMode => CAPTURE_MODES[(CAPTURE_MODES.indexOf(mode) + 1) % CAPTURE_MODES.length];

/** Leading phrases that switch modes, as whole words: “remind melon” and “todos are broken” stay tasks. */
const PREFIXES: ReadonlyArray<{ pattern: RegExp; mode: CaptureMode }> = [
  { pattern: /^\s*remind me(?:\s+|$)/i, mode: "reminder" },
  { pattern: /^\s*to-?do(?::\s*|\s+|$)/i, mode: "todo" },
];

/** A whole leading phrase switches modes, and is taken off the text. */
export function captureText(text: string, mode: CaptureMode): { text: string; mode: CaptureMode } {
  const found = PREFIXES.find((p) => p.pattern.test(text));
  return found ? { text: text.replace(found.pattern, ""), mode: found.mode } : { text, mode };
}

/** Match the same quick times as the reminder composer, at the end of the message. */
export function reminderPhrase(text: string, now: number): { text: string; choice: string | null } {
  for (const option of whenChoices(now)) {
    const pattern = new RegExp(`(?:^|\\s+)${option.label}[.!]?\\s*$`, "i");
    if (pattern.test(text)) return { text: text.replace(pattern, "").trim(), choice: option.id };
  }
  return { text, choice: null };
}

export function shortcutLabel(value: string): string {
  const keys: Record<string, string> = { Super: "⌘", Control: "⌃", Alt: "⌥", Shift: "⇧", Space: "Space" };
  const parts = value.split("+");
  const modifiers = ["Control", "Alt", "Shift", "Super"].filter((key) => parts.includes(key));
  const key = parts.filter((part) => !modifiers.includes(part));
  return [...modifiers, ...key].map((part) => keys[part] ?? part.replace(/^(Key|Digit)/, "")).join("");
}

export function recordedShortcut(event: { code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): string | null {
  if (!event.metaKey && !event.ctrlKey && !event.altKey) return null;
  if (/^(Meta|Control|Alt|Shift)/.test(event.code) || !event.code) return null;
  const modifiers = [event.metaKey && "Super", event.ctrlKey && "Control", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
  return [...modifiers, event.code].join("+");
}
