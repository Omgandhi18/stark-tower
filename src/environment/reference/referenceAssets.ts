// Typed access to the layers cut from the approved After Hours R&D mockup
// (scripts/mockup-extract). Every rect is [x0, y0, x1, y1) in mockup pixels,
// which are the app's CSS pixels at the 1584 x 993 reference viewport.
import manifestJson from "../../assets/themes/after-hours-rnd/reference/manifest.json";

export type Rect = readonly [number, number, number, number];

export type NavItemId = "work" | "environment" | "agents" | "automations" | "notifications" | "settings";

interface LayerEntry {
  file: string;
  rect: Rect;
}

interface ReferenceManifest {
  source: string;
  viewport: readonly [number, number];
  plates: Record<"topbar" | "sidebar" | "environment", LayerEntry>;
  sprites: Record<"brand" | "toggleOn" | "statusDot" | "bellBadge" | "navBadge" | "cardDot", LayerEntry>;
  panels: Record<"agentCard" | "focusControl" | "zoomControl" | "fullscreenControl", LayerEntry>;
  /** Original pixels of things that can leave the picture (occupied seats, helper bots). */
  cutouts: Record<string, LayerEntry>;
  nav: {
    highlightX: readonly [number, number];
    items: Record<NavItemId, LayerEntry>;
    activeItem: NavItemId;
    inkInactive: string;
    inkActive: string;
  };
  colors: Record<"statusOk" | "statusDot" | "badgeFill" | "badgeText" | "cardName" | "cardStatus" | "cardTask" | "cardDot" | "controlText", string>;
  text: Record<
    "statusValue" | "notificationsBadge" | "bellBadge" | "statusDot" | "cardDot" | "cardName" | "cardStatus" | "cardTask" | "focusLabel" | "zoomLabel",
    { rect: Rect }
  >;
}

export const reference = manifestJson as unknown as ReferenceManifest;

const urls = import.meta.glob<string>("../../assets/themes/after-hours-rnd/reference/*.png", {
  eager: true,
  query: "?url",
  import: "default",
});

/** Resolve a manifest file name to its bundled URL. */
export function assetUrl(file: string): string {
  const match = Object.entries(urls).find(([path]) => path.endsWith(`/${file}`));
  if (!match) throw new Error(`Reference asset missing from bundle: ${file}`);
  return match[1];
}

export const rectWidth = (r: Rect) => r[2] - r[0];
export const rectHeight = (r: Rect) => r[3] - r[1];

/** Shift a rect into another layer's coordinate space. */
export function relativeTo(r: Rect, origin: Rect): Rect {
  return [r[0] - origin[0], r[1] - origin[1], r[2] - origin[0], r[3] - origin[1]];
}

export const VIEWPORT = { width: reference.viewport[0], height: reference.viewport[1] } as const;
export const TOPBAR_RECT = reference.plates.topbar.rect;
export const SIDEBAR_RECT = reference.plates.sidebar.rect;
export const ENVIRONMENT_RECT = reference.plates.environment.rect;
