// The side panels you've collapsed to their rails: the sidebar, and a task's columns either side of its chat.
import { create } from "zustand";

export type PanelId = "sidebar" | "taskLeft" | "taskRight";
type Collapsed = Record<PanelId, boolean>;

const KEY = "starkline.panels.collapsed";
const NONE: Collapsed = { sidebar: false, taskLeft: false, taskRight: false };

function saved(): Collapsed {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Record<PanelId, unknown>>;
    return { sidebar: value.sidebar === true, taskLeft: value.taskLeft === true, taskRight: value.taskRight === true };
  } catch {
    return NONE;
  }
}

interface PanelsState {
  collapsed: Collapsed;
  setCollapsed: (panel: PanelId, collapsed: boolean) => void;
  toggle: (panel: PanelId) => void;
}

export const usePanels = create<PanelsState>((set, get) => {
  const apply = (collapsed: Collapsed) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(collapsed));
    } catch {
      // Without storage it still applies for as long as this window is open.
    }
    set({ collapsed });
  };
  return {
    collapsed: saved(),
    setCollapsed: (panel, value) => apply({ ...get().collapsed, [panel]: value }),
    toggle: (panel) => apply({ ...get().collapsed, [panel]: !get().collapsed[panel] }),
  };
});
