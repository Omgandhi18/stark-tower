// What the approved mockup shows, and how live agent state maps onto it.
import type { Agent, AgentStatus } from "../../lib/types";
import { PALETTE } from "../../lib/tokens";
import { recolorFilter } from "./color";
import { reference, type NavItemId } from "./referenceAssets";

/** "reference" renders exactly the mockup's state; "live" follows real agents. */
export type DisplayMode = "live" | "reference";

export type SupervisorHealth = "healthy" | "standby";

export interface CardContent {
  name: string;
  status: string;
  task: string;
  statusColor: string;
  /** CSS filter turning the mockup's green status dot into this state's colour. */
  dotFilter: string;
}

/** The state mockup 04 depicts. Copy here is the mockup's own sample data. */
export const REFERENCE_FIXTURE = {
  supervisor: "healthy" as SupervisorHealth,
  notifications: 1,
  keepAwake: true,
  activeNav: "environment" as NavItemId,
  focusSlot: "buildBay",
  card: {
    name: "FRIDAY",
    status: "Running",
    task: "Settings redesign",
    statusColor: reference.colors.cardStatus,
    dotFilter: "none",
  } satisfies CardContent,
} as const;

export const SUPERVISOR_LABEL: Record<SupervisorHealth, string> = {
  healthy: "Healthy",
  standby: "Standing by",
};

export const SUPERVISOR_COLOR: Record<SupervisorHealth, string> = {
  healthy: reference.colors.statusOk,
  standby: PALETTE.working,
};

// The mockup only shows green dots; other states are hue shifts of those pixels.
const MUTED_DOT = "grayscale(1)";

export const SUPERVISOR_DOT_FILTER: Record<SupervisorHealth, string> = {
  healthy: "none",
  standby: recolorFilter(reference.colors.statusDot, PALETTE.working),
};

const STATUS_LABEL: Record<AgentStatus, string> = {
  working: "Running",
  thinking: "Thinking",
  idle: "Idle",
  blocked: "Blocked",
  offline: "Offline",
};

const STATUS_COLOR: Record<AgentStatus, string> = {
  working: reference.colors.cardStatus,
  thinking: reference.colors.cardStatus,
  idle: PALETTE.dim,
  blocked: PALETTE.danger,
  offline: PALETTE.dim,
};

const DOT_FILTER: Record<AgentStatus, string> = {
  working: "none",
  thinking: "none",
  idle: MUTED_DOT,
  offline: MUTED_DOT,
  blocked: recolorFilter(reference.colors.cardDot, PALETTE.danger),
};

export function liveCard(agent: Agent): CardContent {
  return {
    name: agent.name,
    status: STATUS_LABEL[agent.status],
    task: agent.role,
    statusColor: STATUS_COLOR[agent.status],
    dotFilter: DOT_FILTER[agent.status],
  };
}
