// How Starkline looks. A theme is a set of values for the design tokens (and,
// once its art is built, its Environment room). Tasks, permissions and
// providers never change with it.
import { create } from "zustand";
import { useEffect } from "react";
import { useConfig } from "../stores/config";

export type ThemeId = "rnd" | "office" | "mori";

export interface ThemeInfo {
  id: ThemeId;
  /** Where its art lives under src/assets/themes. */
  folder: string;
  name: string;
  /** The palette in words, as the Theme Studio names it. */
  palette: string;
  description: string;
}

export const THEMES: readonly ThemeInfo[] = [
  {
    id: "rnd",
    folder: "after-hours-rnd",
    name: "After Hours R&D",
    palette: "Graphite · Cyan · Amber",
    description: "Sleek, high-contrast workspace for deep work. Rainy tower, glowing screens, late nights.",
  },
  {
    id: "office",
    folder: "studio-office",
    name: "Studio Office",
    palette: "Parchment · Tobacco · Oxidized Green",
    description: "Warm, comfortable workspace for collaboration. A lived-in office with natural light and character.",
  },
  {
    id: "mori",
    folder: "mori-cafe",
    name: "Mori Cafe",
    palette: "Ink Indigo · Moss Green · Lantern Amber",
    description: "Calm, focused workspace inspired by coffee, nature and craft. A rainy cafe with a view of the forest.",
  },
];

export const DEFAULT_THEME: ThemeId = "rnd";
const STORAGE_KEY = "starkline.theme";

export const asTheme = (value: string | null | undefined): ThemeId => THEMES.find((t) => t.id === value)?.id ?? DEFAULT_THEME;

export const themeInfo = (id: ThemeId): ThemeInfo => THEMES.find((t) => t.id === id) ?? THEMES[0];

/** What the agents wear: the active theme's outfits, their own look in every theme, or one theme's outfits. */
export type Outfits = "theme" | "own" | ThemeId;

export const DEFAULT_OUTFITS: Outfits = "theme";

export const asOutfits = (value: string | null | undefined): Outfits =>
  value === "theme" || value === "own" ? value : (THEMES.find((t) => t.id === value)?.id ?? DEFAULT_OUTFITS);

/** The theme whose outfits are worn, or null for the agents' own look (which After Hours R&D's outfits are). */
export function outfitTheme(outfits: Outfits, active: ThemeId): ThemeId | null {
  const theme = outfits === "own" ? null : outfits === "theme" ? active : outfits;
  return theme === DEFAULT_THEME ? null : theme;
}

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
  /** The outfits tried on with it. */
  outfits: Outfits | null;
  setPreview: (id: ThemeId | null, outfits?: Outfits) => void;
}

export const useThemePreview = create<ThemePreviewState>((set) => ({
  preview: null,
  outfits: null,
  setPreview: (preview, outfits) => set({ preview, outfits: preview === null ? null : (outfits ?? null) }),
}));

/** The theme on screen: one being previewed, else the saved one. */
export function useActiveTheme(): ThemeId {
  const saved = useConfig((s) => s.config?.theme);
  const preview = useThemePreview((s) => s.preview);
  return preview ?? (saved === undefined ? storedTheme() : asTheme(saved));
}

/** The outfits in effect: being previewed, else saved. */
export function useOutfits(): Outfits {
  const saved = useConfig((s) => s.config?.outfits);
  const preview = useThemePreview((s) => s.outfits);
  return preview ?? asOutfits(saved);
}

/** The asset folder of the outfits portraits wear now, or null for the agents' own look. */
export function useOutfitsFolder(): string | null {
  const theme = outfitTheme(useOutfits(), useActiveTheme());
  return theme ? themeInfo(theme).folder : null;
}

/** Keep the document dressed in the active theme. */
export function useThemeSync(): void {
  const active = useActiveTheme();
  const previewing = useThemePreview((s) => s.preview !== null);
  useEffect(() => applyTheme(active, !previewing), [active, previewing]);
}
