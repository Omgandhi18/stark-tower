// Small colour helpers for re-tinting mockup pixels to states the mockup never showed.

function rgb(hex: string): [number, number, number] {
  const value = parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** HSL hue of `hex`, in degrees. */
export function hue(hex: string): number {
  const [r, g, b] = rgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/** A CSS filter rotating `from`'s hue onto `to`'s. */
export function recolorFilter(from: string, to: string): string {
  return `hue-rotate(${Math.round(hue(to) - hue(from))}deg)`;
}
