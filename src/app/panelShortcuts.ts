// The keys that collapse and expand the side panels: ⌘B the sidebar, and on a task ⇧⌘B its
// left column and ⌥⌘B its side panel.
import type { PanelId } from "../stores/panels";
import type { RouteId } from "../stores/navigation";

/** Shown in each panel's collapse button. */
export const PANEL_SHORTCUT: Record<PanelId, string> = { sidebar: "⌘B", taskLeft: "⇧⌘B", taskRight: "⌥⌘B" };

type Keys = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** The panel a key press collapses or expands, if any. A task's columns only answer while a task is on screen. */
export function panelFor(e: Keys, route: RouteId): PanelId | null {
  if (e.code !== "KeyB" || !e.metaKey || e.ctrlKey || (e.altKey && e.shiftKey)) return null;
  if (!e.altKey && !e.shiftKey) return "sidebar";
  if (route !== "task") return null;
  return e.shiftKey ? "taskLeft" : "taskRight";
}
