// The shape of a room's life (its *-life.json): where people can walk, each
// station's agent, the things to do around the room, and the furniture people
// pass behind. Every point is in mockup px, like the room's scene file.

/** Which way a character faces: toward the viewer (S) or away (N), and to the right (E) or left (W). */
export type Dir = "SE" | "SW" | "NE" | "NW";

export type Point = { x: number; y: number };
export type Rect = readonly [number, number, number, number];

export interface CastJson {
  /** Where the agent stands when up at their station. */
  node: string;
  /** Which way they face at the station (and how the room paints them). */
  face: Dir;
  /** The cut-out sits; getting up happens at `rise` (feet, by the chair). */
  seated?: boolean;
  rise?: number[];
  /** Where a colleague stands to talk to them; without one they can't be visited on foot. */
  visit?: string;
  /** Head and hand boxes in cut-out px: what the in-place animation moves. */
  parts: { head: number[]; hands?: number[][] };
}

/** What a spot is for: errands and thinking are idle pastimes; "review" is where finished work goes; "local" belongs to one station. */
export type SpotKind = "errand" | "think" | "review" | "local";

export interface SpotJson {
  id: string;
  node: string;
  face: Dir;
  /** Poses held in turn while there. */
  poses: string[];
  kind: SpotKind;
  /** Seconds spent there: [min, max]. */
  dwell: number[];
  /** A "local" spot's station. */
  for?: string;
}

export interface OccluderJson {
  id: string;
  /** Where the furniture meets the floor: anyone whose feet are above this is behind it. */
  baseY: number;
  poly: number[][];
}

export interface LifeJson {
  nodes: Record<string, number[]>;
  edges: string[][];
  cast: Record<string, CastJson>;
  spots: SpotJson[];
  /** Pairs of nodes two people can stand at to chat. */
  meets: string[][];
  occluders: OccluderJson[];
}

/** What an agent is up to, as the room shows it. */
export type Activity = "working" | "thinking" | "idle" | "waiting" | "offline";

/** Something that sends someone across the room: handing work over, reporting back, or handing in finished work. */
export interface LifeEvent {
  kind: "brief" | "report" | "deliver";
  /** The agent who walks. */
  from: string;
  /** The agent they go to (brief, report). */
  to?: string;
}

/** How a station's cut-out is animated in place: the head nudged a pixel, one hand tapping. */
export type HeadPose = "rest" | "up" | "down" | "left" | "right";

export interface StationView {
  kind: "station";
  head: HeadPose;
  /** Which hand box is tapping (index into `parts.hands`), or -1. */
  hand: number;
}

export interface WalkerView {
  kind: "walker";
  /** A pose name ("stand", "talk", "coffee", …) or "walk". */
  pose: string;
  /** Walk cycle frame, for "walk". */
  frame: number;
  /** Breathing: the pose's breathing twin, where it has one. */
  breath: boolean;
  dir: Dir;
  /** Feet, mockup px. */
  x: number;
  y: number;
}

export type ActorView = StationView | WalkerView;

export const toPoint = (p: readonly number[]): Point => ({ x: p[0], y: p[1] });
