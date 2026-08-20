import type { LightPhase } from "./types";

/** Resolve a configured lighting mode into the phase the floor should render. */
export function resolvePhase(mode: string): LightPhase {
  if (mode === "morning" || mode === "day" || mode === "evening" || mode === "night") {
    return mode;
  }
  if (mode === "system") {
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
    return dark ? "night" : "day";
  }
  // "auto" → wall clock
  const h = new Date().getHours();
  if (h >= 5 && h < 10) return "morning";
  if (h >= 10 && h < 17) return "day";
  if (h >= 17 && h < 20) return "evening";
  return "night";
}

/** UI cycle order + labels for the top-bar control. */
export const LIGHT_MODES = ["auto", "system", "morning", "day", "evening", "night"] as const;
export const LIGHT_LABEL: Record<string, string> = {
  auto: "Auto",
  system: "System",
  morning: "Morning",
  day: "Day",
  evening: "Evening",
  night: "Night",
};
