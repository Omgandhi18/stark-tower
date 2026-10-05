// The two automations built into Starkline: the orchestrator's standup
// check-ins, and app maintenance (bugs agents report in Starkline itself).
import { CalendarClock, Wrench, type LucideIcon } from "lucide-react";
import type { Bug } from "../../lib/types";
import { bugCounts } from "./bugs";

export type BuiltInId = "standup" | "maintenance";

export interface BuiltIn {
  id: BuiltInId;
  name: string;
  icon: LucideIcon;
  /** Its state in a few words ("Every 30 minutes", "2 open bugs"). */
  status: string;
}

const MINUTES_PER_HOUR = 60;

/** "Every 30 minutes", "Every hour", "Every 2 hours". */
export const standupLabel = (minutes: number) =>
  minutes < MINUTES_PER_HOUR ? `Every ${minutes} minutes` : minutes === MINUTES_PER_HOUR ? "Every hour" : `Every ${minutes / MINUTES_PER_HOUR} hours`;

export function builtIns(standupMinutes: number, bugs: readonly Bug[]): BuiltIn[] {
  const counts = bugCounts(bugs);
  const maintenance =
    counts.fixing > 0 ? `Fixing ${counts.fixing}` : counts.open === 1 ? "1 open bug" : counts.open > 0 ? `${counts.open} open bugs` : "No open bugs";
  return [
    { id: "standup", name: "Standup check-ins", icon: CalendarClock, status: standupMinutes > 0 ? standupLabel(standupMinutes) : "Off" },
    { id: "maintenance", name: "App maintenance", icon: Wrench, status: maintenance },
  ];
}

export const isBuiltIn = (id: number | BuiltInId | null): id is BuiltInId => id === "standup" || id === "maintenance";
