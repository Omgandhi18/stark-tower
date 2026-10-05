import { MapControls, Line } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Bloom, EffectComposer, SSAO } from "@react-three/postprocessing";
import { Crosshair, Maximize2, Minus, Plus } from "lucide-react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { MapControls as MapControlsImpl } from "three-stdlib";
import type { Agent, AssistLink } from "../lib/types";
import ProductionAgent from "../environment3d/ProductionAgent";
import ProductionTower from "../environment3d/ProductionTower";
import { WORLD_STATIONS } from "../environment3d/world";
import "./PrecisionEnvironment.css";
import "./ThreeEnvironment.css";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  assistLinks: AssistLink[];
  onSelect: (id: string) => void;
}

interface CameraApi {
  focus: (target: THREE.Vector3) => void;
  zoomBy: (delta: number) => void;
  reset: () => void;
}

const DEFAULT_CAMERA_POSITION = new THREE.Vector3(13, 11, 16);
const DEFAULT_CAMERA_TARGET = new THREE.Vector3(0, 1.25, 0);
const DEFAULT_ZOOM = 62;
const MIN_ZOOM = 42;
const MAX_ZOOM = 96;
const ZOOM_STEP = 6;

function CameraController({
  apiRef,
  onZoomChange,
}: {
  apiRef: React.MutableRefObject<CameraApi | null>;
  onZoomChange: (zoom: number) => void;
}) {
  const { camera, gl } = useThree();
  const controlsRef = useRef<MapControlsImpl>(null);

  useEffect(() => {
    const orthographic = camera as THREE.OrthographicCamera;
    const update = () => {
      orthographic.updateProjectionMatrix();
      controlsRef.current?.update();
      onZoomChange(Math.round((orthographic.zoom / DEFAULT_ZOOM) * 100));
    };

    apiRef.current = {
      focus: (target) => {
        const offset = DEFAULT_CAMERA_POSITION.clone().sub(DEFAULT_CAMERA_TARGET);
        camera.position.copy(target.clone().add(offset.multiplyScalar(0.72)));
        controlsRef.current?.target.copy(target);
        orthographic.zoom = Math.min(MAX_ZOOM, DEFAULT_ZOOM * 1.2);
        update();
      },
      zoomBy: (delta) => {
        orthographic.zoom = THREE.MathUtils.clamp(orthographic.zoom + delta, MIN_ZOOM, MAX_ZOOM);
        update();
      },
      reset: () => {
        camera.position.copy(DEFAULT_CAMERA_POSITION);
        controlsRef.current?.target.copy(DEFAULT_CAMERA_TARGET);
        orthographic.zoom = DEFAULT_ZOOM;
        update();
      },
    };
    update();
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, camera, onZoomChange]);

  return (
    <MapControls
      ref={controlsRef}
      camera={camera}
      domElement={gl.domElement}
      makeDefault
      target={DEFAULT_CAMERA_TARGET}
      enableRotate={false}
      enableDamping
      dampingFactor={0.08}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      screenSpacePanning={false}
      zoomToCursor
      onChange={() => {
        const orthographic = camera as THREE.OrthographicCamera;
        onZoomChange(Math.round((orthographic.zoom / DEFAULT_ZOOM) * 100));
      }}
    />
  );
}

function AssistLinks3D({ links }: { links: AssistLink[] }) {
  const paths = useMemo(() => links.flatMap((link) => {
    const from = WORLD_STATIONS[link.from];
    const to = WORLD_STATIONS[link.to];
    if (!from || !to) return [];
    const start = new THREE.Vector3(...from.position).add(new THREE.Vector3(0, 1.65, 0));
    const end = new THREE.Vector3(...to.position).add(new THREE.Vector3(0, 1.65, 0));
    const middle = start.clone().lerp(end, 0.5);
    middle.y += 1.5;
    const curve = new THREE.QuadraticBezierCurve3(start, middle, end);
    return [{ id: link.id, points: curve.getPoints(32) }];
  }), [links]);

  return paths.map((path) => (
    <Line
      key={path.id}
      points={path.points}
      color="#35dcff"
      lineWidth={1.6}
      transparent
      opacity={0.72}
      dashed
      dashSize={0.18}
      gapSize={0.11}
    />
  ));
}

function PixelTowerScene({ agents, selectedId, assistLinks, onSelect, cameraApi, onZoomChange }: Props & {
  cameraApi: React.MutableRefObject<CameraApi | null>;
  onZoomChange: (zoom: number) => void;
}) {
  return (
    <>
      <color attach="background" args={["#061018"]} />
      <fog attach="fog" args={["#061018", 20, 39]} />
      <ambientLight intensity={1.02} color="#b7e3ee" />
      <hemisphereLight intensity={1.08} color="#8be2f5" groundColor="#14242b" />
      <directionalLight
        position={[7, 15, 10]}
        intensity={3.25}
        color="#d7f4ff"
        castShadow
        shadow-mapSize-width={1536}
        shadow-mapSize-height={1536}
        shadow-camera-near={1}
        shadow-camera-far={38}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
      />
      <pointLight position={[-5, 5, -3]} color="#ffad4f" intensity={8} distance={11} decay={2} />
      <pointLight position={[5, 4, 2]} color="#2edbff" intensity={7} distance={12} decay={2} />
      <pointLight position={[-4.2, 3.3, 2.2]} color="#36d9e9" intensity={4} distance={7} decay={2} />
      <pointLight position={[0, 5.8, -3]} color="#35dcff" intensity={5} distance={8} decay={2} />

      <ProductionTower />
      <AssistLinks3D links={assistLinks} />
      {agents.map((agent) => (
        <ProductionAgent
          key={agent.id}
          agent={agent}
          selected={agent.id === selectedId}
          onSelect={onSelect}
        />
      ))}

      <CameraController apiRef={cameraApi} onZoomChange={onZoomChange} />
      <EffectComposer multisampling={0} enableNormalPass>
        <SSAO
          samples={12}
          rings={3}
          radius={7}
          intensity={1.2}
          luminanceInfluence={0.68}
          resolutionScale={0.5}
        />
        <Bloom luminanceThreshold={0.78} luminanceSmoothing={0.16} intensity={0.42} mipmapBlur />
      </EffectComposer>
    </>
  );
}

export default function ThreeEnvironment({ agents, selectedId, assistLinks, onSelect }: Props) {
  const cameraApi = useRef<CameraApi | null>(null);
  const [ready, setReady] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const selectedAgent = agents.find((agent) => agent.id === selectedId);

  const focusSelected = () => {
    const id = selectedId ?? agents.find((agent) => agent.status === "working")?.id ?? "jarvis";
    const station = WORLD_STATIONS[id];
    if (!station) return;
    cameraApi.current?.focus(new THREE.Vector3(...station.position).add(new THREE.Vector3(0, 0.9, 0)));
  };

  return (
    <section className="precision-environment three-environment" aria-label="After Hours R&D 3D environment">
      <Canvas
        className="three-environment-canvas"
        orthographic
        camera={{
          position: DEFAULT_CAMERA_POSITION.toArray(),
          zoom: DEFAULT_ZOOM,
          near: -60,
          far: 100,
        }}
        dpr={[1, 1.25]}
        shadows
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        onCreated={({ gl }) => {
          gl.shadowMap.type = THREE.PCFSoftShadowMap;
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.34;
          setReady(true);
        }}
      >
        <Suspense fallback={null}>
          <PixelTowerScene
            agents={agents}
            selectedId={selectedId}
            assistLinks={assistLinks}
            onSelect={onSelect}
            cameraApi={cameraApi}
            onZoomChange={setZoomPercent}
          />
        </Suspense>
      </Canvas>

      <div className="environment-vignette three-vignette" aria-hidden="true" />
      <div className="environment-heading">
        <span className="environment-kicker">Environment 01 · 3D runtime</span>
        <strong>After Hours R&amp;D</strong>
        <span>Orthographic scene graph · live agents</span>
      </div>

      <div className="environment-controls" aria-label="Environment camera controls">
        <button type="button" onClick={focusSelected}>
          <Crosshair size={15} />
          Focus: {selectedAgent?.name ?? "active work"}
        </button>
        <span className="environment-control-separator" />
        <button type="button" aria-label="Zoom out" onClick={() => cameraApi.current?.zoomBy(-ZOOM_STEP)}>
          <Minus size={15} />
        </button>
        <span className="environment-zoom-readout">{zoomPercent}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => cameraApi.current?.zoomBy(ZOOM_STEP)}>
          <Plus size={15} />
        </button>
        <button type="button" aria-label="Fit environment" onClick={() => cameraApi.current?.reset()}>
          <Maximize2 size={15} />
        </button>
      </div>

      {!ready && (
        <div className="environment-loading" role="status">
          <span />
          Building the 3D tower
        </div>
      )}
    </section>
  );
}
