// One icon family (Lucide) with one stroke weight, so every glyph in the app
// shares the same visual density.
export const ICON_STROKE = 1.75;

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 22,
} as const;

export type IconSize = keyof typeof ICON_SIZE;
