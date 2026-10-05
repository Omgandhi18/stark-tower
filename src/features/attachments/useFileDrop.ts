// Files dropped on an element. In the app, macOS hands Tauri the files' paths with
// where they were dropped; in a browser preview, the drop carries the files themselves.
import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { IS_MAC, IS_TAURI } from "../../lib/platform";

interface DropHandlers {
  onPaths: (paths: string[]) => void;
  onFiles: (files: File[]) => void;
}

/**
 * How many of Tauri's drop-position units make a CSS pixel. Tauri labels the position
 * physical, but on macOS it passes AppKit's points through unscaled (wry's
 * `draggingLocation`), which already are CSS pixels; elsewhere it is physical.
 */
const dropUnitsPerPixel = () => (IS_MAC ? 1 : window.devicePixelRatio);

/** Whether a drop position, as Tauri reports it, is over a visible `element`. */
function over(element: HTMLElement | null, position: { x: number; y: number }): boolean {
  // A screen kept alive in the background is inert, and must not take the drop.
  if (!element || element.closest("[inert]")) return false;
  const x = position.x / dropUnitsPerPixel();
  const y = position.y / dropUnitsPerPixel();
  const box = element.getBoundingClientRect();
  return box.width > 0 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** Drop files on `target`: returns whether files are being dragged over it, and the props for it. */
export function useFileDrop(target: RefObject<HTMLElement | null>, handlers: DropHandlers, enabled = true) {
  const [dragging, setDragging] = useState(false);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!IS_TAURI || !enabled) return;
    let unlisten: (() => void) | undefined;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent(({ payload }) => {
        if (payload.type === "leave") {
          setDragging(false);
          return;
        }
        const here = over(target.current, payload.position);
        if (payload.type === "drop") {
          setDragging(false);
          if (here && payload.paths.length) handlersRef.current.onPaths(payload.paths);
        } else {
          setDragging(here);
        }
      })
      .then((off) => {
        if (gone) off();
        else unlisten = off;
      })
      .catch((e) => console.error("[attachments] couldn't listen for dropped files", e));
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [enabled, target]);

  const dropProps = enabled
    ? {
        onDragOver: (e: DragEvent) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          if (!carriesFiles(e)) return;
          e.preventDefault();
          setDragging(false);
          handlersRef.current.onFiles(Array.from(e.dataTransfer.files));
        },
      }
    : {};

  return { dragging, dropProps };
}
