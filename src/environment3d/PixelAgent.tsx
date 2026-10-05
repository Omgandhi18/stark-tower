import { Html, RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, useState } from "react";
import type { Group, Mesh } from "three";
import * as THREE from "three";
import type { Agent } from "../lib/types";
import {
  DEFAULT_STATION,
  STATUS_COLORS,
  STATUS_LABELS,
  WORLD_STATIONS,
} from "./world";

interface PixelAgentProps {
  agent: Agent;
  selected: boolean;
  onSelect: (id: string) => void;
}

interface CharacterPalette {
  skin: string;
  hair: string;
  uniform: string;
  accent: string;
}

const CHARACTER_PALETTES: Record<string, CharacterPalette> = {
  jarvis: { skin: "#a96545", hair: "#17191c", uniform: "#172a33", accent: "#35dcff" },
  friday: { skin: "#a96145", hair: "#111419", uniform: "#152b32", accent: "#36d9e9" },
  vision: { skin: "#7d4a35", hair: "#201815", uniform: "#2b2731", accent: "#ef65c3" },
  edith: { skin: "#a8684a", hair: "#8c3f27", uniform: "#183128", accent: "#5de7ba" },
  karen: { skin: "#a66b51", hair: "#40271f", uniform: "#292936", accent: "#b88cff" },
  veronica: { skin: "#633823", hair: "#171215", uniform: "#2d2a28", accent: "#ffad55" },
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

function Block({
  position,
  rotation = [0, 0, 0],
  size,
  color,
  emissive,
}: {
  position: [number, number, number];
  rotation?: [number, number, number];
  size: [number, number, number];
  color: string;
  emissive?: string;
}) {
  return (
    <RoundedBox
      position={position}
      rotation={rotation}
      args={size}
      radius={Math.min(...size) * 0.16}
      smoothness={1}
      castShadow
      receiveShadow
    >
      <meshStandardMaterial
        color={color}
        emissive={emissive ?? "#000000"}
        emissiveIntensity={emissive ? 1.5 : 0}
        roughness={0.72}
        metalness={0.12}
      />
    </RoundedBox>
  );
}

function Hair({ id, color }: { id: string; color: string }) {
  if (id === "vision") return null;

  if (id === "veronica") {
    return (
      <group position={[0, 1.72, -0.12]}>
        {[-0.22, -0.12, -0.02, 0.08, 0.18].map((x, index) => (
          <mesh key={x} position={[x, -0.23 - (index % 2) * 0.04, -0.12]} castShadow>
            <cylinderGeometry args={[0.035, 0.045, 0.62, 5]} />
            <meshStandardMaterial color={color} roughness={0.9} />
          </mesh>
        ))}
      </group>
    );
  }

  const longHair = id === "friday";
  return (
    <group position={[0, 1.83, -0.05]}>
      <mesh castShadow>
        <sphereGeometry args={[0.29, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.72]} />
        <meshStandardMaterial color={color} roughness={0.9} />
      </mesh>
      {longHair && (
        <mesh position={[0, -0.24, -0.22]} castShadow>
          <sphereGeometry args={[0.18, 7, 5]} />
          <meshStandardMaterial color={color} roughness={0.9} />
        </mesh>
      )}
    </group>
  );
}

function DumE({ active }: { active: boolean }) {
  const headRef = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!headRef.current) return;
    headRef.current.rotation.y = active ? Math.sin(clock.elapsedTime * 1.6) * 0.38 : 0;
  });

  return (
    <group>
      <Block position={[0, 0.5, 0]} size={[0.72, 0.58, 0.5]} color="#788690" />
      <Block position={[-0.24, 0.15, 0]} size={[0.2, 0.3, 0.24]} color="#46525a" />
      <Block position={[0.24, 0.15, 0]} size={[0.2, 0.3, 0.24]} color="#46525a" />
      <group ref={headRef} position={[0, 0.96, 0]}>
        <Block position={[0, 0, 0]} size={[0.5, 0.36, 0.42]} color="#28343b" />
        <mesh position={[0, 0, 0.23]}>
          <circleGeometry args={[0.11, 10]} />
          <meshStandardMaterial color="#55e5ff" emissive="#35dcff" emissiveIntensity={2.8} />
        </mesh>
      </group>
    </group>
  );
}

function Human({ agent, seated, walking }: { agent: Agent; seated: boolean; walking: boolean }) {
  const bodyRef = useRef<Group>(null);
  const headRef = useRef<Group>(null);
  const leftArmRef = useRef<Group>(null);
  const rightArmRef = useRef<Group>(null);
  const leftLegRef = useRef<Group>(null);
  const rightLegRef = useRef<Group>(null);
  const palette = CHARACTER_PALETTES[agent.id] ?? CHARACTER_PALETTES.jarvis;
  const active = agent.status === "working" || agent.status === "thinking";

  useFrame(({ clock }) => {
    const time = clock.elapsedTime + agent.id.length * 0.37;
    if (bodyRef.current) bodyRef.current.position.y = Math.sin(time * 1.7) * 0.012;
    if (headRef.current) {
      headRef.current.rotation.y = agent.status === "thinking" ? Math.sin(time * 0.72) * 0.16 : 0;
      headRef.current.rotation.z = agent.status === "blocked" ? Math.sin(time * 2.4) * 0.025 : 0;
    }
    if (leftArmRef.current && rightArmRef.current) {
      const typing = seated && active;
      leftArmRef.current.rotation.x = typing ? -0.88 + Math.sin(time * 8) * 0.07 : 0;
      rightArmRef.current.rotation.x = typing ? -0.88 + Math.cos(time * 8.7) * 0.07 : 0;
      if (!seated && active) {
        leftArmRef.current.rotation.x = -0.22 + Math.sin(time * 2.2) * 0.12;
        rightArmRef.current.rotation.x = -0.32 + Math.cos(time * 2.0) * 0.12;
      }
      if (walking) {
        leftArmRef.current.rotation.x = Math.sin(time * 7.5) * 0.42;
        rightArmRef.current.rotation.x = -Math.sin(time * 7.5) * 0.42;
      }
    }
    if (leftLegRef.current && rightLegRef.current) {
      const stride = walking ? Math.sin(time * 7.5) * 0.42 : 0;
      leftLegRef.current.rotation.x = stride;
      rightLegRef.current.rotation.x = -stride;
    }
  });

  const torsoY = seated ? 1.14 : 1.16;
  const hipY = seated ? 0.75 : 0.72;

  return (
    <group ref={bodyRef}>
      <Block position={[0, hipY, 0]} size={[0.52, 0.28, 0.34]} color="#202832" />
      <Block position={[0, torsoY, 0]} size={[0.64, 0.62, 0.34]} color={palette.uniform} />
      <Block position={[0, torsoY, 0.185]} size={[0.08, 0.53, 0.04]} color={palette.accent} emissive={palette.accent} />

      <group ref={headRef}>
        <mesh position={[0, 1.72, 0]} castShadow>
          <sphereGeometry args={[0.27, 8, 6]} />
          <meshStandardMaterial color={palette.skin} roughness={0.86} />
        </mesh>
        <Hair id={agent.id} color={palette.hair} />
        {agent.id === "jarvis" && (
          <Block position={[0, 1.59, 0.23]} size={[0.35, 0.11, 0.07]} color="#17191c" />
        )}
        {agent.id === "vision" && (
          <Block position={[0, 1.76, 0.24]} size={[0.44, 0.06, 0.045]} color="#111619" />
        )}
      </group>

      <group ref={leftArmRef} position={[-0.42, 1.32, 0]}>
        <Block
          position={[0, -0.2, seated ? 0.15 : 0]}
          rotation={seated ? [-0.82, 0, 0] : [0, 0, -0.06]}
          size={[0.2, 0.58, 0.22]}
          color={palette.uniform}
        />
        <Block position={[0, seated ? -0.3 : -0.5, seated ? 0.38 : 0]} size={[0.18, 0.2, 0.19]} color={palette.skin} />
      </group>
      <group ref={rightArmRef} position={[0.42, 1.32, 0]}>
        <Block
          position={[0, -0.2, seated ? 0.15 : 0]}
          rotation={seated ? [-0.82, 0, 0] : [0, 0, 0.06]}
          size={[0.2, 0.58, 0.22]}
          color={palette.uniform}
        />
        <Block position={[0, seated ? -0.3 : -0.5, seated ? 0.38 : 0]} size={[0.18, 0.2, 0.19]} color={palette.skin} />
      </group>

      {seated ? (
        <group>
          <Block position={[-0.18, 0.66, 0.27]} rotation={[Math.PI / 2, 0, 0]} size={[0.24, 0.6, 0.27]} color="#202832" />
          <Block position={[0.18, 0.66, 0.27]} rotation={[Math.PI / 2, 0, 0]} size={[0.24, 0.6, 0.27]} color="#202832" />
          <Block position={[-0.18, 0.3, 0.55]} size={[0.23, 0.55, 0.25]} color="#27313b" />
          <Block position={[0.18, 0.3, 0.55]} size={[0.23, 0.55, 0.25]} color="#27313b" />
          <Block position={[-0.18, 0.08, 0.68]} size={[0.29, 0.14, 0.43]} color="#10171d" />
          <Block position={[0.18, 0.08, 0.68]} size={[0.29, 0.14, 0.43]} color="#10171d" />
        </group>
      ) : (
        <group>
          <group ref={leftLegRef} position={[-0.18, 0.72, 0]}>
            <Block position={[0, -0.29, 0]} size={[0.25, 0.68, 0.28]} color="#27313b" />
            <Block position={[0, -0.64, 0.09]} size={[0.3, 0.14, 0.46]} color="#10171d" />
          </group>
          <group ref={rightLegRef} position={[0.18, 0.72, 0]}>
            <Block position={[0, -0.29, 0]} size={[0.25, 0.68, 0.28]} color="#27313b" />
            <Block position={[0, -0.64, 0.09]} size={[0.3, 0.14, 0.46]} color="#10171d" />
          </group>
        </group>
      )}
    </group>
  );
}

export default function PixelAgent({ agent, selected, onSelect }: PixelAgentProps) {
  const [hovered, setHovered] = useState(false);
  const [arrived, setArrived] = useState(false);
  const arrivedRef = useRef(false);
  const arrivalStartedAt = useRef<number | null>(null);
  const rootRef = useRef<Group>(null);
  const ringRef = useRef<Mesh>(null);
  const station = WORLD_STATIONS[agent.id] ?? DEFAULT_STATION;
  const statusColor = STATUS_COLORS[agent.status];
  const active = agent.status === "working" || agent.status === "thinking";
  const showLabel = selected || hovered || active || agent.status === "blocked";
  const labelOffset = useMemo<[number, number, number]>(() => [
    station.labelPosition[0] - station.position[0],
    station.labelPosition[1] - station.position[1],
    station.labelPosition[2] - station.position[2],
  ], [station]);

  useFrame(({ clock }) => {
    if (arrivalStartedAt.current === null) arrivalStartedAt.current = clock.elapsedTime;
    const elapsed = clock.elapsedTime - arrivalStartedAt.current;
    const delay = Math.min(1.1, agent.id.length * 0.09);
    const progress = THREE.MathUtils.smoothstep(elapsed - delay, 0, 1.75);
    const entryOffset = ENTRY_OFFSETS[agent.id] ?? [1.4, 0, 0.8];
    if (rootRef.current) {
      rootRef.current.position.set(
        station.position[0] + entryOffset[0] * (1 - progress),
        station.position[1] + entryOffset[1] * (1 - progress),
        station.position[2] + entryOffset[2] * (1 - progress),
      );
      const travelRotation = Math.atan2(-entryOffset[0], -entryOffset[2]);
      rootRef.current.rotation.y = THREE.MathUtils.lerp(travelRotation, station.rotationY, progress);
    }
    if (progress >= 1 && !arrivedRef.current) {
      arrivedRef.current = true;
      setArrived(true);
    }
    if (!ringRef.current) return;
    const pulse = selected || active ? 1 + Math.sin(clock.elapsedTime * 3.4) * 0.05 : 1;
    ringRef.current.scale.setScalar(pulse);
  });

  return (
    <group
      ref={rootRef}
      position={[
        station.position[0] + (ENTRY_OFFSETS[agent.id]?.[0] ?? 1.4),
        station.position[1] + (ENTRY_OFFSETS[agent.id]?.[1] ?? 0),
        station.position[2] + (ENTRY_OFFSETS[agent.id]?.[2] ?? 0.8),
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
        <meshBasicMaterial color={statusColor} transparent opacity={selected ? 0.95 : 0.6} />
      </mesh>

      {agent.id === "dum-e" ? (
        <DumE active={active} />
      ) : (
        <Human agent={agent} seated={arrived && station.pose === "seated"} walking={!arrived} />
      )}

      {showLabel && (
        <Html position={labelOffset} center zIndexRange={[20, 0]}>
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
    </group>
  );
}
