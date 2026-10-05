import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text, TextStyle } from "pixi.js";
import { Crosshair, Maximize2, Minus, Plus } from "lucide-react";
import type { Agent, AgentStatus, AssistLink } from "../lib/types";
import {
  AFTER_HOURS_STATIONS,
  createAfterHoursScene,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  type StationAnchor,
} from "../environment/afterHoursScene";
import {
  createPixelCharacter,
  preloadCharacterAtlases,
  type CharacterPose,
  type PixelCharacter,
} from "../environment/characterRig";
import "./PrecisionEnvironment.css";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  assistLinks: AssistLink[];
  onSelect: (id: string) => void;
}

interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

interface AgentVisual {
  container: Container;
  rig: PixelCharacter;
  ring: Graphics;
  label: Container;
  labelFrame: Graphics;
  name: Text;
  state: Text;
  agent: Agent;
  anchor: StationAnchor;
  hovered: boolean;
}

const MIN_ZOOM = 0.82;
const MAX_ZOOM = 1.72;
const ZOOM_STEP = 0.12;

const STATUS_COLORS: Record<AgentStatus, number> = {
  offline: 0x74828d,
  idle: 0x5de7ba,
  thinking: 0x36d7ff,
  working: 0xffbd5b,
  blocked: 0xff5f72,
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  offline: "Offline",
  idle: "Available",
  thinking: "Thinking",
  working: "Running",
  blocked: "Needs you",
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function fallbackStation(index: number): StationAnchor {
  const columns = 4;
  const column = index % columns;
  const row = Math.floor(index / columns);
  return { x: 420 + column * 205, y: 500 + row * 125, pose: "standing", direction: "s" };
}

function resolvedPose(anchor: StationAnchor, status: AgentStatus): CharacterPose {
  const seated = anchor.pose === "seated" || anchor.pose === "working";
  if (seated) return status === "working" || status === "thinking" ? "working" : "seated";
  return status === "thinking" ? "thinking" : "standing";
}

function drawAgentState(visual: AgentVisual, selected: boolean, time: number) {
  const { agent, ring, label, labelFrame } = visual;
  const color = STATUS_COLORS[agent.status];
  const active = agent.status === "working" || agent.status === "thinking";
  const pulse = active ? 0.64 + Math.sin(time * 3.6) * 0.2 : 0.5;
  const robot = agent.id === "dum-e";

  ring.clear();
  ring
    .ellipse(0, 0, robot ? 30 : 25, robot ? 9 : 7)
    .fill({ color, alpha: selected ? 0.18 : active ? 0.11 : 0.05 })
    .stroke({ width: selected ? 2.5 : 1.5, color, alpha: selected ? 0.98 : pulse });
  if (selected) {
    ring
      .ellipse(0, 0, robot ? 37 : 32, robot ? 12 : 10)
      .stroke({ width: 1, color, alpha: 0.42 });
  }

  label.visible = selected || visual.hovered || agent.status === "blocked" || active;
  if (!label.visible) return;

  labelFrame.clear();
  labelFrame
    .roundRect(0, 0, 148, 47, 8)
    .fill({ color: 0x071019, alpha: 0.93 })
    .stroke({ width: 1, color, alpha: selected ? 0.95 : 0.58 });
  labelFrame.rect(0, 0, 3, 47).fill({ color, alpha: 0.95 });
}

export default function PrecisionEnvironment({ agents, selectedId, assistLinks, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const peopleLayerRef = useRef<Container | null>(null);
  const linkLayerRef = useRef<Graphics | null>(null);
  const sceneTickRef = useRef<(time: number) => void>(() => {});
  const visualsRef = useRef<Map<string, AgentVisual>>(new Map());
  const selectedRef = useRef(selectedId);
  const linksRef = useRef(assistLinks);
  const cameraRef = useRef<Camera>({ zoom: 1, panX: 0, panY: 0 });
  const [ready, setReady] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);

  selectedRef.current = selectedId;
  linksRef.current = assistLinks;
  const applyCameraRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let removeInteractionListeners: (() => void) | undefined;
    const host = hostRef.current;
    if (!host) return;

    const app = new Application();
    const pointer = { dragging: false, x: 0, y: 0 };

    void app.init({
      background: 0x03090e,
      resizeTo: host,
      antialias: false,
      autoDensity: true,
      resolution: Math.min(2, window.devicePixelRatio || 1),
      preference: "webgl",
    }).then(async () => {
      if (disposed) {
        app.destroy(true);
        return;
      }

      appRef.current = app;
      app.canvas.className = "precision-environment-canvas";
      host.appendChild(app.canvas);

      const [scene] = await Promise.all([
        createAfterHoursScene(),
        preloadCharacterAtlases(),
      ]);
      if (disposed) return;
      const world = scene.container;
      app.stage.addChild(world);
      worldRef.current = world;
      peopleLayerRef.current = scene.peopleLayer;
      sceneTickRef.current = scene.tick;

      const links = new Graphics();
      links.eventMode = "none";
      links.zIndex = -1;
      scene.peopleLayer.addChild(links);
      linkLayerRef.current = links;

      const applyCamera = () => {
        const currentWorld = worldRef.current;
        if (!currentWorld || !appRef.current) return;
        const screen = appRef.current.screen;
        const fit = Math.max(screen.width / WORLD_WIDTH, screen.height / WORLD_HEIGHT);
        const scale = fit * cameraRef.current.zoom;
        currentWorld.scale.set(scale);
        const baseX = (screen.width - WORLD_WIDTH * scale) / 2;
        const baseY = (screen.height - WORLD_HEIGHT * scale) / 2;
        const minimumX = Math.min(0, screen.width - WORLD_WIDTH * scale);
        const minimumY = Math.min(0, screen.height - WORLD_HEIGHT * scale);
        currentWorld.x = clamp(baseX + cameraRef.current.panX, minimumX, 0);
        currentWorld.y = clamp(baseY + cameraRef.current.panY, minimumY, 0);
        cameraRef.current.panX = currentWorld.x - baseX;
        cameraRef.current.panY = currentWorld.y - baseY;
      };
      applyCameraRef.current = applyCamera;
      applyCamera();
      app.renderer.on("resize", applyCamera);

      const canvas = app.canvas;
      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        pointer.dragging = true;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add("is-dragging");
      };
      const onPointerMove = (event: PointerEvent) => {
        if (!pointer.dragging) return;
        cameraRef.current.panX += event.clientX - pointer.x;
        cameraRef.current.panY += event.clientY - pointer.y;
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        applyCamera();
      };
      const onPointerUp = (event: PointerEvent) => {
        pointer.dragging = false;
        if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        canvas.classList.remove("is-dragging");
      };
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const bounds = canvas.getBoundingClientRect();
        const cursorX = event.clientX - bounds.left;
        const cursorY = event.clientY - bounds.top;
        const oldScale = world.scale.x;
        const worldX = (cursorX - world.x) / oldScale;
        const worldY = (cursorY - world.y) / oldScale;
        const nextZoom = clamp(cameraRef.current.zoom * (event.deltaY > 0 ? 0.92 : 1.08), MIN_ZOOM, MAX_ZOOM);
        cameraRef.current.zoom = nextZoom;
        const fit = Math.max(app.screen.width / WORLD_WIDTH, app.screen.height / WORLD_HEIGHT);
        const nextScale = fit * nextZoom;
        const baseX = (app.screen.width - WORLD_WIDTH * nextScale) / 2;
        const baseY = (app.screen.height - WORLD_HEIGHT * nextScale) / 2;
        cameraRef.current.panX = cursorX - worldX * nextScale - baseX;
        cameraRef.current.panY = cursorY - worldY * nextScale - baseY;
        setZoomPercent(Math.round(nextZoom * 100));
        applyCamera();
      };

      canvas.addEventListener("pointerdown", onPointerDown);
      canvas.addEventListener("pointermove", onPointerMove);
      canvas.addEventListener("pointerup", onPointerUp);
      canvas.addEventListener("pointercancel", onPointerUp);
      canvas.addEventListener("wheel", onWheel, { passive: false });

      app.ticker.add(() => {
        const time = performance.now() / 1000;
        sceneTickRef.current(time);
        const byId = visualsRef.current;
        byId.forEach((visual) => {
          visual.rig.tick(time);
          drawAgentState(visual, visual.agent.id === selectedRef.current, time);
        });

        const linkLayer = linkLayerRef.current;
        if (!linkLayer) return;
        linkLayer.clear();
        for (const link of linksRef.current) {
          const from = byId.get(link.from);
          const to = byId.get(link.to);
          if (!from || !to) continue;
          const alpha = 0.3 + Math.sin(time * 5 + link.id) * 0.13;
          linkLayer
            .moveTo(from.container.x, from.container.y - 58)
            .bezierCurveTo(
              from.container.x,
              from.container.y - 132,
              to.container.x,
              to.container.y - 132,
              to.container.x,
              to.container.y - 58,
            )
            .stroke({ width: 2, color: 0x35d8ff, alpha });
        }
      });

      setReady(true);
      removeInteractionListeners = () => {
        canvas.removeEventListener("pointerdown", onPointerDown);
        canvas.removeEventListener("pointermove", onPointerMove);
        canvas.removeEventListener("pointerup", onPointerUp);
        canvas.removeEventListener("pointercancel", onPointerUp);
        canvas.removeEventListener("wheel", onWheel);
        app.renderer.off("resize", applyCamera);
      };
    });

    return () => {
      disposed = true;
      removeInteractionListeners?.();
      setReady(false);
      visualsRef.current.clear();
      if (appRef.current) {
        appRef.current.destroy(true, { children: true });
        appRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const layer = peopleLayerRef.current;
    if (!ready || !layer) return;

    const visuals = visualsRef.current;
    const liveIds = new Set(agents.map((agent) => agent.id));

    agents.forEach((agent, index) => {
      const anchor = AFTER_HOURS_STATIONS[agent.id] ?? fallbackStation(index);
      let visual = visuals.get(agent.id);

      if (!visual) {
        const container = new Container();
        container.position.set(anchor.x, anchor.y);
        container.zIndex = anchor.y;
        container.eventMode = "static";
        container.cursor = "pointer";

        const ring = new Graphics();
        ring.zIndex = 0;
        container.addChild(ring);

        const rig = createPixelCharacter(
          agent.id,
          resolvedPose(anchor, agent.status),
          anchor.direction,
        );
        rig.container.zIndex = 1;
        container.addChild(rig.container);

        const labelNode = new Container();
        const defaultLabelOffset = { x: 31, y: agent.id === "dum-e" ? -91 : -126 };
        const labelOffset = anchor.labelOffset ?? defaultLabelOffset;
        labelNode.position.set(labelOffset.x, labelOffset.y);
        labelNode.zIndex = 2;
        labelNode.eventMode = "none";
        const labelFrame = new Graphics();
        labelNode.addChild(labelFrame);

        const name = new Text({
          text: agent.name,
          style: new TextStyle({
            fontFamily: "Avenir Next, Helvetica Neue, sans-serif",
            fontSize: 13,
            fontWeight: "600",
            fill: 0xf3f8fc,
            letterSpacing: 0.4,
          }),
        });
        name.position.set(14, 8);
        labelNode.addChild(name);

        const state = new Text({
          text: STATUS_LABELS[agent.status],
          style: new TextStyle({
            fontFamily: "JetBrains Mono, SFMono-Regular, monospace",
            fontSize: 10,
            fill: STATUS_COLORS[agent.status],
          }),
        });
        state.position.set(14, 27);
        labelNode.addChild(state);
        container.addChild(labelNode);

        visual = { container, rig, ring, label: labelNode, labelFrame, name, state, agent, anchor, hovered: false };
        visuals.set(agent.id, visual);
        layer.addChild(container);

        container.on("pointertap", (event) => {
          event.stopPropagation();
          onSelect(agent.id);
        });
        container.on("pointerover", () => {
          const current = visuals.get(agent.id);
          if (current) current.hovered = true;
        });
        container.on("pointerout", () => {
          const current = visuals.get(agent.id);
          if (current) current.hovered = false;
        });
      }

      visual.agent = agent;
      visual.anchor = anchor;
      visual.container.position.set(anchor.x, anchor.y);
      visual.container.zIndex = anchor.y;
      const defaultLabelOffset = { x: 31, y: agent.id === "dum-e" ? -91 : -126 };
      const labelOffset = anchor.labelOffset ?? defaultLabelOffset;
      visual.label.position.set(labelOffset.x, labelOffset.y);
      visual.rig.setPose(resolvedPose(anchor, agent.status));
      visual.rig.setDirection(anchor.direction);
      visual.rig.setStatus(agent.status);
      visual.name.text = agent.name;
      visual.state.text = STATUS_LABELS[agent.status];
      visual.state.style.fill = STATUS_COLORS[agent.status];
    });

    for (const [id, visual] of visuals) {
      if (liveIds.has(id)) continue;
      visual.container.destroy({ children: true });
      visuals.delete(id);
    }
  }, [agents, onSelect, ready]);

  const changeZoom = (delta: number) => {
    cameraRef.current.zoom = clamp(cameraRef.current.zoom + delta, MIN_ZOOM, MAX_ZOOM);
    setZoomPercent(Math.round(cameraRef.current.zoom * 100));
    applyCameraRef.current();
  };

  const resetCamera = () => {
    cameraRef.current = { zoom: 1, panX: 0, panY: 0 };
    setZoomPercent(100);
    applyCameraRef.current();
  };

  const focusSelected = () => {
    const id = selectedId ?? agents.find((agent) => agent.status === "working")?.id ?? "jarvis";
    const station = AFTER_HOURS_STATIONS[id];
    const app = appRef.current;
    if (!station || !app) return;

    const fit = Math.max(app.screen.width / WORLD_WIDTH, app.screen.height / WORLD_HEIGHT);
    cameraRef.current.zoom = Math.max(1.12, cameraRef.current.zoom);
    const scale = fit * cameraRef.current.zoom;
    const baseX = (app.screen.width - WORLD_WIDTH * scale) / 2;
    const baseY = (app.screen.height - WORLD_HEIGHT * scale) / 2;
    cameraRef.current.panX = app.screen.width * 0.52 - station.x * scale - baseX;
    cameraRef.current.panY = app.screen.height * 0.54 - station.y * scale - baseY;
    setZoomPercent(Math.round(cameraRef.current.zoom * 100));
    applyCameraRef.current();
  };

  const selectedAgent = agents.find((agent) => agent.id === selectedId);

  return (
    <section className="precision-environment" aria-label="After Hours R&D environment">
      <div ref={hostRef} className="precision-environment-stage" />
      <div className="environment-vignette" aria-hidden="true" />

      <div className="environment-heading">
        <span className="environment-kicker">Environment 01</span>
        <strong>After Hours R&amp;D</strong>
        <span>Live scene graph · rain protocol</span>
      </div>

      <div className="environment-controls" aria-label="Environment camera controls">
        <button type="button" onClick={focusSelected}>
          <Crosshair size={15} />
          Focus: {selectedAgent?.name ?? "active work"}
        </button>
        <span className="environment-control-separator" />
        <button type="button" aria-label="Zoom out" onClick={() => changeZoom(-ZOOM_STEP)}>
          <Minus size={15} />
        </button>
        <span className="environment-zoom-readout">{zoomPercent}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => changeZoom(ZOOM_STEP)}>
          <Plus size={15} />
        </button>
        <button type="button" aria-label="Fit environment" onClick={resetCamera}>
          <Maximize2 size={15} />
        </button>
      </div>

      {!ready && (
        <div className="environment-loading" role="status">
          <span />
          Rendering the live floor
        </div>
      )}
    </section>
  );
}
