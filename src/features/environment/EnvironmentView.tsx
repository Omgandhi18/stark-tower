// The After Hours R&D room: the approved mockup's own pixels in a Pixi canvas,
// with real UI on top (who is where, camera controls, the conversation panel).
// Reference mode reproduces the mockup's state exactly, for fidelity checks.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Button, cx } from "../../design";
import { toggleFullscreen } from "../../lib/fullscreen";
import type { Agent } from "../../lib/types";
import {
  FOCUS_ZOOM,
  MAX_ZOOM,
  clampCamera,
  fitCamera,
  fitZoom,
  panBy,
  stepZoom,
  worldToScreen,
  zoomAt,
  type Camera,
  type Point,
  type Size,
} from "../../environment/reference/camera";
import { CHARACTERS } from "../../environment/reference/characterAssets";
import { ENVIRONMENT_RECT, reference, rectHeight, rectWidth, relativeTo } from "../../environment/reference/referenceAssets";
import type { SceneState, StationLight } from "../../environment/reference/referenceRenderer";
import { SLOTS, assignSlots, type Slot } from "../../environment/reference/slots";
import { lightFor } from "../../environment/reference/stationLights";
import { useReferenceRenderer } from "../../environment/reference/useReferenceRenderer";
import EnvironmentDrawer from "./EnvironmentDrawer";
import SceneAgentCard, { SCENE_CARD_HEIGHT, SCENE_CARD_WIDTH } from "./SceneAgentCard";
import SceneControls from "./SceneControls";
import "./environment.css";

/** "reference" renders exactly the mockup's state; "live" follows real agents. */
export type DisplayMode = "live" | "reference";

const WORLD: Size = { width: rectWidth(ENVIRONMENT_RECT), height: rectHeight(ENVIRONMENT_RECT) };
/** The station the mockup frames (FRIDAY's build bay); also the one whose character can walk. */
const MOBILE_SLOT = "buildBay";
const REFERENCE_SLOT = SLOTS.find((s) => s.id === MOBILE_SLOT) ?? SLOTS[0];
const CARD_WORLD = relativeTo(reference.panels.agentCard.rect, ENVIRONMENT_RECT);
/** Where the mockup places the status card relative to the head it labels. */
const CARD_OFFSET = { x: CARD_WORLD[0] - REFERENCE_SLOT.head.x, y: CARD_WORLD[1] - REFERENCE_SLOT.head.y };
const DRAG_THRESHOLD = 3;
const MOBILE_HEIGHT = CHARACTERS.friday.height;
/** Half-width of the click target around a walking character. */
const WALKER_HALF_WIDTH = 28;
const BUSY: readonly string[] = ["working", "thinking"];
/** Every painted helper, and the "+1" badge: the mockup's state. */
const REFERENCE_HELPERS = 4;
const PINCH_SENSITIVITY = 0.01;
const ZOOM_EPSILON = 1e-3;
const PERCENT = 100;

interface EnvironmentViewProps {
  agents: readonly Agent[];
  /** Temporary helpers each agent has running. */
  helpers: Readonly<Record<string, number>>;
  /** Agents with a question, approval or review waiting on the developer. */
  waitingOnYou: ReadonlySet<string>;
  mode: DisplayMode;
  focusId: string | null;
  /** Select an agent (and open their conversation thread). */
  onSelectAgent: (agentId: string) => void;
  /** A line about the room itself, shown over it. */
  notice?: ReactNode;
}

interface Drag {
  x: number;
  y: number;
  moved: boolean;
}

/** Click target and head of a station's character, following them when they walk. */
function placeOf(slot: Slot, walkerHead: Point | null) {
  if (slot.id === MOBILE_SLOT && walkerHead) {
    const hit = [walkerHead.x - WALKER_HALF_WIDTH, walkerHead.y, walkerHead.x + WALKER_HALF_WIDTH, walkerHead.y + MOBILE_HEIGHT] as const;
    return { hit, head: walkerHead };
  }
  return { hit: slot.hit, head: slot.head };
}

const centerOf = (hit: readonly number[]) => ({ x: (hit[0] + hit[2]) / 2, y: (hit[1] + hit[3]) / 2 });
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export default function EnvironmentView({ agents, helpers, waitingOnYou, mode, focusId, onSelectAgent, notice }: EnvironmentViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [view, setView] = useState<Size>(WORLD);
  const [camera, setCamera] = useState<Camera>(() => fitCamera(WORLD, WORLD));
  const [hoverSlotId, setHoverSlotId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  /** Head of the build-bay character while away from the seat (world px). */
  const [walkerHead, setWalkerHead] = useState<Point | null>(null);
  const walkerHeadRef = useRef(walkerHead);
  const viewRef = useRef(view);
  const cameraRef = useRef(camera);
  useEffect(() => {
    walkerHeadRef.current = walkerHead;
    viewRef.current = view;
    cameraRef.current = camera;
  });

  const seats = useMemo(() => assignSlots(agents), [agents]);
  const mobileAgent = seats.get(MOBILE_SLOT);
  const sceneState = useMemo<SceneState>(() => {
    // The mockup's own state: everyone in place, every helper out, nothing lit beyond what it paints.
    if (mode === "reference") {
      return { helpers: REFERENCE_HELPERS, occupied: Object.fromEntries(SLOTS.map((s) => [s.id, true])), buildBayTyping: false, lights: {} };
    }
    const lights: Record<string, StationLight> = {};
    for (const [slotId, agent] of seats) {
      const light = lightFor(agent, waitingOnYou.has(agent.id));
      if (light) lights[slotId] = light;
    }
    return {
      helpers: mobileAgent ? (helpers[mobileAgent.id] ?? 0) : 0,
      occupied: Object.fromEntries(SLOTS.map((s) => [s.id, seats.has(s.id)])),
      buildBayTyping: Boolean(mobileAgent && BUSY.includes(mobileAgent.status)),
      lights,
    };
  }, [mode, seats, mobileAgent, helpers, waitingOnYou]);
  const sceneStateRef = useRef(sceneState);
  useEffect(() => {
    sceneStateRef.current = sceneState;
  });
  const focusedSlot = useMemo(() => {
    if (mode === "reference") return REFERENCE_SLOT;
    const entry = [...seats].find(([, agent]) => agent.id === focusId);
    return SLOTS.find((s) => s.id === entry?.[0]) ?? null;
  }, [mode, seats, focusId]);

  const { rendererRef, error: renderError } = useReferenceRenderer(canvasHostRef, WORLD, {
    onActorMove: (_slot, head) => setWalkerHead(head),
    onReady: (renderer) => {
      renderer.resize(viewRef.current);
      renderer.setCamera(cameraRef.current);
      renderer.setState(sceneStateRef.current);
    },
  });

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // A hidden screen reports no size; keep the last real one.
      if (width > 0 && height > 0) setView({ width, height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Stay on the whole-floor view across resizes unless the user has zoomed in.
  const lastViewRef = useRef(view);
  useEffect(() => {
    rendererRef.current?.resize(view);
    const previousFit = fitZoom(lastViewRef.current, WORLD);
    lastViewRef.current = view;
    setCamera((c) => (Math.abs(c.zoom - previousFit) < ZOOM_EPSILON ? fitCamera(view, WORLD) : clampCamera(c, view, WORLD)));
  }, [view, rendererRef]);

  useEffect(() => {
    rendererRef.current?.setCamera(camera);
  }, [camera, rendererRef]);

  useEffect(() => {
    rendererRef.current?.setState(sceneState);
  }, [sceneState, rendererRef]);

  // The mockup's reference state has everyone where the picture shows them.
  useEffect(() => {
    if (mode === "reference") rendererRef.current?.resetActors();
  }, [mode, rendererRef]);

  const startVisit = useCallback(() => {
    rendererRef.current?.startVisit();
  }, [rendererRef]);

  // Dev builds: ⌥W sends the build-bay character to visit a colleague and back.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyW") return;
      e.preventDefault();
      startVisit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startVisit]);

  // While the conversation panel narrows the scene, keep its agent in view.
  useEffect(() => {
    if (!chatOpen || !focusedSlot) return;
    const center = centerOf(placeOf(focusedSlot, walkerHeadRef.current).hit);
    setCamera((c) => clampCamera({ ...c, cx: center.x, cy: center.y }, view, WORLD));
  }, [chatOpen, focusedSlot, view]);

  useEffect(() => {
    if (!chatOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest("textarea, input, select");
      if (e.key === "Escape" && !typing) setChatOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [chatOpen]);

  // Trackpad pinch arrives as ctrl+wheel; it must not zoom the whole page.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const bounds = input.getBoundingClientRect();
      const anchor = { x: e.clientX - bounds.left, y: e.clientY - bounds.top };
      setCamera((c) =>
        e.ctrlKey
          ? zoomAt(c, anchor, c.zoom * Math.exp(-e.deltaY * PINCH_SENSITIVITY), viewRef.current, WORLD)
          : panBy(c, -e.deltaX, -e.deltaY, viewRef.current, WORLD),
      );
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    return () => input.removeEventListener("wheel", onWheel);
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button === 0) dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!drag.moved) {
      drag.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      setPanning(true);
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    setCamera((c) => panBy(c, dx, dy, viewRef.current, WORLD));
  };

  const endDrag = () => {
    setPanning(false);
    // Let the click that follows a drag see `moved`, then forget it.
    window.setTimeout(() => {
      dragRef.current = null;
    });
  };

  const fit = fitCamera(view, WORLD);
  const zoomedIn = camera.zoom > fit.zoom + ZOOM_EPSILON;

  const onFocus = useCallback(() => {
    setCamera((c) => {
      const home = fitCamera(viewRef.current, WORLD);
      if (c.zoom > home.zoom + ZOOM_EPSILON || !focusedSlot) return home;
      const center = centerOf(placeOf(focusedSlot, walkerHeadRef.current).hit);
      return clampCamera({ zoom: Math.max(FOCUS_ZOOM, home.zoom), cx: center.x, cy: center.y }, viewRef.current, WORLD);
    });
  }, [focusedSlot]);

  const onZoom = useCallback((direction: 1 | -1) => {
    setCamera((c) => {
      const v = viewRef.current;
      const preset = stepZoom(c.zoom, direction);
      // Below the smallest preset, zooming out goes to the whole-floor view.
      const next = direction < 0 && preset >= c.zoom ? fitZoom(v, WORLD) : preset;
      return zoomAt(c, { x: v.width / 2, y: v.height / 2 }, next, v, WORLD);
    });
  }, []);

  // The card labels whoever is hovered, else whoever is selected.
  const cardSlot = SLOTS.find((s) => s.id === (hoverSlotId ?? focusedSlot?.id ?? null));
  const cardAgent = cardSlot ? seats.get(cardSlot.id) : undefined;
  const cardPosition =
    cardSlot && cardAgent
      ? (() => {
          const head = worldToScreen(placeOf(cardSlot, walkerHead).head, camera, view);
          return {
            left: clamp(head.x + CARD_OFFSET.x, 0, view.width - SCENE_CARD_WIDTH),
            top: clamp(head.y + CARD_OFFSET.y, 0, view.height - SCENE_CARD_HEIGHT),
          };
        })()
      : null;

  const focusName = (focusedSlot && seats.get(focusedSlot.id)?.name) ?? null;

  return (
    <div className={cx("env", chatOpen && "chat-open")} ref={rootRef}>
      <div className="env-view">
        <div className="env-canvas" ref={canvasHostRef} />
        {renderError && (
          <div className="env-error" role="alert">
            The room couldn't be drawn. {renderError}
          </div>
        )}
        <div
          ref={inputRef}
          className={cx("env-input", zoomedIn && "pannable", panning && "panning")}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {SLOTS.map((slot) => {
            const agent = seats.get(slot.id);
            if (!agent) return null;
            const { hit } = placeOf(slot, walkerHead);
            const a = worldToScreen({ x: hit[0], y: hit[1] }, camera, view);
            const b = worldToScreen({ x: hit[2], y: hit[3] }, camera, view);
            return (
              <button
                key={slot.id}
                type="button"
                className="env-hotspot"
                aria-label={`Talk to ${agent.name}, ${agent.role}`}
                style={{ left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y }}
                onPointerEnter={() => setHoverSlotId(slot.id)}
                onPointerLeave={() => setHoverSlotId((id) => (id === slot.id ? null : id))}
                onFocus={() => setHoverSlotId(slot.id)}
                onBlur={() => setHoverSlotId((id) => (id === slot.id ? null : id))}
                onClick={() => {
                  if (dragRef.current?.moved) return;
                  onSelectAgent(agent.id);
                  setChatOpen(true);
                }}
              />
            );
          })}
        </div>

        {cardAgent && cardPosition && <SceneAgentCard agent={cardAgent} left={cardPosition.left} top={cardPosition.top} />}

        {notice && mode === "live" && (
          <p className="env-notice" role="note">
            {notice}
          </p>
        )}

        {import.meta.env.DEV && mode === "live" && mobileAgent && (
          <Button className="env-dev-action" size="sm" variant="secondary" onClick={startVisit} title="⌥W">
            Send {mobileAgent.name} on a visit
          </Button>
        )}

        <SceneControls
          focusName={focusName}
          zoomedIn={zoomedIn}
          zoomPercent={Math.round(camera.zoom * PERCENT)}
          canZoomIn={camera.zoom < MAX_ZOOM - ZOOM_EPSILON}
          onFocus={onFocus}
          onZoom={onZoom}
          onFullscreen={() => {
            if (rootRef.current) toggleFullscreen(rootRef.current).catch((e) => console.error("[environment] full screen failed", e));
          }}
        />
      </div>

      <EnvironmentDrawer open={chatOpen} agentId={focusId} onClose={() => setChatOpen(false)} />
    </div>
  );
}
