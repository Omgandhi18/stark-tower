import { Bell, Building2, LayoutGrid, Settings, UsersRound, Zap, type LucideIcon } from "lucide-react";
import type { RouteId } from "../stores/navigation";

export interface NavItem {
  route: RouteId;
  label: string;
  icon: LucideIcon;
  /** ⌘ + this key jumps here. */
  shortcut: string;
}

/** The sidebar, in order. The task and conversation screens live under Work. */
export const NAV_ITEMS: readonly NavItem[] = [
  { route: "work", label: "Work", icon: LayoutGrid, shortcut: "1" },
  { route: "environment", label: "Environment", icon: Building2, shortcut: "2" },
  { route: "agents", label: "Agents", icon: UsersRound, shortcut: "3" },
  { route: "automations", label: "Automations", icon: Zap, shortcut: "4" },
  { route: "notifications", label: "Notifications", icon: Bell, shortcut: "5" },
  { route: "settings", label: "Settings", icon: Settings, shortcut: "6" },
];

/** Which sidebar item a route belongs to: a task and a conversation live under Work. */
export const navRouteFor = (route: RouteId): RouteId => (route === "conversation" || route === "task" ? "work" : route);
