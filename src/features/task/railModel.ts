// What a task's side panel shows, and how wide it may grow for the browser and simulator.
import type { PreviewTab } from "../../stores/preview";

/** The panel's own tabs, about the task; the rest are tools (the terminal, browser and simulator). */
export type StatusTab = "attention" | "changes" | "checks";
export type RailTab = StatusTab | "terminal" | PreviewTab;

/** The chat keeps at least this much room beside a widened panel (task.css holds the same floor). */
export const MIN_CHAT_WIDTH = 400;

/** An open tool takes the panel (the browser or simulator first: only one is open at a time); else the tab you picked. */
export function railTab(chosen: StatusTab, terminalHere: boolean, preview: { open: boolean; tab: PreviewTab }): RailTab {
  if (preview.open) return preview.tab;
  if (terminalHere) return "terminal";
  return chosen;
}

export const isPreviewTab = (tab: RailTab): tab is PreviewTab => tab === "browser" || tab === "simulator";

/**
 * How wide the panel may be dragged, given the room it shares with the chat: never narrower
 * than `min`, and never so wide the chat gets less than its floor.
 */
export function clampRailWidth(wanted: number, room: number, min: number): number {
  return Math.round(Math.max(min, Math.min(wanted, room - MIN_CHAT_WIDTH)));
}
