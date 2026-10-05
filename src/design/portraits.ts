// Portraits are keyed by appearance (`figure`), never by the agent's name:
// names are the user's to choose. A theme may dress them in its own outfits.
import { createContext } from "react";

const OWN = import.meta.glob<string>("../assets/portraits/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

const OUTFITS = import.meta.glob<string>("../assets/themes/*/portraits/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

/** The theme folder whose outfits portraits wear (for example "studio-office"); null for the agents' own look. */
export const PortraitOutfits = createContext<string | null>(null);

const find = (urls: Record<string, string>, suffix: string) => Object.entries(urls).find(([path]) => path.endsWith(suffix))?.[1];

/** A figure's portrait, in a theme's outfits where that theme has one. */
export function portraitUrl(figure: string | null | undefined, outfits: string | null = null): string | undefined {
  if (!figure) return undefined;
  return (outfits ? find(OUTFITS, `/themes/${outfits}/portraits/${figure}.png`) : undefined) ?? find(OWN, `/portraits/${figure}.png`);
}
