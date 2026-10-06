// Portraits are keyed by appearance (`figure`), never by the agent's name:
// names are the user's to choose. A theme may dress them in its own outfits.
import { createContext } from "react";
import { fileUrl } from "../features/attachments/fileUrl";
import type { Look } from "../lib/bindings";

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

export interface PortraitKey { figure?: string | null; look?: string | null }
/** Names can change; a custom look belongs to the agent, with its figure as fallback. */
export function portraitKey(agent: PortraitKey | null | undefined): PortraitKey | undefined {
  return agent ? { figure: agent.figure, look: agent.look } : undefined;
}
export function portraitUrls(key: string | PortraitKey | null | undefined, outfits: string | null = null, looks: Record<string, Look> = {}): string[] {
  if (!key) return [];
  const figure = typeof key === "string" ? key : key.figure;
  const look = typeof key === "string" || !key.look ? undefined : looks[key.look];
  const paths = look ? [outfits ? look.paths[outfits] : undefined, look.paths.own].filter((p): p is string => !!p).map((p) => `${fileUrl(p)}?v=${look.revision}`) : [];
  const builtIn = (outfits ? find(OUTFITS, `/themes/${outfits}/portraits/${figure}.png`) : undefined) ?? find(OWN, `/portraits/${figure}.png`);
  return [...new Set([...paths, ...(builtIn ? [builtIn] : [])])];
}
/** Custom theme portrait, then custom own portrait, then the built-in figure. */
export function portraitUrl(key: string | PortraitKey | null | undefined, outfits: string | null = null, looks: Record<string, Look> = {}): string | undefined {
  return portraitUrls(key, outfits, looks)[0];
}
