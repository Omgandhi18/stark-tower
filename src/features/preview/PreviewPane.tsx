import { useRef, type PointerEvent } from "react";
import { X } from "lucide-react";
import { IconButton, Tabs, type TabItem } from "../../design";
import { useNavigation } from "../../stores/navigation";
import { MIN_WIDTH, usePreview, type PreviewTab } from "../../stores/preview";
import BrowserView from "./BrowserView";
import SimulatorView from "./SimulatorView";
import "./preview.css";

const TABS: readonly TabItem<PreviewTab>[] = [
  { id: "browser", label: "Browser" },
  { id: "simulator", label: "Simulator" },
];

/** Most of the window the preview may take; the chat keeps the rest. */
const MAX_SHARE = 0.7;

/** Beside the chat: the built-in browser and the iOS Simulator, which you and the agents share. */
export default function PreviewPane() {
  const tab = usePreview((s) => s.tab);
  const width = usePreview((s) => s.width);
  const setTab = usePreview((s) => s.setTab);
  const setWidth = usePreview((s) => s.setWidth);
  const close = usePreview((s) => s.close);
  const onScreen = useNavigation((s) => s.route === "conversation");
  const drag = useRef<{ x: number; width: number } | null>(null);

  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { x: e.clientX, width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const resize = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const wanted = drag.current.width + (drag.current.x - e.clientX);
    setWidth(Math.max(MIN_WIDTH, Math.min(wanted, window.innerWidth * MAX_SHARE)));
  };

  return (
    <aside className="preview-pane" style={{ width }} aria-label="Preview">
      <div
        className="preview-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the preview"
        onPointerDown={startResize}
        onPointerMove={resize}
        onPointerUp={() => (drag.current = null)}
      />
      <div className="preview-head">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Preview" idPrefix="preview" className="preview-tabs" />
        <IconButton icon={X} label="Close the preview" size="sm" onClick={close} />
      </div>
      <div role="tabpanel" id={`preview-panel-${tab}`} aria-labelledby={`preview-tab-${tab}`} className="preview-body">
        {tab === "browser" ? <BrowserView active={onScreen} /> : <SimulatorView active={onScreen} />}
      </div>
    </aside>
  );
}
