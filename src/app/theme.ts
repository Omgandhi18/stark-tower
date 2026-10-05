// How Starkline looks. A theme is a set of values for the design tokens (and,
// for the themes whose rooms are built, its Environment). Tasks, permissions
// and providers never change with it.
import { create } from "zustand";
import { useEffect } from "react";
import { useConfig } from "../stores/config";

export type ThemeId = "rnd" | "office" | "mori";

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  /** The palette in words, as the Theme Studio names it. */
  palette: string;
  description: string;
  /** Whether this theme's own room is built; otherwise the team works in After Hours R&D. */
  roomBuilt: boolean;
}

export const THEMES: readonly ThemeInfo[] = [
  {
    id: "rnd",
    name: "After Hours R&D",
    palette: "Graphite · Cyan · Amber",
    description: "Sleek, high-contrast workspace for deep work. Rainy tower, glowing screens, late nights.",
    roomBuilt: true,
  },
  {
    id: "office",
    name: "Studio Office",
    palette: "Parchment · Tobacco · Oxidized Green",
    description: "Warm, comfortable workspace for collaboration. A lived-in office with natural light and character.",
    roomBuilt: false,
  },
  {
    id: "mori",
    name: "Mori Cafe",
    palette: "Ink Indigo · Moss Green · Lantern Amber",
    description: "Calm, focused workspace inspired by coffee, nature and craft. A rainy cafe with a view of the forest.",
    roomBuilt: false,
  },
];

export const DEFAULT_THEME: ThemeId = "rnd";
const STORAGE_KEY = "starkline.theme";

export const asTheme = (value: string | null | undefined): ThemeId => THEMES.find((t) => t.id === value)?.id ?? DEFAULT_THEME;

export const themeInfo = (id: ThemeId): ThemeInfo => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** The theme saved on this Mac last time, so the first paint already wears it. */
export function storedTheme(): ThemeId {
  try {
    return asTheme(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** Dress the whole app in a theme; `remember` it for the next launch's first paint (not for previews). */
export function applyTheme(id: ThemeId, remember = true): void {
  document.documentElement.dataset.theme = id;
  if (!remember) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Private storage: the saved config still applies once it loads.
  }
}

interface ThemePreviewState {
  /** A theme being tried on in the Theme Studio, before it's applied. */
  preview: ThemeId | null;
  setPreview: (id: ThemeId | null) => void;
}

export const useThemePreview = create<ThemePreviewState>((set) => ({
  preview: null,
  setPreview: (preview) => set({ preview }),
}));

/** The theme on screen: one being previewed, else the saved one. */
export function useActiveTheme(): ThemeId {
  const saved = useConfig((s) => s.config?.theme);
  const preview = useThemePreview((s) => s.preview);
  return preview ?? (saved === undefined ? storedTheme() : asTheme(saved));
}

/** Keep the document dressed in the active theme. */
export function useThemeSync(): void {
  const active = useActiveTheme();
  const previewing = useThemePreview((s) => s.preview !== null);
  useEffect(() => applyTheme(active, !previewing), [active, previewing]);
}
