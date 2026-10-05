import { useGLTF } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import type { Group, Mesh, Object3D, Points } from "three";
import * as THREE from "three";
import towerUrl from "../assets/3d/after-hours-rnd/tower.glb?url";

const RAIN_DROP_COUNT = 360;
const RAIN_TOP = 13;
const RAIN_BOTTOM = -2;

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function prepareScene(scene: Group): void {
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      material.depthWrite = material.transparent ? false : material.depthWrite;
    }
  });
}

function Skyline() {
  const buildings = useMemo(() => Array.from({ length: 24 }, (_, index) => ({
    x: -14 + index * 1.22,
    y: 5.4 + ((index * 5) % 9) * 0.62,
    width: 0.68 + (index % 4) * 0.13,
    depth: 0.75 + (index % 3) * 0.2,
  })), []);

  return (
    <group position={[0, -2.3, -9.2]}>
      {buildings.map((building, index) => (
        <group key={building.x} position={[building.x, building.y / 2, (index % 4) * 0.55]}>
          <mesh>
            <boxGeometry args={[building.width, building.y, building.depth]} />
            <meshStandardMaterial color={index % 2 ? "#0b1b24" : "#102630"} roughness={0.88} />
          </mesh>
          {Array.from({ length: Math.floor(building.y / 0.58) }, (_, row) => (
            <mesh key={row} position={[0, -building.y / 2 + 0.42 + row * 0.58, building.depth / 2 + 0.006]}>
              <planeGeometry args={[building.width * 0.62, 0.055]} />
              <meshBasicMaterial
                color={(row + index) % 5 === 0 ? "#f6a23d" : "#23718c"}
                transparent
                opacity={0.72}
              />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  );
}

function RainField() {
  const pointsRef = useRef<Points>(null);
  const positions = useMemo(() => {
    const random = seededRandom(87421);
    const values = new Float32Array(RAIN_DROP_COUNT * 3);
    for (let index = 0; index < RAIN_DROP_COUNT; index += 1) {
      values[index * 3] = -16 + random() * 32;
      values[index * 3 + 1] = RAIN_BOTTOM + random() * (RAIN_TOP - RAIN_BOTTOM);
      values[index * 3 + 2] = -13 + random() * 22;
    }
    return values;
  }, []);

  useFrame((_, delta) => {
    const attribute = pointsRef.current?.geometry.getAttribute("position") as THREE.BufferAttribute | undefined;
    if (!attribute) return;
    for (let index = 0; index < RAIN_DROP_COUNT; index += 1) {
      const yIndex = index * 3 + 1;
      const xIndex = index * 3;
      attribute.array[yIndex] -= delta * 4.8;
      attribute.array[xIndex] -= delta * 0.75;
      if (attribute.array[yIndex] < RAIN_BOTTOM) {
        attribute.array[yIndex] = RAIN_TOP;
        attribute.array[xIndex] += 2.3;
      }
    }
    attribute.needsUpdate = true;
  });

  return (
    <points ref={pointsRef} frustumCulled={false}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#78d9ed" size={0.035} transparent opacity={0.36} sizeAttenuation={false} depthWrite={false} />
    </points>
  );
}

function HolographicDetails() {
  const commandRef = useRef<Group>(null);
  const vaultRef = useRef<Group>(null);
  useFrame(({ clock }, delta) => {
    if (commandRef.current) {
      commandRef.current.rotation.y += delta * 0.3;
      commandRef.current.position.y = 4.32 + Math.sin(clock.elapsedTime * 1.4) * 0.04;
    }
    if (vaultRef.current) vaultRef.current.rotation.y -= delta * 0.52;
  });

  return (
    <>
      <group ref={commandRef} position={[0, 4.32, -2.48]}>
        <mesh>
          <icosahedronGeometry args={[0.66, 2]} />
          <meshBasicMaterial color="#31d9ff" wireframe transparent opacity={0.72} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.8, 0.018, 4, 40]} />
          <meshBasicMaterial color="#31d9ff" transparent opacity={0.74} />
        </mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.7, 0.012, 4, 36]} />
          <meshBasicMaterial color="#31d9ff" transparent opacity={0.5} />
        </mesh>
      </group>
      <group ref={vaultRef} position={[5.25, 1.33, 0.95]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.52, 0.012, 4, 32]} />
          <meshBasicMaterial color="#31d9ff" transparent opacity={0.72} />
        </mesh>
        <mesh rotation={[0, 0, Math.PI / 2]}>
          <torusGeometry args={[0.43, 0.01, 4, 28]} />
          <meshBasicMaterial color="#31d9ff" transparent opacity={0.5} />
        </mesh>
      </group>
    </>
  );
}

export default function ProductionTower() {
  const gltf = useGLTF(towerUrl);
  const scene = useMemo(() => gltf.scene.clone(true), [gltf.scene]);
  const holoRef = useRef<Object3D | null>(null);

  useEffect(() => {
    prepareScene(scene);
    holoRef.current = scene.getObjectByName("holo_core") ?? null;
  }, [scene]);

  useFrame(({ clock }, delta) => {
    const holo = holoRef.current;
    if (!holo) return;
    holo.rotation.y += delta * 0.72;
    holo.position.y = 1.35 + Math.sin(clock.elapsedTime * 1.8) * 0.08;
  });

  return (
    <group>
      <Skyline />
      <RainField />
      <primitive object={scene} />
      <HolographicDetails />
      <pointLight position={[5.25, 1.45, 0.95]} color="#31d9ff" intensity={7} distance={4.5} decay={2} />
      <pointLight position={[-3.45, 3.2, -2.75]} color="#ffad4f" intensity={5} distance={4} decay={2} />
      <pointLight position={[0, 4.45, -2.45]} color="#31d9ff" intensity={4.5} distance={4.5} decay={2} />
      <pointLight position={[-4.25, 2.45, 1.65]} color="#31d9ff" intensity={3.5} distance={4} decay={2} />
    </group>
  );
}

useGLTF.preload(towerUrl);
