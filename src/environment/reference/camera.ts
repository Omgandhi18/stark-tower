// Camera math for the mockup-plate world. Pure functions, no rendering.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** `cx, cy` is the world point at the viewport centre; `zoom` is screen px per world px. */
export interface Camera {
  zoom: number;
  cx: number;
  cy: number;
}

/** Native-scale multiples offered by the zoom buttons. */
export const ZOOM_STEPS = [1, 1.25, 1.5, 2, 3, 4] as const;
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
/** Zoom used when focusing a single agent. */
export const FOCUS_ZOOM = 2;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The smallest zoom that still covers the viewport — the picture has no edges to show. */
export function fitZoom(view: Size, world: Size): number {
  return Math.max(view.width / world.width, view.height / world.height);
}

export function fitCamera(view: Size, world: Size): Camera {
  return { zoom: fitZoom(view, world), cx: world.width / 2, cy: world.height / 2 };
}

export function clampCamera(cam: Camera, view: Size, world: Size): Camera {
  const zoom = clamp(cam.zoom, fitZoom(view, world), Math.max(MAX_ZOOM, fitZoom(view, world)));
  const halfW = view.width / 2 / zoom;
  const halfH = view.height / 2 / zoom;
  return {
    zoom,
    cx: clamp(cam.cx, halfW, world.width - halfW),
    cy: clamp(cam.cy, halfH, world.height - halfH),
  };
}

export function worldToScreen(p: Point, cam: Camera, view: Size): Point {
  return {
    x: (p.x - cam.cx) * cam.zoom + view.width / 2,
    y: (p.y - cam.cy) * cam.zoom + view.height / 2,
  };
}

export function screenToWorld(p: Point, cam: Camera, view: Size): Point {
  return {
    x: (p.x - view.width / 2) / cam.zoom + cam.cx,
    y: (p.y - view.height / 2) / cam.zoom + cam.cy,
  };
}

/** Zoom to `zoom` while keeping the world point under `anchor` (screen px) fixed. */
export function zoomAt(cam: Camera, anchor: Point, zoom: number, view: Size, world: Size): Camera {
  const focus = screenToWorld(anchor, cam, view);
  return clampCamera(
    {
      zoom,
      cx: focus.x - (anchor.x - view.width / 2) / zoom,
      cy: focus.y - (anchor.y - view.height / 2) / zoom,
    },
    view,
    world,
  );
}

/** Next preset in `direction` (+1 in, -1 out) from the current zoom. */
export function stepZoom(zoom: number, direction: 1 | -1): number {
  const steps = direction > 0 ? ZOOM_STEPS : [...ZOOM_STEPS].reverse();
  const next = steps.find((s) => (direction > 0 ? s > zoom + 1e-3 : s < zoom - 1e-3));
  return next ?? zoom;
}

export function panBy(cam: Camera, dx: number, dy: number, view: Size, world: Size): Camera {
  return clampCamera({ ...cam, cx: cam.cx - dx / cam.zoom, cy: cam.cy - dy / cam.zoom }, view, world);
}
