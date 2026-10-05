// One vocabulary for agent state across every screen: the same word, tone and
// icon wherever an agent's status appears.
import { CircleAlert, CircleDashed, CirclePause, CirclePower, RefreshCw, type LucideIcon } from "lucide-react";
import type { AgentStatus } from "./types";

export type StateTone = "running" | "review" | "attention" | "danger" | "success" | "idle";

export interface StatusPresentation {
  label: string;
  tone: StateTone;
  icon: LucideIcon;
  /** True while the agent's session is doing work right now. */
  busy: boolean;
  /** True while a provider session exists at all. */
  online: boolean;
}

export const AGENT_STATUS: Record<AgentStatus, StatusPresentation> = {
  working: { label: "Working", tone: "running", icon: RefreshCw, busy: true, online: true },
  thinking: { label: "Thinking", tone: "running", icon: CircleDashed, busy: true, online: true },
  idle: { label: "Idle", tone: "success", icon: CirclePause, busy: false, online: true },
  blocked: { label: "Blocked", tone: "danger", icon: CircleAlert, busy: false, online: true },
  offline: { label: "Offline", tone: "idle", icon: CirclePower, busy: false, online: false },
};

export const presentStatus = (status: AgentStatus): StatusPresentation => AGENT_STATUS[status];
