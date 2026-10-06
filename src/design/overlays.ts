// Things drawn over the page: menus, popovers, dialogs, pop-ups. A native view laid
// over the window (the built-in browser) is always drawn on top of the page, so it
// steps aside while one of these covers it.
const overlays = new Map<Element, { everywhere: boolean }>();
const listeners = new Set<() => void>();

const changed = () => listeners.forEach((listener) => listener());

/** Note an overlay while it's shown; the returned function takes it away. A modal covers everything. */
export function registerOverlay(el: Element, everywhere = false): () => void {
  overlays.set(el, { everywhere });
  changed();
  return () => {
    overlays.delete(el);
    changed();
  };
}

export function onOverlaysChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether anything drawn over the page overlaps `rect`. */
export function covered(rect: DOMRect): boolean {
  for (const [el, { everywhere }] of overlays) {
    if (!el.isConnected) continue;
    if (everywhere) return true;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) return true;
  }
  return false;
}
