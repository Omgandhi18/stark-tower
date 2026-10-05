import { Html, useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Group, Mesh, Object3D } from "three";
import * as THREE from "three";
import dumEUrl from "../assets/3d/after-hours-rnd/agent-dum-e.glb?url";
import edithUrl from "../assets/3d/after-hours-rnd/agent-edith.glb?url";
import fridayUrl from "../assets/3d/after-hours-rnd/agent-friday.glb?url";
import jarvisUrl from "../assets/3d/after-hours-rnd/agent-jarvis.glb?url";
import karenUrl from "../assets/3d/after-hours-rnd/agent-karen.glb?url";
import veronicaUrl from "../assets/3d/after-hours-rnd/agent-veronica.glb?url";
import visionUrl from "../assets/3d/after-hours-rnd/agent-vision.glb?url";
import type { Agent } from "../lib/types";
import { DEFAULT_STATION, STATUS_COLORS, STATUS_LABELS, WORLD_STATIONS } from "./world";

interface ProductionAgentProps {
  agent: Agent;
  selected: boolean;
  onSelect: (id: string) => void;
}

interface RigNodes {
  rigRoot: Object3D | null;
  hips: Object3D | null;
  spine: Object3D | null;
  head: Object3D | null;
  armLeft: Object3D | null;
  armRight: Object3D | null;
  forearmLeft: Object3D | null;
  forearmRight: Object3D | null;
  thighLeft: Object3D | null;
  thighRight: Object3D | null;
  shinLeft: Object3D | null;
  shinRight: Object3D | null;
  body: Object3D | null;
  robotArm: Object3D | null;
  claw: Object3D | null;
}

const AGENT_ASSETS: Record<string, string> = {
  jarvis: jarvisUrl,
  friday: fridayUrl,
  vision: visionUrl,
  edith: edithUrl,
  karen: karenUrl,
  veronica: veronicaUrl,
  "dum-e": dumEUrl,
};

const ENTRY_OFFSETS: Record<string, [number, number, number]> = {
  jarvis: [1.4, 0, 1.15],
  friday: [1.8, 0, 0.45],
  vision: [-1.7, 0, 0.9],
  edith: [-1.8, 0, 0.5],
  karen: [-1.55, 0, -0.8],
  veronica: [1.25, 0, 0.65],
  "dum-e": [-1.2, 0, 0.65],
};

function findRig(scene: Group): RigNodes {
  return {
    rigRoot: scene.getObjectByName("rig_root") ?? null,
    hips: scene.getObjectByName("hips") ?? null,
    spine: scene.getObjectByName("spine") ?? null,
    head: scene.getObjectByName("head_joint") ?? null,
    armLeft: scene.getObjectByName("arm_l") ?? null,
    armRight: scene.getObjectByName("arm_r") ?? null,
    forearmLeft: scene.getObjectByName("forearm_l") ?? null,
    forearmRight: scene.getObjectByName("forearm_r") ?? null,
    thighLeft: scene.getObjectByName("thigh_l") ?? null,
    thighRight: scene.getObjectByName("thigh_r") ?? null,
    shinLeft: scene.getObjectByName("shin_l") ?? null,
    shinRight: scene.getObjectByName("shin_r") ?? null,
    body: scene.getObjectByName("body_joint") ?? null,
    robotArm: scene.getObjectByName("arm_joint") ?? null,
    claw: scene.getObjectByName("claw_joint") ?? null,
  };
}

function dampRotation(node: Object3D | null, x: number, y: number, z: number, delta: number, speed = 12): void {
  if (!node) return;
  node.rotation.x = THREE.MathUtils.damp(node.rotation.x, x, speed, delta);
  node.rotation.y = THREE.MathUtils.damp(node.rotation.y, y, speed, delta);
  node.rotation.z = THREE.MathUtils.damp(node.rotation.z, z, speed, delta);
}

function prepareScene(scene: Group): void {
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const preparedMaterials = sourceMaterials.map((sourceMaterial) => {
      const material = sourceMaterial.clone();
      if (material instanceof THREE.MeshStandardMaterial && material.emissiveIntensity < 1) {
        material.emissive.copy(material.color);
        material.emissiveIntensity = 0.16;
      }
      return material;
    });
    mesh.material = Array.isArray(mesh.material) ? preparedMaterials : preparedMaterials[0];
  });
}

export default function ProductionAgent({ agent, selected, onSelect }: ProductionAgentProps) {
  const source = useGLTF(AGENT_ASSETS[agent.id] ?? jarvisUrl);
  const scene = useMemo(() => source.scene.clone(true), [source.scene]);
  const rig = useMemo(() => findRig(scene), [scene]);
  const rootRef = useRef<Group>(null);
  const ringRef = useRef<Mesh>(null);
  const arrivalStartedAt = useRef<number | null>(null);
  const [hovered, setHovered] = useState(false);
  const [arrived, setArrived] = useState(false);
  const arrivedRef = useRef(false);
  const station = WORLD_STATIONS[agent.id] ?? DEFAULT_STATION;
  const entryOffset = ENTRY_OFFSETS[agent.id] ?? [1.4, 0, 0.8];
  const statusColor = STATUS_COLORS[agent.status];
  const active = agent.status === "working" || agent.status === "thinking";
  const seated = arrived && station.pose === "seated";
  const showLabel = selected || hovered || active || agent.status === "blocked";

  useEffect(() => prepareScene(scene), [scene]);

  useFrame(({ clock }, delta) => {
    if (arrivalStartedAt.current === null) arrivalStartedAt.current = clock.elapsedTime;
    const elapsed = clock.elapsedTime - arrivalStartedAt.current;
    const delay = Math.min(1.1, agent.id.length * 0.09);
    const progress = THREE.MathUtils.smoothstep(elapsed - delay, 0, 1.75);
    const walking = progress < 0.999;
    const time = clock.elapsedTime + agent.id.length * 0.37;

    if (rootRef.current) {
      rootRef.current.position.set(
        station.position[0] + entryOffset[0] * (1 - progress),
        station.position[1] + entryOffset[1] * (1 - progress),
        station.position[2] + entryOffset[2] * (1 - progress),
      );
      const travelRotation = Math.atan2(-entryOffset[0], -entryOffset[2]);
      rootRef.current.rotation.y = THREE.MathUtils.damp(
        rootRef.current.rotation.y,
        THREE.MathUtils.lerp(travelRotation, station.rotationY, progress),
        10,
        delta,
      );
    }

    if (!walking && !arrivedRef.current) {
      arrivedRef.current = true;
      setArrived(true);
    }

    if (ringRef.current) {
      const pulse = selected || active ? 1 + Math.sin(clock.elapsedTime * 3.4) * 0.05 : 1;
      ringRef.current.scale.setScalar(pulse);
    }

    if (agent.id === "dum-e") {
      dampRotation(rig.head, 0, active ? Math.sin(time * 1.45) * 0.38 : 0, 0, delta);
      dampRotation(rig.body, 0, 0, active ? Math.sin(time * 2.1) * 0.035 : 0, delta);
      dampRotation(rig.robotArm, active ? -0.18 + Math.sin(time * 2.5) * 0.16 : 0, 0, -0.22, delta);
      dampRotation(rig.claw, active ? Math.sin(time * 3.2) * 0.2 : 0, 0, 0, delta);
      return;
    }

    const stride = walking ? Math.sin(time * 7.5) * 0.48 : 0;
    const typing = seated && active;
    const standingGesture = !seated && active;
    const seatedThigh = seated ? -1.34 : 0;
    const seatedShin = seated ? 1.34 : 0;
    dampRotation(rig.thighLeft, walking ? stride : seatedThigh, 0, 0, delta);
    dampRotation(rig.thighRight, walking ? -stride : seatedThigh, 0, 0, delta);
    dampRotation(rig.shinLeft, seatedShin, 0, 0, delta);
    dampRotation(rig.shinRight, seatedShin, 0, 0, delta);

    const armSwing = walking ? -stride * 0.82 : 0;
    const leftArmX = typing ? -0.98 + Math.sin(time * 7.8) * 0.055 : standingGesture ? -0.28 + Math.sin(time * 2.1) * 0.1 : armSwing;
    const rightArmX = typing ? -0.98 + Math.cos(time * 8.4) * 0.055 : standingGesture ? -0.36 + Math.cos(time * 1.9) * 0.1 : -armSwing;
    dampRotation(rig.armLeft, leftArmX, 0, seated ? -0.08 : -0.04, delta);
    dampRotation(rig.armRight, rightArmX, 0, seated ? 0.08 : 0.04, delta);
    dampRotation(rig.forearmLeft, typing ? -0.35 : 0, 0, typing ? -0.08 : 0, delta);
    dampRotation(rig.forearmRight, typing ? -0.35 : 0, 0, typing ? 0.08 : 0, delta);

    const headYaw = agent.status === "thinking" ? Math.sin(time * 0.72) * 0.18 : 0;
    const headTilt = agent.status === "blocked" ? Math.sin(time * 2.4) * 0.04 : 0;
    dampRotation(rig.head, 0, headYaw, headTilt, delta, 8);
    dampRotation(rig.spine, seated ? 0.045 : 0, 0, standingGesture ? Math.sin(time * 1.7) * 0.018 : 0, delta, 8);

    if (rig.rigRoot) {
      rig.rigRoot.position.y = THREE.MathUtils.damp(
        rig.rigRoot.position.y,
        walking ? Math.abs(Math.sin(time * 7.5)) * 0.035 : Math.sin(time * 1.7) * 0.008,
        12,
        delta,
      );
    }
  });

  return (
    <>
      <group
        ref={rootRef}
        position={[
          station.position[0] + entryOffset[0],
          station.position[1] + entryOffset[1],
          station.position[2] + entryOffset[2],
        ]}
        rotation={[0, station.rotationY, 0]}
        onClick={(event) => {
          event.stopPropagation();
          onSelect(agent.id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
          document.body.style.cursor = "pointer";
        }}
        onPointerOut={() => {
          setHovered(false);
          document.body.style.cursor = "default";
        }}
      >
        <mesh ref={ringRef} position={[0, 0.025, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <torusGeometry args={[agent.id === "dum-e" ? 0.58 : 0.48, selected ? 0.035 : 0.022, 4, 32]} />
          <meshBasicMaterial color={statusColor} transparent opacity={selected ? 0.95 : 0.62} />
        </mesh>
        <primitive object={scene} scale={agent.id === "dum-e" ? 1 : 1.12} />
      </group>

      {showLabel && (
        <Html position={station.labelPosition} center zIndexRange={[20, 0]}>
          <button
            type="button"
            className={`three-agent-label ${selected ? "selected" : ""}`}
            style={{ "--agent-status": statusColor } as React.CSSProperties}
            onClick={() => onSelect(agent.id)}
          >
            <strong>{agent.name}</strong>
            <span>{STATUS_LABELS[agent.status]}</span>
          </button>
        </Html>
      )}
    </>
  );
}

for (const asset of Object.values(AGENT_ASSETS)) useGLTF.preload(asset);
