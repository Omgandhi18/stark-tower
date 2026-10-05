// The primary navigation from the approved mockups. Every item is baked into the
// sidebar plate in its resting style; the active item is the mockup's own
// highlight (or a recoloured copy of it) laid over its row.
import {
  SIDEBAR_RECT,
  assetUrl,
  reference,
  rectHeight,
  rectWidth,
  relativeTo,
  type NavItemId,
  type Rect,
} from "../environment/reference/referenceAssets";
import { fontStyle } from "../environment/reference/typography";
import shell from "./rnd-shell.json";

const NAV = reference.nav;
const SLICES = shell.sidebar;

export const NAV_LABELS: Record<NavItemId, string> = {
  work: "Work",
  environment: "Environment",
  agents: "Agents",
  automations: "Automations",
  notifications: "Notifications",
  settings: "Settings",
};

const ORDER: readonly NavItemId[] = ["work", "environment", "agents", "automations", "notifications", "settings"];

function box(rect: Rect) {
  const r = relativeTo(rect, SIDEBAR_RECT);
  return { left: r[0], top: r[1], width: rectWidth(r), height: rectHeight(r) };
}

interface Props {
  active: NavItemId;
  notifications: number;
  onNavigate: (id: NavItemId) => void;
}

export default function SideNav({ active, notifications, onNavigate }: Props) {
  const plate = assetUrl(reference.plates.sidebar.file);
  const highlight = NAV.items[active];
  return (
    <nav className="rnd-sidenav" aria-label="Primary" style={{ width: rectWidth(SIDEBAR_RECT) }}>
      <div
        className="rnd-sidenav-plate"
        style={{
          borderImageSource: `url(${plate})`,
          borderImageSlice: `${SLICES.sliceTop} 0 ${SLICES.sliceBottom} 0 fill`,
          borderImageWidth: `${SLICES.sliceTop}px 0 ${SLICES.sliceBottom}px 0`,
        }}
      />
      <img className="rnd-sprite" src={assetUrl(highlight.file)} alt="" style={box(highlight.rect)} />
      {ORDER.map((id) => (
        <button
          key={id}
          type="button"
          className="rnd-hit"
          aria-current={id === active ? "page" : undefined}
          aria-label={NAV_LABELS[id]}
          onClick={() => onNavigate(id)}
          style={box(NAV.items[id].rect)}
        />
      ))}
      {notifications > 0 && (
        <>
          <img className="rnd-sprite" src={assetUrl(reference.sprites.navBadge.file)} alt="" style={box(reference.sprites.navBadge.rect)} />
          <span
            className="rnd-badge"
            aria-hidden
            style={{ ...box(reference.text.notificationsBadge.rect), ...fontStyle("badge"), color: reference.colors.badgeText }}
          >
            {notifications}
          </span>
        </>
      )}
    </nav>
  );
}
