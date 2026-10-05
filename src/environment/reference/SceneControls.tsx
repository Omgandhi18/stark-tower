// Bottom-right camera controls from mockup 04: Focus, zoom −/%/+, fullscreen.
// Panels are the mockup's pixels; their labels are live text.
import { ENVIRONMENT_RECT, assetUrl, reference, rectHeight, rectWidth, relativeTo, type Rect } from "./referenceAssets";
import { textStyle } from "./typography";
import scene from "./rnd-scene.json";

const PANELS = reference.panels;
const ZOOM_OUT = scene.controls.zoomOut as unknown as Rect;
const ZOOM_IN = scene.controls.zoomIn as unknown as Rect;

/** Anchor a mockup-space rect to the environment's bottom-right corner. */
function anchored(rect: Rect) {
  return {
    right: ENVIRONMENT_RECT[2] - rect[2],
    bottom: ENVIRONMENT_RECT[3] - rect[3],
    width: rectWidth(rect),
    height: rectHeight(rect),
  };
}

function hitIn(panel: Rect, area: Rect) {
  const r = relativeTo(area, panel);
  return { left: r[0], top: r[1], width: rectWidth(r), height: rectHeight(r) };
}

interface Props {
  focusName: string;
  zoomPercent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onFocus: () => void;
  onZoom: (direction: 1 | -1) => void;
  onFullscreen: () => void;
}

export default function SceneControls({
  focusName,
  zoomPercent,
  canZoomIn,
  canZoomOut,
  onFocus,
  onZoom,
  onFullscreen,
}: Props) {
  const color = reference.colors.controlText;
  return (
    <>
      <button
        type="button"
        className="rnd-control"
        aria-label={`Focus camera on ${focusName}`}
        onClick={onFocus}
        style={{ ...anchored(PANELS.focusControl.rect), backgroundImage: `url(${assetUrl(PANELS.focusControl.file)})` }}
      >
        <span style={textStyle("controlLabel", relativeTo(reference.text.focusLabel.rect, PANELS.focusControl.rect), color)}>
          Focus: {focusName}
        </span>
      </button>

      <div
        className="rnd-control rnd-control-group"
        style={{ ...anchored(PANELS.zoomControl.rect), backgroundImage: `url(${assetUrl(PANELS.zoomControl.file)})` }}
      >
        <button
          type="button"
          className="rnd-control-hit"
          aria-label="Zoom out"
          disabled={!canZoomOut}
          onClick={() => onZoom(-1)}
          style={hitIn(PANELS.zoomControl.rect, ZOOM_OUT)}
        />
        <span
          aria-live="polite"
          style={textStyle("controlLabel", relativeTo(reference.text.zoomLabel.rect, PANELS.zoomControl.rect), color)}
        >
          {zoomPercent}%
        </span>
        <button
          type="button"
          className="rnd-control-hit"
          aria-label="Zoom in"
          disabled={!canZoomIn}
          onClick={() => onZoom(1)}
          style={hitIn(PANELS.zoomControl.rect, ZOOM_IN)}
        />
      </div>

      <button
        type="button"
        className="rnd-control"
        aria-label="Toggle full screen"
        onClick={onFullscreen}
        style={{
          ...anchored(PANELS.fullscreenControl.rect),
          backgroundImage: `url(${assetUrl(PANELS.fullscreenControl.file)})`,
        }}
      />
    </>
  );
}
