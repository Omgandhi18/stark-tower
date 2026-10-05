import { Line, RoundedBox } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group, Mesh } from "three";
import { WORLD_STATIONS, type Vector3Tuple } from "./world";

const PALETTE = {
  void: "#02080d",
  structure: "#263842",
  structureLight: "#49616c",
  floor: "#34525e",
  floorEdge: "#4d6974",
  cyan: "#2edbff",
  amber: "#ffad4f",
  glass: "#14394a",
  screen: "#073b4e",
};

function StandardMaterial({
  color,
  emissive,
  emissiveIntensity = 0,
  metalness = 0.18,
  roughness = 0.58,
}: {
  color: string;
  emissive?: string;
  emissiveIntensity?: number;
  metalness?: number;
  roughness?: number;
}) {
  return (
    <meshStandardMaterial
      color={color}
      emissive={emissive ?? "#000000"}
      emissiveIntensity={emissiveIntensity}
      metalness={metalness}
      roughness={roughness}
    />
  );
}

function FloorDeck({
  position,
  size,
  accent = PALETTE.cyan,
}: {
  position: Vector3Tuple;
  size: Vector3Tuple;
  accent?: string;
}) {
  const verticalLines = useMemo(() => {
    const count = Math.floor(size[0] / 0.8);
    return Array.from({ length: count - 1 }, (_, index) => -size[0] / 2 + (index + 1) * (size[0] / count));
  }, [size]);
  const horizontalLines = useMemo(() => {
    const count = Math.floor(size[2] / 0.8);
    return Array.from({ length: count - 1 }, (_, index) => -size[2] / 2 + (index + 1) * (size[2] / count));
  }, [size]);

  return (
    <group position={position}>
      <RoundedBox args={size} radius={0.08} smoothness={1} receiveShadow castShadow>
        <StandardMaterial color={PALETTE.floor} emissive="#123846" emissiveIntensity={0.28} />
      </RoundedBox>
      <mesh position={[0, size[1] / 2 + 0.006, 0]} receiveShadow>
        <boxGeometry args={[size[0] - 0.14, 0.012, size[2] - 0.14]} />
        <meshStandardMaterial color="#42636d" metalness={0.2} roughness={0.52} />
      </mesh>
      {verticalLines.map((x) => (
        <mesh key={`v-${x}`} position={[x, size[1] / 2 + 0.016, 0]}>
          <boxGeometry args={[0.012, 0.01, size[2] - 0.2]} />
          <meshBasicMaterial color="#31515d" transparent opacity={0.48} />
        </mesh>
      ))}
      {horizontalLines.map((z) => (
        <mesh key={`h-${z}`} position={[0, size[1] / 2 + 0.016, z]}>
          <boxGeometry args={[size[0] - 0.2, 0.01, 0.012]} />
          <meshBasicMaterial color="#31515d" transparent opacity={0.48} />
        </mesh>
      ))}
      <mesh position={[0, size[1] / 2 + 0.025, size[2] / 2 - 0.06]}>
        <boxGeometry args={[size[0] - 0.18, 0.025, 0.045]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={2.8} />
      </mesh>
    </group>
  );
}

function Rail({
  position,
  length,
  rotationY = 0,
}: {
  position: Vector3Tuple;
  length: number;
  rotationY?: number;
}) {
  const posts = useMemo(() => {
    const count = Math.max(2, Math.ceil(length / 1.2));
    return Array.from({ length: count + 1 }, (_, index) => -length / 2 + index * (length / count));
  }, [length]);

  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.72, 0]}>
        <boxGeometry args={[length, 0.055, 0.06]} />
        <StandardMaterial color="#80949e" metalness={0.85} roughness={0.25} />
      </mesh>
      <mesh position={[0, 0.39, 0]}>
        <boxGeometry args={[length - 0.12, 0.56, 0.025]} />
        <meshPhysicalMaterial
          color={PALETTE.glass}
          transparent
          opacity={0.22}
          transmission={0.35}
          roughness={0.12}
          metalness={0.05}
          depthWrite={false}
        />
      </mesh>
      {posts.map((x) => (
        <mesh key={x} position={[x, 0.36, 0]}>
          <boxGeometry args={[0.055, 0.75, 0.07]} />
          <StandardMaterial color="#80949e" metalness={0.88} roughness={0.22} />
        </mesh>
      ))}
    </group>
  );
}

function Stairs({
  position,
  rotationY = 0,
  steps = 8,
  rise = 1,
}: {
  position: Vector3Tuple;
  rotationY?: number;
  steps?: number;
  rise?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      {Array.from({ length: steps }, (_, index) => {
        const height = ((index + 1) / steps) * rise;
        return (
          <group key={index} position={[0, height / 2, index * 0.34]}>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[1.65, height, 0.36]} />
              <StandardMaterial color={PALETTE.structure} />
            </mesh>
            <mesh position={[0, height / 2 + 0.018, 0.12]}>
              <boxGeometry args={[1.5, 0.025, 0.055]} />
              <meshStandardMaterial color={PALETTE.amber} emissive={PALETTE.amber} emissiveIntensity={2.5} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

function StructuralColumn({
  position,
  height,
}: {
  position: Vector3Tuple;
  height: number;
}) {
  return (
    <group position={position}>
      <RoundedBox args={[0.42, height, 0.42]} radius={0.04} smoothness={1} position={[0, height / 2, 0]} castShadow>
        <StandardMaterial color="#17242b" metalness={0.78} roughness={0.28} />
      </RoundedBox>
      <mesh position={[0, height / 2, 0.218]}>
        <boxGeometry args={[0.075, height - 0.22, 0.028]} />
        <meshStandardMaterial color={PALETTE.amber} emissive={PALETTE.amber} emissiveIntensity={2.8} />
      </mesh>
      <mesh position={[0, height + 0.08, 0]}>
        <boxGeometry args={[0.58, 0.16, 0.58]} />
        <StandardMaterial color="#263841" metalness={0.82} roughness={0.22} />
      </mesh>
    </group>
  );
}

function CommandBackdrop() {
  return (
    <group position={[0, 3.02, -5.02]}>
      <RoundedBox args={[6.15, 3.25, 0.25]} radius={0.06} smoothness={1} position={[0, 1.62, 0]} castShadow receiveShadow>
        <StandardMaterial color="#17242c" emissive="#091820" emissiveIntensity={0.25} />
      </RoundedBox>
      {[-2.55, -1.7, -0.85, 0, 0.85, 1.7, 2.55].map((x) => (
        <mesh key={x} position={[x, 1.63, 0.14]}>
          <boxGeometry args={[0.05, 2.85, 0.04]} />
          <meshStandardMaterial color={PALETTE.amber} emissive={PALETTE.amber} emissiveIntensity={2.1} />
        </mesh>
      ))}
    </group>
  );
}

function Monitor({ position, rotationY = 0, width = 1.25 }: { position: Vector3Tuple; rotationY?: number; width?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <RoundedBox args={[width, 0.72, 0.1]} radius={0.04} smoothness={1} castShadow>
        <StandardMaterial color="#071016" />
      </RoundedBox>
      <mesh position={[0, 0, 0.058]}>
        <planeGeometry args={[width - 0.1, 0.61]} />
        <meshStandardMaterial color={PALETTE.screen} emissive="#0ebee8" emissiveIntensity={0.75} />
      </mesh>
      {[0.14, 0, -0.14].map((y, index) => (
        <mesh key={y} position={[-0.2 + index * 0.08, y, 0.064]}>
          <planeGeometry args={[width * (0.46 + index * 0.1), 0.025]} />
          <meshBasicMaterial color={index === 1 ? PALETTE.amber : PALETTE.cyan} />
        </mesh>
      ))}
      <mesh position={[0, -0.54, -0.04]}>
        <boxGeometry args={[0.1, 0.36, 0.08]} />
        <StandardMaterial color={PALETTE.structureLight} />
      </mesh>
    </group>
  );
}

function Desk({ position, rotationY = 0, width = 3.2 }: { position: Vector3Tuple; rotationY?: number; width?: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <RoundedBox args={[width, 0.16, 0.82]} radius={0.06} smoothness={1} position={[0, 0.86, 0]} castShadow receiveShadow>
        <StandardMaterial color="#24343d" metalness={0.68} roughness={0.26} />
      </RoundedBox>
      <mesh position={[-width / 2 + 0.18, 0.43, 0]} castShadow>
        <boxGeometry args={[0.24, 0.86, 0.66]} />
        <StandardMaterial color={PALETTE.structure} />
      </mesh>
      <mesh position={[width / 2 - 0.18, 0.43, 0]} castShadow>
        <boxGeometry args={[0.24, 0.86, 0.66]} />
        <StandardMaterial color={PALETTE.structure} />
      </mesh>
      <mesh position={[0, 0.94, 0.34]}>
        <boxGeometry args={[width - 0.18, 0.025, 0.035]} />
        <meshStandardMaterial color={PALETTE.cyan} emissive={PALETTE.cyan} emissiveIntensity={2.3} />
      </mesh>
    </group>
  );
}

function ChairAt({ id }: { id: "jarvis" | "friday" }) {
  const station = WORLD_STATIONS[id];
  return (
    <group position={station.position} rotation={[0, station.rotationY, 0]}>
      <mesh position={[0, 0.62, -0.12]} castShadow>
        <boxGeometry args={[0.7, 0.16, 0.68]} />
        <StandardMaterial color="#111920" roughness={0.76} />
      </mesh>
      <RoundedBox args={[0.72, 0.82, 0.14]} radius={0.08} smoothness={1} position={[0, 1.02, -0.43]} castShadow>
        <StandardMaterial color="#131d24" roughness={0.72} />
      </RoundedBox>
      <mesh position={[0, 0.28, -0.08]}>
        <cylinderGeometry args={[0.055, 0.07, 0.55, 8]} />
        <StandardMaterial color="#6f828b" metalness={0.84} />
      </mesh>
      <mesh position={[0, 0.06, -0.08]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.035, 0.035, 0.78, 8]} />
        <StandardMaterial color="#6f828b" metalness={0.84} />
      </mesh>
    </group>
  );
}

function CommandDeck() {
  const holoRef = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (holoRef.current) holoRef.current.rotation.y = clock.elapsedTime * 0.28;
  });

  return (
    <group>
      <Desk position={[0, 3.05, -2.1]} width={3.5} />
      <ChairAt id="jarvis" />
      <Monitor position={[-1.08, 4.38, -2.78]} rotationY={0.22} width={1.55} />
      <Monitor position={[0, 4.48, -2.92]} width={1.6} />
      <Monitor position={[1.08, 4.38, -2.78]} rotationY={-0.22} width={1.55} />
      <group ref={holoRef} position={[0, 4.05, -2.15]}>
        <mesh>
          <icosahedronGeometry args={[0.42, 2]} />
          <meshBasicMaterial color={PALETTE.cyan} wireframe transparent opacity={0.7} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.62, 0.018, 5, 48]} />
          <meshBasicMaterial color={PALETTE.cyan} transparent opacity={0.8} />
        </mesh>
      </group>
    </group>
  );
}

function BuildBay() {
  return (
    <group>
      <Desk position={[-4.25, 1.05, 1.58]} rotationY={Math.PI} width={3.4} />
      <ChairAt id="friday" />
      <Monitor position={[-5.3, 2.42, 1.88]} rotationY={Math.PI - 0.22} width={1.35} />
      <Monitor position={[-4.25, 2.52, 1.72]} rotationY={Math.PI} width={1.5} />
      <Monitor position={[-3.2, 2.42, 1.88]} rotationY={Math.PI + 0.22} width={1.35} />
    </group>
  );
}

function ReviewWall() {
  return (
    <group position={[5.05, 2.25, -0.55]} rotation={[0, -Math.PI / 2, 0]}>
      <RoundedBox args={[3.8, 2.15, 0.18]} radius={0.08} smoothness={1} castShadow>
        <StandardMaterial color="#071016" />
      </RoundedBox>
      <mesh position={[0, 0, 0.1]}>
        <planeGeometry args={[3.58, 1.94]} />
        <meshStandardMaterial color="#06384b" emissive="#087a9c" emissiveIntensity={0.72} />
      </mesh>
      {[-0.58, -0.28, 0.02, 0.32, 0.62].map((y, index) => (
        <mesh key={y} position={[-0.72 + index * 0.13, y, 0.115]}>
          <planeGeometry args={[1.65 + index * 0.18, 0.045]} />
          <meshBasicMaterial color={index === 2 ? PALETTE.amber : PALETTE.cyan} />
        </mesh>
      ))}
    </group>
  );
}

function ServerBank() {
  return (
    <group position={[5.05, 0.05, 3.1]} rotation={[0, -Math.PI / 2, 0]}>
      {[-1.25, -0.42, 0.42, 1.25].map((x, rackIndex) => (
        <RoundedBox key={x} args={[0.72, 2.35, 0.74]} radius={0.05} smoothness={1} position={[x, 1.18, 0]} castShadow>
          <StandardMaterial color="#101b22" metalness={0.7} roughness={0.3} />
          {Array.from({ length: 6 }, (_, lightIndex) => (
            <mesh key={lightIndex} position={[-0.16 + (lightIndex % 2) * 0.32, 0.82 - Math.floor(lightIndex / 2) * 0.46, 0.378]}>
              <boxGeometry args={[0.09, 0.045, 0.018]} />
              <meshBasicMaterial color={(rackIndex + lightIndex) % 3 === 0 ? PALETTE.amber : PALETTE.cyan} />
            </mesh>
          ))}
        </RoundedBox>
      ))}
    </group>
  );
}

function Lounge() {
  const station = WORLD_STATIONS.veronica;
  return (
    <group position={station.position} rotation={[0, station.rotationY, 0]}>
      <RoundedBox args={[2.05, 0.55, 0.86]} radius={0.13} smoothness={2} position={[0, 0.48, -0.22]} castShadow>
        <StandardMaterial color="#263238" roughness={0.82} />
      </RoundedBox>
      <RoundedBox args={[2.08, 1.05, 0.26]} radius={0.12} smoothness={2} position={[0, 0.98, -0.58]} castShadow>
        <StandardMaterial color="#222e34" roughness={0.84} />
      </RoundedBox>
      <mesh position={[1.22, 0.52, 0]}>
        <cylinderGeometry args={[0.46, 0.52, 0.08, 10]} />
        <StandardMaterial color="#1a262c" />
      </mesh>
      <mesh position={[1.22, 0.79, 0]}>
        <cylinderGeometry args={[0.035, 0.035, 0.5, 8]} />
        <StandardMaterial color="#798890" metalness={0.85} />
      </mesh>
      <pointLight position={[1.22, 1.5, 0]} color={PALETTE.amber} intensity={4} distance={4} decay={2} />
      <mesh position={[1.22, 1.35, 0]}>
        <sphereGeometry args={[0.18, 10, 6]} />
        <meshStandardMaterial color="#ffe0a2" emissive={PALETTE.amber} emissiveIntensity={1.8} />
      </mesh>
    </group>
  );
}

function HoloVault() {
  const coreRef = useRef<Mesh>(null);
  useFrame(({ clock }) => {
    if (!coreRef.current) return;
    coreRef.current.rotation.y = clock.elapsedTime * 0.7;
    coreRef.current.position.y = 1.35 + Math.sin(clock.elapsedTime * 1.8) * 0.08;
  });
  return (
    <group position={[5.25, 0.05, 0.95]}>
      <mesh position={[0, 0.18, 0]}>
        <cylinderGeometry args={[0.88, 1.05, 0.36, 14]} />
        <StandardMaterial color="#17252c" metalness={0.82} />
      </mesh>
      <mesh position={[0, 1.15, 0]}>
        <cylinderGeometry args={[0.72, 0.72, 1.8, 18, 1, true]} />
        <meshPhysicalMaterial color="#2edbff" transparent opacity={0.16} transmission={0.55} depthWrite={false} />
      </mesh>
      <mesh ref={coreRef} position={[0, 1.35, 0]}>
        <octahedronGeometry args={[0.36, 1]} />
        <meshBasicMaterial color={PALETTE.cyan} wireframe />
      </mesh>
      <pointLight position={[0, 1.25, 0]} color={PALETTE.cyan} intensity={8} distance={4} decay={2} />
    </group>
  );
}

function Plant({ position, scale = 1 }: { position: Vector3Tuple; scale?: number }) {
  return (
    <group position={position} scale={scale}>
      <RoundedBox args={[0.55, 0.62, 0.55]} radius={0.06} smoothness={1} position={[0, 0.31, 0]} castShadow>
        <StandardMaterial color="#26343a" metalness={0.72} />
      </RoundedBox>
      {[-0.28, -0.12, 0.08, 0.25].map((x, index) => (
        <mesh key={x} position={[x, 0.86 + (index % 2) * 0.14, (index - 1.5) * 0.08]} rotation={[0.2, 0, x * 0.9]} castShadow>
          <coneGeometry args={[0.2, 0.72, 6]} />
          <meshStandardMaterial color={index % 2 ? "#27a873" : "#35c486"} roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function Skyline() {
  const buildings = useMemo(() => Array.from({ length: 22 }, (_, index) => ({
    x: -13 + index * 1.25,
    height: 4 + ((index * 7) % 9) * 0.55,
    width: 0.75 + (index % 3) * 0.2,
    depth: 0.8 + (index % 4) * 0.15,
  })), []);
  return (
    <group position={[0, -1.8, -10]}>
      {buildings.map((building, index) => (
        <group key={building.x} position={[building.x, building.height / 2, (index % 3) * 0.7]}>
          <mesh>
            <boxGeometry args={[building.width, building.height, building.depth]} />
            <meshStandardMaterial color={index % 2 ? "#07131b" : "#0a1821"} roughness={0.9} />
          </mesh>
          {Array.from({ length: Math.floor(building.height / 0.65) }, (_, row) => (
            <mesh key={row} position={[0, -building.height / 2 + 0.5 + row * 0.65, building.depth / 2 + 0.006]}>
              <planeGeometry args={[building.width * 0.62, 0.08]} />
              <meshBasicMaterial color={(index + row) % 4 === 0 ? PALETTE.amber : "#14485d"} transparent opacity={0.72} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

export default function TowerWorld() {
  return (
    <group>
      <Skyline />
      <FloorDeck position={[0, -0.18, 2.05]} size={[12.4, 0.36, 6.5]} />
      <FloorDeck position={[0, 0.82, -1.05]} size={[12.5, 0.36, 7]} accent={PALETTE.amber} />
      <FloorDeck position={[0, 2.82, -3.05]} size={[6.2, 0.36, 4.1]} accent={PALETTE.amber} />
      <FloorDeck position={[-4.7, 1.82, -3]} size={[3.3, 0.36, 3.1]} accent={PALETTE.amber} />

      <CommandBackdrop />
      <StructuralColumn position={[-6.05, -0.18, 4.85]} height={4.8} />
      <StructuralColumn position={[6.05, -0.18, 4.85]} height={4.8} />
      <StructuralColumn position={[-6.05, -0.18, -4.35]} height={6.6} />
      <StructuralColumn position={[6.05, -0.18, -4.35]} height={6.6} />
      <StructuralColumn position={[-3.05, 0.82, -4.75]} height={4.9} />
      <StructuralColumn position={[3.05, 0.82, -4.75]} height={4.9} />

      <Stairs position={[-3.1, 0, 0.7]} rotationY={Math.PI} rise={1} />
      <Stairs position={[-2.35, 1, -1.55]} rotationY={Math.PI} rise={2} steps={10} />

      <Rail position={[2.7, 1.02, 2.37]} length={6.8} />
      <Rail position={[6.08, 1.02, -1.05]} length={6.8} rotationY={Math.PI / 2} />
      <Rail position={[0, 3.02, -1.08]} length={6.05} />
      <Rail position={[3.02, 3.02, -3.05]} length={3.9} rotationY={Math.PI / 2} />
      <Rail position={[-4.7, 2.02, -1.5]} length={3.15} />
      <Rail position={[-6.32, 2.02, -3]} length={2.9} rotationY={Math.PI / 2} />

      <CommandDeck />
      <BuildBay />
      <ReviewWall />
      <ServerBank />
      <Lounge />
      <HoloVault />

      <Plant position={[-2.55, 3.02, -4.05]} scale={0.9} />
      <Plant position={[2.65, 1.02, -2.2]} scale={0.95} />
      <Plant position={[-1.7, 0.02, 3.45]} scale={0.85} />
      <Plant position={[2.2, 0.02, 4.2]} scale={0.8} />

      <Line
        points={[
          [-5.7, 0.04, 4.9],
          [-1.8, 0.04, 4.9],
          [1.8, 0.04, 4.9],
          [5.7, 0.04, 4.9],
        ]}
        color={PALETTE.cyan}
        lineWidth={1.2}
        transparent
        opacity={0.7}
      />
    </group>
  );
}
