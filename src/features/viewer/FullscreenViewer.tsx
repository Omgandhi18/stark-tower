import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize, Minimize, X } from "lucide-react";
import { Button, IconButton, registerOverlay } from "../../design";
import { setFullscreen } from "../../lib/fullscreen";
import "./viewer.css";

interface FullscreenViewerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A line under the title (the file's kind and size, say). */
  subtitle?: string;
  /** More controls for the bar (open the file elsewhere). */
  actions?: ReactNode;
  /** What's shown; it fills the window. */
  children: ReactNode;
}

/**
 * Something to look at properly (a mockup, a page an agent made, a document) filling the whole
 * window, with the Mac's own full screen a click away. Escape or Close puts everything back.
 */
export default function FullscreenViewer({ open, onClose, title, subtitle, actions, children }: FullscreenViewerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [macFull, setMacFull] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    // It covers the window: the built-in browser's native view steps aside.
    return open ? registerOverlay(dialog, true) : undefined;
  }, [open]);

  const goFull = (on: boolean) => {
    const dialog = ref.current;
    if (!dialog) return;
    setFullscreen(dialog, on)
      .then(() => setMacFull(on))
      .catch((e) => console.error("[viewer] full screen failed", e));
  };

  // Leaving the viewer takes the window out of the full screen it went into from here.
  const close = () => {
    if (macFull) goFull(false);
    onClose();
  };

  return (
    <dialog
      ref={ref}
      className="viewer"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      {open && (
        <>
          <header className="viewer-bar">
            <div className="viewer-heading">
              <h2 className="viewer-title">{title}</h2>
              {subtitle && <p className="viewer-subtitle">{subtitle}</p>}
            </div>
            <div className="viewer-actions">
              {actions}
              <Button size="sm" variant="ghost" icon={macFull ? Minimize : Maximize} onClick={() => goFull(!macFull)}>
                {macFull ? "Leave full screen" : "Mac full screen"}
              </Button>
              <IconButton icon={X} label="Close" title="Close (Esc)" onClick={close} />
            </div>
          </header>
          <div className="viewer-stage">{children}</div>
        </>
      )}
    </dialog>
  );
}
