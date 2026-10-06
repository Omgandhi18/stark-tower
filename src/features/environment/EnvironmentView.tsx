// A theme's room: its approved mockup's own pixels in a Pixi canvas, with real
// UI on top (who is where, camera controls, the conversation panel). Reference
// mode reproduces the mockup's state exactly, for fidelity checks.
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { Button, cx } from "../../design";
import { toggleFullscreen } from "../../lib/fullscreen";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent, Task } from "../../lib/types";
import type { CastMember } from "../../environment/life/director";
import type { Activity } from "../../environment/life/types";
import { lifeEvents, type TaskMark } from "../../environment/life/events";
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
import type { SceneState, StationLight } from "../../environment/reference/referenceRenderer";
import { cardPlacement, helpersShown, layoutOf, type RoomLayout } from "../../environment/reference/roomLayout";
import type { Room } from "../../environment/reference/rooms";
import { assignSlots, type Slot } from "../../environment/reference/slots";
import { lightFor } from "../../environment/reference/stationLights";
import { useReferenceRenderer } from "../../environment/reference/useReferenceRenderer";
import EnvironmentDrawer from "./EnvironmentDrawer";
import RoomHeader from "./RoomHeader";
import { RoomCaption, RoomClock } from "./RoomOverlays";
import SceneAgentCard, { SCENE_CARD_HEIGHT, SCENE_CARD_WIDTH } from "./SceneAgentCard";
import SceneControls from "./SceneControls";
import SceneNameTags, { type NameTagPlace } from "./SceneNameTags";
import TodayBoard, { type BoardCounts } from "./TodayBoard";
import "./environment.css";

/** "reference" renders exactly the mockup's state; "live" follows real agents. */
export type DisplayMode = "live" | "reference";

const DRAG_THRESHOLD = 3;
/** Half-width of the click target around a walking character. */
const WALKER_HALF_WIDTH = 28;
const CARD_SIZE: Size = { width: SCENE_CARD_WIDTH, height: SCENE_CARD_HEIGHT };
const PINCH_SENSITIVITY = 0.01;
const ZOOM_EPSILON = 1e-3;
const PERCENT = 100;

interface EnvironmentViewProps {
  /** Fixed for the view's life: key the view by room to change it. */
  room: Room;
  agents: readonly Agent[];
  /** Temporary helpers each agent has running. */
  helpers: Readonly<Record<string, number>>;
  /** Agents with a question, approval or review waiting on the developer. */
  waitingOnYou: ReadonlySet<string>;
  /** Task cards: hand-overs between agents and finished work send people across the room. */
  tasks: readonly Task[];
  /** Questions, approvals and reviews waiting on the developer, all told. */
  awaitingYou: number;
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

/** Click target and head of a station's character, following them when they're up and about. */
function placeOf(slot: Slot, heads: Readonly<Record<string, Point>>, layout: RoomLayout) {
  const head = heads[slot.id];
  const height = layout.heights[slot.id];
  if (head && height) {
    const hit = [head.x - WALKER_HALF_WIDTH, head.y, head.x + WALKER_HALF_WIDTH, head.y + height] as const;
    return { hit, head };
  }
  return { hit: slot.hit, head: slot.head };
}

/** What the room shows an agent doing: waiting on you outranks working, as the station light does. */
function activityOf(agent: Agent, waiting: boolean): Activity {
  if (waiting || agent.status === "blocked") return "waiting";
  return agent.status;
}

const centerOf = (hit: readonly number[]) => ({ x: (hit[0] + hit[2]) / 2, y: (hit[1] + hit[3]) / 2 });

export default function EnvironmentView({ room, agents, helpers, waitingOnYou, tasks, awaitingYou, mode, focusId, onSelectAgent, notice }: EnvironmentViewProps) {
  const layout = useMemo(() => layoutOf(room), [room]);
  const { frame, board, tags } = room.scene;
  const tagPlaces = useMemo<NameTagPlace[]>(
    () => Object.entries(tags ?? {}).map(([slotId, at]) => ({ slotId, at: { x: at[0] - room.rect[0], y: at[1] - room.rect[1] } })),
    [tags, room.rect],
  );
  const { world, slots } = layout;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const [view, setView] = useState<Size>(world);
  const [camera, setCamera] = useState<Camera>(() => fitCamera(world, world));
  const worldRef = useRef(world);
  const [hoverSlotId, setHoverSlotId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  /** Heads of everyone up and about, away from their station (world px). */
  const [heads, setHeads] = useState<Readonly<Record<string, Point>>>({});
  const headsRef = useRef(heads);
  const viewRef = useRef(view);
  const cameraRef = useRef(camera);
  useEffect(() => {
    headsRef.current = heads;
    viewRef.current = view;
    cameraRef.current = camera;
    worldRef.current = world;
  });

  const seats = useMemo(() => assignSlots(agents, slots, layout.orchestratorSlot), [agents, slots, layout.orchestratorSlot]);
  const sceneState = useMemo<SceneState>(() => {
    // The mockup's own state: everyone in place and still, every helper out, nothing lit beyond what it paints.
    if (mode === "reference") {
      return { helpers: layout.referenceHelpers, occupied: Object.fromEntries(slots.map((s) => [s.id, !s.added])), lights: {}, cast: [] };
    }
    const lights: Record<string, StationLight> = {};
    const cast: CastMember[] = [];
    for (const [slotId, agent] of seats) {
      const waiting = waitingOnYou.has(agent.id);
      const light = lightFor(agent, waiting);
      if (light) lights[slotId] = light;
      cast.push({ slotId, agentId: agent.id, activity: activityOf(agent, waiting) });
    }
    return {
      helpers: helpersShown(layout.helperSlot, seats, helpers),
      occupied: Object.fromEntries(slots.map((s) => [s.id, seats.has(s.id)])),
      lights,
      cast,
    };
  }, [mode, seats, helpers, waitingOnYou, layout, slots]);
  const sceneStateRef = useRef(sceneState);
  useEffect(() => {
    sceneStateRef.current = sceneState;
  });
  const boardCounts = useMemo<BoardCounts | null>(() => {
    if (!board) return null;
    if (mode === "reference") {
      const [running, awaitingReview, blocked] = board.reference;
      return { running, awaitingReview, blocked };
    }
    return {
      running: agents.filter((a) => AGENT_STATUS[a.status].busy).length,
      awaitingReview: awaitingYou,
      blocked: agents.filter((a) => a.status === "blocked").length,
    };
  }, [board, mode, agents, awaitingYou]);
  const focusedSlot = useMemo(() => {
    if (mode === "reference") return layout.referenceSlot;
    const entry = [...seats].find(([, agent]) => agent.id === focusId);
    return slots.find((s) => s.id === entry?.[0]) ?? null;
  }, [mode, seats, focusId, layout, slots]);

  const { rendererRef, error: renderError } = useReferenceRenderer(canvasHostRef, world, room, {
    onActorMove: (slotId, head) =>
      setHeads((current) => {
        if (head) return { ...current, [slotId]: head };
        if (!(slotId in current)) return current;
        const rest = { ...current };
        delete rest[slotId];
        return rest;
      }),
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
    const previousFit = fitZoom(lastViewRef.current, world);
    lastViewRef.current = view;
    setCamera((c) => (Math.abs(c.zoom - previousFit) < ZOOM_EPSILON ? fitCamera(view, world) : clampCamera(c, view, world)));
  }, [view, rendererRef, world]);

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

  // Hand-overs between agents, report-backs and finished work: each sends someone across the room.
  const marksRef = useRef<ReadonlyMap<string, TaskMark> | null>(null);
  useEffect(() => {
    const { events, marks } = lifeEvents(marksRef.current, tasks, agents);
    marksRef.current = marks;
    if (events.length && mode === "live") rendererRef.current?.push(events);
  }, [tasks, agents, mode, rendererRef]);

  const liven = useCallback(() => {
    rendererRef.current?.liven();
  }, [rendererRef]);

  // Dev builds: ⌥W sends someone idle off on a pastime right away.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyW") return;
      e.preventDefault();
      liven();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [liven]);

  // While the conversation panel narrows the scene, keep its agent in view.
  useEffect(() => {
    if (!chatOpen || !focusedSlot) return;
    const center = centerOf(placeOf(focusedSlot, headsRef.current, layout).hit);
    setCamera((c) => clampCamera({ ...c, cx: center.x, cy: center.y }, view, world));
  }, [chatOpen, focusedSlot, view, layout, world]);

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
          ? zoomAt(c, anchor, c.zoom * Math.exp(-e.deltaY * PINCH_SENSITIVITY), viewRef.current, worldRef.current)
          : panBy(c, -e.deltaX, -e.deltaY, viewRef.current, worldRef.current),
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
    setCamera((c) => panBy(c, dx, dy, viewRef.current, worldRef.current));
  };

  const endDrag = () => {
    setPanning(false);
    // Let the click that follows a drag see `moved`, then forget it.
    window.setTimeout(() => {
      dragRef.current = null;
    });
  };

  const fit = fitCamera(view, world);
  const zoomedIn = camera.zoom > fit.zoom + ZOOM_EPSILON;

  const onFocus = useCallback(() => {
    setCamera((c) => {
      const home = fitCamera(viewRef.current, world);
      if (c.zoom > home.zoom + ZOOM_EPSILON || !focusedSlot) return home;
      const center = centerOf(placeOf(focusedSlot, headsRef.current, layout).hit);
      return clampCamera({ zoom: Math.max(FOCUS_ZOOM, home.zoom), cx: center.x, cy: center.y }, viewRef.current, world);
    });
  }, [focusedSlot, layout, world]);

  const onZoom = useCallback(
    (direction: 1 | -1) => {
      setCamera((c) => {
        const v = viewRef.current;
        const preset = stepZoom(c.zoom, direction);
        // Below the smallest preset, zooming out goes to the whole-floor view.
        const next = direction < 0 && preset >= c.zoom ? fitZoom(v, world) : preset;
        return zoomAt(c, { x: v.width / 2, y: v.height / 2 }, next, v, world);
      });
    },
    [world],
  );

  // The card labels whoever is hovered, else whoever is selected.
  const cardSlot = slots.find((s) => s.id === (hoverSlotId ?? focusedSlot?.id ?? null));
  const cardAgent = cardSlot ? seats.get(cardSlot.id) : undefined;
  const cardStyle =
    cardSlot && cardAgent ? cardPlacement(layout.card, worldToScreen(placeOf(cardSlot, heads, layout).head, camera, view), view, CARD_SIZE) : null;

  const focusName = (focusedSlot && seats.get(focusedSlot.id)?.name) ?? null;

  return (
    <div className={cx("env", chatOpen && "chat-open")} ref={rootRef}>
      {frame?.header && <RoomHeader room={room} motto={frame.header.motto} />}
      <div className="env-stage">
        <div className="env-view">
          <div className="env-canvas" ref={canvasHostRef} />
          {board && boardCounts && <TodayBoard board={board} roomRect={room.rect} counts={boardCounts} camera={camera} view={view} />}
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
            {slots.map((slot) => {
              const agent = seats.get(slot.id);
              if (!agent) return null;
              const { hit } = placeOf(slot, heads, layout);
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

          <SceneNameTags places={tagPlaces} seats={seats} away={heads} waitingOnYou={waitingOnYou} camera={camera} view={view} />

          {cardAgent && cardStyle && <SceneAgentCard agent={cardAgent} placement={cardStyle} docked={layout.card.anchor !== "head"} />}

          {frame?.clock && <RoomClock place={frame.clock.place} />}
          {frame?.caption && <RoomCaption caption={frame.caption} />}

          {notice && mode === "live" && (
            <p className="env-notice" role="note">
              {notice}
            </p>
          )}

          {import.meta.env.DEV && mode === "live" && (
            <Button className="env-dev-action" size="sm" variant="secondary" onClick={liven} title="⌥W">
              Send someone on a break
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
    </div>
  );
}
