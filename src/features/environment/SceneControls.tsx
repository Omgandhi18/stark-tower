import { Crosshair, Maximize, Minus, Plus, Scan } from "lucide-react";
import { Button, IconButton } from "../../design";

interface SceneControlsProps {
  /** Who Focus frames; null when nobody is selected. */
  focusName: string | null;
  zoomedIn: boolean;
  zoomPercent: number;
  canZoomIn: boolean;
  onFocus: () => void;
  onZoom: (direction: 1 | -1) => void;
  onFullscreen: () => void;
}

/** Camera controls in the room's bottom-right corner. */
export default function SceneControls({ focusName, zoomedIn, zoomPercent, canZoomIn, onFocus, onZoom, onFullscreen }: SceneControlsProps) {
  return (
    <div className="scene-controls" role="toolbar" aria-label="Camera">
      {zoomedIn ? (
        <Button size="sm" variant="ghost" icon={Scan} onClick={onFocus}>
          Whole floor
        </Button>
      ) : (
        <Button size="sm" variant="ghost" icon={Crosshair} disabled={!focusName} onClick={onFocus}>
          {focusName ? `Focus ${focusName}` : "Focus"}
        </Button>
      )}
      <span className="scene-controls-divider" aria-hidden />
      <IconButton icon={Minus} label="Zoom out" size="sm" disabled={!zoomedIn} onClick={() => onZoom(-1)} />
      <span className="scene-zoom tabular" aria-live="polite" aria-label={`Zoom ${zoomPercent} percent`}>
        {zoomPercent}%
      </span>
      <IconButton icon={Plus} label="Zoom in" size="sm" disabled={!canZoomIn} onClick={() => onZoom(1)} />
      <span className="scene-controls-divider" aria-hidden />
      <IconButton icon={Maximize} label="Full screen" size="sm" onClick={onFullscreen} />
    </div>
  );
}
