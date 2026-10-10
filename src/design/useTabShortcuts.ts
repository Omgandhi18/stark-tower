import { useEffect, useRef, type RefObject } from "react";

/** What ⌘T and ⌘W do for a tool panel that holds tabs. */
interface TabPanel {
  ref: RefObject<HTMLElement | null>;
  newTab: () => void;
  closeTab: () => void;
  /** Focus is somewhere the page can't see (a native view laid over the panel). */
  hasNativeFocus?: () => boolean;
}

export type TabShortcut = "new" | "close";

const panels = new Set<TabPanel>();

/** A key the page handled itself just now; the menu item for the same key is then not run a second time. */
const KEY_DEDUPE_MS = 250;
let handledAt = 0;

const act = (panel: TabPanel, shortcut: TabShortcut) => (shortcut === "new" ? panel.newTab() : panel.closeTab());

const focused = (panel: TabPanel) => Boolean(panel.ref.current?.contains(document.activeElement)) || Boolean(panel.hasNativeFocus?.());

/**
 * ⌘T and ⌘W as the app menu sends them: the tab strip panel with focus takes the shortcut.
 * Returns whether one did; if not, the caller does what the key does anywhere else (⌘W closes the window).
 */
export function runTabShortcut(shortcut: TabShortcut, now = Date.now()): boolean {
  if (now - handledAt < KEY_DEDUPE_MS) return true;
  const panel = [...panels].find(focused);
  if (!panel) return false;
  act(panel, shortcut);
  return true;
}

/**
 * ⌘T opens a tab and ⌘W closes the one showing, while focus is inside `ref` (a tool's panel):
 * anywhere else the keys keep their other jobs. The app menu owns the keys (a menu shortcut is
 * decided before the page sees a key, or after, depending on the view), so the menu's choice
 * reaches the panel through `runTabShortcut`; a key that reaches the page first is handled here,
 * once. `hasNativeFocus` says focus is in a native view over the panel, which has no DOM focus.
 */
export function useTabShortcuts(ref: RefObject<HTMLElement | null>, onNew: () => void, onClose: () => void, hasNativeFocus?: () => boolean) {
  // The newest callbacks, read when a shortcut runs.
  const latest = useRef<TabPanel>({ ref, newTab: onNew, closeTab: onClose, hasNativeFocus });
  useEffect(() => {
    latest.current = { ref, newTab: onNew, closeTab: onClose, hasNativeFocus };
  });

  useEffect(() => {
    const panel: TabPanel = {
      ref,
      newTab: () => latest.current.newTab(),
      closeTab: () => latest.current.closeTab(),
      hasNativeFocus: () => latest.current.hasNativeFocus?.() ?? false,
    };
    panels.add(panel);
    return () => void panels.delete(panel);
  }, [ref]);

  // Re-attached each render: the panel may not be on screen yet when this first runs.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Captured, so a terminal sees the keys after we do, not before.
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const shortcut: TabShortcut | null = e.code === "KeyT" ? "new" : e.code === "KeyW" ? "close" : null;
      if (!shortcut) return;
      e.preventDefault();
      e.stopPropagation();
      handledAt = Date.now();
      (shortcut === "new" ? latest.current.newTab : latest.current.closeTab)();
    };
    el.addEventListener("keydown", onKey, true);
    return () => el.removeEventListener("keydown", onKey, true);
  });
}
