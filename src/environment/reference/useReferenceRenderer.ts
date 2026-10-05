// Owns the single Pixi renderer behind the reference environment.
//
// React StrictMode (dev) and Fast Refresh unmount and immediately re-mount
// effects. Creating a second WebGL app for that — and destroying the first —
// corrupts the survivor in WebKit (the app's real engine on macOS), so the
// teardown is deferred one task and cancelled when the effect comes straight back.
import { useEffect, useRef, useState, type RefObject } from "react";
import type { Point, Size } from "./camera";
import { createReferenceRenderer, type ReferenceRenderer } from "./referenceRenderer";

interface Callbacks {
  onActorMove: (slotId: string, head: Point | null) => void;
  /** Called once the renderer exists, to push the current view, camera and state into it. */
  onReady: (renderer: ReferenceRenderer) => void;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export function useReferenceRenderer(hostRef: RefObject<HTMLDivElement | null>, fallbackView: Size, callbacks: Callbacks) {
  const rendererRef = useRef<ReferenceRenderer | null>(null);
  const pendingRef = useRef<Promise<ReferenceRenderer> | null>(null);
  const teardownRef = useRef<number | null>(null);
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (teardownRef.current !== null) {
      window.clearTimeout(teardownRef.current);
      teardownRef.current = null;
    }
    const host = hostRef.current;
    if (host && !pendingRef.current) {
      const bounds = host.getBoundingClientRect();
      const initial = { width: bounds.width || fallbackView.width, height: bounds.height || fallbackView.height };
      const pending = createReferenceRenderer(host, initial, (slot, head) => callbacksRef.current.onActorMove(slot, head));
      pendingRef.current = pending;
      pending
        .then((renderer) => {
          if (pendingRef.current !== pending) return;
          rendererRef.current = renderer;
          callbacksRef.current.onReady(renderer);
        })
        .catch((cause: unknown) => {
          if (pendingRef.current !== pending) return;
          pendingRef.current = null;
          console.error("[environment] renderer failed", cause);
          setError(describe(cause));
        });
    }
    return () => {
      teardownRef.current = window.setTimeout(() => {
        teardownRef.current = null;
        const pending = pendingRef.current;
        pendingRef.current = null;
        rendererRef.current = null;
        pending?.then((renderer) => renderer.destroy()).catch(() => {});
      }, 0);
    };
  }, [hostRef, fallbackView]);

  return { rendererRef, error };
}
