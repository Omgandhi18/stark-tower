// Peeking at a collapsed side panel: resting the pointer on its rail floats the whole panel out
// over the screen, and it tucks away again once the pointer has gone.
import { useCallback, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { onOverlaysChanged, registerOverlay } from "./overlays";

/** Resting this long on a rail brings the panel out, so passing over it on the way elsewhere doesn't. */
const OPEN_DELAY_MS = 240;
/** Gone this long, it goes away: slipping off its edge for a moment doesn't close it. */
const CLOSE_DELAY_MS = 320;
/** A menu, popover or dialog opened from the panel keeps it out until it closes (their triggers name what they opened). */
const HELD_BY = '[aria-expanded="true"][aria-controls], dialog[open]';
/** Marks the rail control keyboard focus goes back to when the panel is put away. */
export const RAIL_HOME = "data-rail-home";

/**
 * A collapsed panel's peek. Spread `handlers` on the element holding its rail and the panel, give
 * that element `ref`, and the floating panel `panelRef` (with tabIndex -1, so the keyboard can land in it).
 */
export function usePeek<C extends HTMLElement = HTMLDivElement, P extends HTMLElement = HTMLDivElement>(enabled: boolean) {
  const ref = useRef<C>(null);
  const panelRef = useRef<P>(null);
  const [peeking, setPeeking] = useState(false);
  const inside = useRef(false);
  /** Brought out from the keyboard: focus inside holds it out, as the pointer does. */
  const viaKeys = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const clear = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
  };
  const close = useCallback(() => {
    clear();
    viaKeys.current = false;
    setPeeking(false);
  }, []);
  // Put away unless something still holds it out: the pointer, a menu or dialog from it, or keyboard focus.
  const settle = useCallback(() => {
    const el = ref.current;
    if (inside.current || !el || el.querySelector(HELD_BY)) return;
    if (viaKeys.current && el.contains(document.activeElement)) return;
    close();
  }, [close]);

  // Collapsing or expanding the panel starts it put away.
  const [wasEnabled, setWasEnabled] = useState(enabled);
  if (enabled !== wasEnabled) {
    setWasEnabled(enabled);
    setPeeking(false);
  }
  useEffect(() => {
    if (!enabled) {
      clear();
      viaKeys.current = false;
    }
  }, [enabled]);
  useEffect(() => clear, []);
  useEffect(() => (peeking ? onOverlaysChanged(settle) : undefined), [peeking, settle]);
  // Out over the page it's an overlay: the built-in browser steps aside if it would cover it.
  useEffect(() => {
    const panel = panelRef.current ?? ref.current;
    if (!peeking || !panel) return;
    if (viaKeys.current) panel.focus();
    return registerOverlay(panel);
  }, [peeking]);

  /** Bring it out now (a rail button asking for it); from the keyboard, focus moves into it. */
  const open = (fromKeyboard = false) => {
    clear();
    viaKeys.current = fromKeyboard;
    if (peeking && fromKeyboard) (panelRef.current ?? ref.current)?.focus();
    setPeeking(true);
  };

  const handlers = {
    onPointerEnter: () => {
      inside.current = true;
      viaKeys.current = false;
      if (!enabled) return;
      clear();
      if (!peeking) timer.current = window.setTimeout(() => setPeeking(true), OPEN_DELAY_MS);
    },
    onPointerLeave: () => {
      inside.current = false;
      if (!enabled) return;
      clear();
      timer.current = window.setTimeout(settle, CLOSE_DELAY_MS);
    },
    onKeyDown: (e: KeyboardEvent) => {
      const el = ref.current;
      if (e.key !== "Escape" || !peeking || !el || el.querySelector(HELD_BY)) return;
      e.stopPropagation();
      const hadFocus = el.contains(document.activeElement);
      close();
      if (hadFocus) el.querySelector<HTMLElement>(`[${RAIL_HOME}]`)?.focus();
    },
    onBlur: (e: FocusEvent) => {
      if (!viaKeys.current || ref.current?.contains(e.relatedTarget as Node | null)) return;
      viaKeys.current = false;
      settle();
    },
  };

  return { ref, panelRef, peeking, open, close, handlers };
}
