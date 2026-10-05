// After Hours R&D environment built from the approved mockup's own pixels.
// Reference mode reproduces the mockup's state exactly; live mode labels the
// painted characters with the real agents seated at those stations.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import type { Agent } from "../../lib/types";
import { toggleFullscreen } from "../../lib/fullscreen";
import AgentCard, { CARD_SIZE } from "./AgentCard";
import ChatDrawer from "./ChatDrawer";
import SceneControls from "./SceneControls";
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
} from "./camera";
import { CHARACTERS } from "./characterAssets";
import { ENVIRONMENT_RECT, reference, rectHeight, rectWidth, relativeTo } from "./referenceAssets";
import type { SceneState } from "./referenceRenderer";
import { REFERENCE_FIXTURE, liveCard, type CardContent, type DisplayMode } from "./referenceState";
import { SLOTS, assignSlots, type Slot } from "./slots";
import { useReferenceRenderer } from "./useReferenceRenderer";
import "./referenceEnvironment.css";

const WORLD: Size = { width: rectWidth(ENVIRONMENT_RECT), height: rectHeight(ENVIRONMENT_RECT) };
const REFERENCE_SLOT = SLOTS.find((s) => s.id === REFERENCE_FIXTURE.focusSlot) ?? SLOTS[0];
const CARD_WORLD = relativeTo(reference.panels.agentCard.rect, ENVIRONMENT_RECT);
/** The card's offset from the head it labels, as placed in the mockup. */
const CARD_OFFSET = { x: CARD_WORLD[0] - REFERENCE_SLOT.head.x, y: CARD_WORLD[1] - REFERENCE_SLOT.head.y };
const DRAG_THRESHOLD = 3;
/** The station whose character can get up and walk (FRIDAY's build bay). */
const MOBILE_SLOT = "buildBay";
const MOBILE_HEIGHT = CHARACTERS.friday.height;
/** Half-width of the click target around a walking character. */
const WALKER_HALF_WIDTH = 28;
const BUSY: readonly string[] = ["working", "thinking"];
const PINCH_SENSITIVITY = 0.01;
const ZOOM_EPSILON = 1e-3;

interface Props {
  agents: readonly Agent[];
  mode: DisplayMode;
  focusId: string | null;
  /** Select an agent (and make sure their conversation exists). */
  onSelectAgent: (agentId: string) => void;
  /** The conversation stack; the selected agent's thread is the visible one. */
  chat: ReactNode;
}

interface Drag {
  x: number;
  y: number;
  moved: boolean;
}

/** Click target and head of a station's character, following them when they walk. */
function placeOf(slot: Slot, walkerHead: Point | null) {
  if (slot.id === MOBILE_SLOT && walkerHead) {
    const hit = [
      walkerHead.x - WALKER_HALF_WIDTH,
      walkerHead.y,
      walkerHead.x + WALKER_HALF_WIDTH,
      walkerHead.y + MOBILE_HEIGHT,
    ] as const;
    return { hit, head: walkerHead };
  }
  return { hit: slot.hit, head: slot.head };
}

const centerOf = (hit: readonly number[]) => ({ x: (hit[0] + hit[2]) / 2, y: (hit[1] + hit[3]) / 2 });
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

export default function ReferenceEnvironment({ agents, mode, focusId, onSelectAgent, chat }: Props) {
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
  walkerHeadRef.current = walkerHead;
  const viewRef = useRef(view);
  const cameraRef = useRef(camera);
  viewRef.current = view;
  cameraRef.current = camera;

  const seats = useMemo(() => assignSlots(agents), [agents]);
  const mobileAgent = seats.get(MOBILE_SLOT);
  const sceneState = useMemo<SceneState>(
    () => ({
      helpersVisible: mode === "reference",
      // The mockup has everyone in place; live mode seats whoever the roster has.
      occupied: Object.fromEntries(SLOTS.map((s) => [s.id, mode === "reference" || seats.has(s.id)])),
      buildBayTyping: mode === "live" && Boolean(mobileAgent && BUSY.includes(mobileAgent.status)),
    }),
    [mode, seats, mobileAgent],
  );
  const sceneStateRef = useRef(sceneState);
  sceneStateRef.current = sceneState;
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
      setView({ width: entry.contentRect.width, height: entry.contentRect.height });
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
    setCamera((c) =>
      Math.abs(c.zoom - previousFit) < ZOOM_EPSILON ? fitCamera(view, WORLD) : clampCamera(c, view, WORLD),
    );
  }, [view]);

  useEffect(() => {
    rendererRef.current?.setCamera(camera);
  }, [camera]);

  useEffect(() => {
    rendererRef.current?.setState(sceneState);
  }, [sceneState]);

  // The mockup's reference state has everyone where the picture shows them.
  useEffect(() => {
    if (mode === "reference") rendererRef.current?.resetActors();
  }, [mode]);

  const startVisit = useCallback(() => {
    rendererRef.current?.startVisit();
  }, []);

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
    if (!focusedSlot) return;
    setCamera((c) => {
      const home = fitCamera(viewRef.current, WORLD);
      if (c.zoom > home.zoom + ZOOM_EPSILON) return home;
      const center = centerOf(placeOf(focusedSlot, walkerHeadRef.current).hit);
      return clampCamera(
        { zoom: Math.max(FOCUS_ZOOM, home.zoom), cx: center.x, cy: center.y },
        viewRef.current,
        WORLD,
      );
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

  // Which card to show, and over whom.
  let card: { content: CardContent; slot: Slot } | null = null;
  if (mode === "reference") {
    card = { content: REFERENCE_FIXTURE.card, slot: REFERENCE_SLOT };
  } else {
    const slotId = hoverSlotId ?? focusedSlot?.id ?? null;
    const agent = slotId ? seats.get(slotId) : undefined;
    const slot = SLOTS.find((s) => s.id === slotId);
    if (agent && slot) card = { content: liveCard(agent), slot };
  }
  const cardPosition = card
    ? (() => {
        const head = worldToScreen(placeOf(card.slot, walkerHead).head, camera, view);
        return {
          left: clamp(head.x + CARD_OFFSET.x, 0, view.width - CARD_SIZE.width),
          top: clamp(head.y + CARD_OFFSET.y, 0, view.height - CARD_SIZE.height),
        };
      })()
    : null;

  const chatAgent = agents.find((a) => a.id === focusId);
  const focusName =
    mode === "reference"
      ? REFERENCE_FIXTURE.card.name
      : (focusedSlot && seats.get(focusedSlot.id)?.name) ?? "Floor";

  return (
    <div className={`rnd-env${chatOpen ? " chat-open" : ""}`} ref={rootRef}>
      <div className="rnd-env-view">
        <div className="rnd-env-canvas" ref={canvasHostRef} />
        {renderError && (
          <div className="rnd-env-error" role="alert">
            The room couldn't be drawn. {renderError}
          </div>
        )}
        <div
          ref={inputRef}
          className={`rnd-env-input${zoomedIn ? " pannable" : ""}${panning ? " panning" : ""}`}
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
                className="rnd-hotspot"
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

        {card && cardPosition && <AgentCard content={card.content} left={cardPosition.left} top={cardPosition.top} />}

        {import.meta.env.DEV && mode === "live" && mobileAgent && (
          <button type="button" className="rnd-dev-action" onClick={startVisit} title="⌥W">
            Send {mobileAgent.name} to visit · ⌥W
          </button>
        )}

        <SceneControls
          focusName={focusName}
          zoomPercent={Math.round(camera.zoom * 100)}
          canZoomIn={camera.zoom < MAX_ZOOM - ZOOM_EPSILON}
          canZoomOut={zoomedIn}
          onFocus={onFocus}
          onZoom={onZoom}
          onFullscreen={() => {
            if (rootRef.current) toggleFullscreen(rootRef.current).catch(() => {});
          }}
        />
      </div>

      <ChatDrawer
        open={chatOpen}
        title={chatAgent ? `Conversation · ${chatAgent.name}` : "Conversation"}
        onClose={() => setChatOpen(false)}
      >
        {chat}
      </ChatDrawer>
    </div>
  );
}
