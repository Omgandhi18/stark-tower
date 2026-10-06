import { whenChoices } from "../reminders/reminderModel";

export type CaptureMode = "task" | "reminder";
export const toggleMode = (mode: CaptureMode): CaptureMode => (mode === "task" ? "reminder" : "task");

/** A whole leading phrase switches modes; words such as “remind melon” stay tasks. */
export function captureText(text: string, mode: CaptureMode): { text: string; mode: CaptureMode } {
  const prefix = /^\s*remind me(?:\s+|$)/i;
  return prefix.test(text) ? { text: text.replace(prefix, ""), mode: "reminder" } : { text, mode };
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
