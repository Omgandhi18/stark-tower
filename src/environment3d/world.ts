import type { AgentStatus } from "../lib/types";

export type Vector3Tuple = [number, number, number];
export type StationPose = "seated" | "standing";

export interface WorldStation {
  position: Vector3Tuple;
  rotationY: number;
  pose: StationPose;
  labelPosition: Vector3Tuple;
}

export const WORLD_STATIONS: Record<string, WorldStation> = {
  jarvis: {
    position: [0.65, 3.05, -1.55],
    rotationY: -0.25,
    pose: "seated",
    labelPosition: [1.65, 5.0, -1.25],
  },
  friday: {
    position: [-4.25, 0.05, 2.55],
    rotationY: Math.PI,
    pose: "seated",
    labelPosition: [-5.05, 2.15, 2.7],
  },
  vision: {
    position: [3.7, 1.05, -0.55],
    rotationY: Math.PI / 2,
    pose: "standing",
    labelPosition: [3.15, 3.35, -0.35],
  },
  edith: {
    position: [-0.65, 0.05, 3.25],
    rotationY: Math.PI,
    pose: "standing",
    labelPosition: [-0.1, 2.4, 3.4],
  },
  karen: {
    position: [3.75, 0.05, 3.1],
    rotationY: Math.PI / 2,
    pose: "standing",
    labelPosition: [3.15, 2.4, 3.25],
  },
  veronica: {
    position: [-4.7, 2.05, -2.75],
    rotationY: 0,
    pose: "seated",
    labelPosition: [-3.9, 4.15, -2.55],
  },
  "dum-e": {
    position: [0.85, 0.05, 3.45],
    rotationY: -Math.PI / 4,
    pose: "standing",
    labelPosition: [1.35, 1.75, 3.6],
  },
};

export const STATUS_COLORS: Record<AgentStatus, string> = {
  offline: "#8b9aa5",
  idle: "#5de7ba",
  thinking: "#36d7ff",
  working: "#ffbd5b",
  blocked: "#ff5f72",
};

export const STATUS_LABELS: Record<AgentStatus, string> = {
  offline: "Offline",
  idle: "Available",
  thinking: "Thinking",
  working: "Running",
  blocked: "Needs you",
};

export const DEFAULT_STATION: WorldStation = {
  position: [0, 0.05, 1.4],
  rotationY: 0,
  pose: "standing",
  labelPosition: [0.6, 2.35, 1.5],
};
