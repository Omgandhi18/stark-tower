// The top bar from the approved mockups. Static chrome is the mockup's own
// pixels; supervisor health, the notification badge and Keep Awake are live.
// Native window controls come from the OS, so the brand moves aside for them.
import {
  TOPBAR_RECT,
  VIEWPORT,
  assetUrl,
  reference,
  rectHeight,
  rectWidth,
  type Rect,
} from "../environment/reference/referenceAssets";
import {
  SUPERVISOR_COLOR,
  SUPERVISOR_DOT_FILTER,
  SUPERVISOR_LABEL,
  type SupervisorHealth,
} from "../environment/reference/referenceState";
import { fontStyle, textStyle } from "../environment/reference/typography";
import { HAS_LEFT_WINDOW_CONTROLS } from "../lib/platform";
import shell from "./rnd-shell.json";

const SPRITES = reference.sprites;
const TEXT = reference.text;
const AREAS = shell.topbar;
const BRAND_SHIFT = HAS_LEFT_WINDOW_CONTROLS ? shell.windowControls.brandShift : 0;
/** Mockup x where the right-anchored group begins. */
const RIGHT_ORIGIN = VIEWPORT.width - AREAS.sliceRight;

/** Position a mockup rect inside the right-anchored group. */
function inRightGroup(rect: Rect): Rect {
  return [rect[0] - RIGHT_ORIGIN, rect[1], rect[2] - RIGHT_ORIGIN, rect[3]];
}

function box(rect: Rect) {
  return { left: rect[0], top: rect[1], width: rectWidth(rect), height: rectHeight(rect) };
}

const area = (r: readonly number[]) => r as unknown as Rect;

interface Props {
  supervisor: SupervisorHealth;
  notifications: number;
  keepAwake: boolean;
  onToggleKeepAwake: () => void;
  onOpenNotifications: () => void;
}

export default function TopBar({ supervisor, notifications, keepAwake, onToggleKeepAwake, onOpenNotifications }: Props) {
  const plate = assetUrl(reference.plates.topbar.file);
  return (
    <header className="rnd-topbar" data-tauri-drag-region style={{ height: rectHeight(TOPBAR_RECT) }}>
      <div
        className="rnd-topbar-plate"
        data-tauri-drag-region
        style={{
          borderImageSource: `url(${plate})`,
          borderImageSlice: `0 ${AREAS.sliceRight} 0 ${AREAS.sliceLeft} fill`,
          borderImageWidth: `0 ${AREAS.sliceRight}px 0 ${AREAS.sliceLeft}px`,
        }}
      />

      <img
        className="rnd-sprite"
        src={assetUrl(SPRITES.brand.file)}
        alt="Starkline"
        data-tauri-drag-region
        style={{ left: SPRITES.brand.rect[0] + BRAND_SHIFT, top: SPRITES.brand.rect[1] }}
      />

      <div className="rnd-topbar-right" data-tauri-drag-region style={{ width: AREAS.sliceRight }}>
        <div role="status" data-tauri-drag-region aria-label={`Local supervisor: ${SUPERVISOR_LABEL[supervisor]}`}>
          <img
            className="rnd-sprite"
            src={assetUrl(SPRITES.statusDot.file)}
            alt=""
            style={{ ...box(inRightGroup(SPRITES.statusDot.rect)), filter: SUPERVISOR_DOT_FILTER[supervisor] }}
          />
          <span style={textStyle("statusValue", inRightGroup(TEXT.statusValue.rect), SUPERVISOR_COLOR[supervisor])}>
            {SUPERVISOR_LABEL[supervisor]}
          </span>
        </div>

        <button
          type="button"
          className="rnd-hit"
          aria-label={notifications > 0 ? `Notifications, ${notifications} need you` : "Notifications"}
          onClick={onOpenNotifications}
          style={box(inRightGroup(area(AREAS.bell)))}
        />
        {notifications > 0 && (
          <>
            <img className="rnd-sprite" src={assetUrl(SPRITES.bellBadge.file)} alt="" style={box(inRightGroup(SPRITES.bellBadge.rect))} />
            <span
              className="rnd-badge"
              style={{ ...box(inRightGroup(TEXT.bellBadge.rect)), ...fontStyle("badge"), color: reference.colors.badgeText }}
            >
              {notifications}
            </span>
          </>
        )}

        <button
          type="button"
          className="rnd-hit"
          role="switch"
          aria-checked={keepAwake}
          aria-label="Keep this Mac awake while agents are working"
          onClick={onToggleKeepAwake}
          style={box(inRightGroup(area(AREAS.keepAwake)))}
        />
        {keepAwake ? (
          <img className="rnd-sprite" src={assetUrl(SPRITES.toggleOn.file)} alt="" style={box(inRightGroup(SPRITES.toggleOn.rect))} />
        ) : (
          <span className="rnd-toggle-off" aria-hidden style={box(inRightGroup(SPRITES.toggleOn.rect))} />
        )}
      </div>
    </header>
  );
}
