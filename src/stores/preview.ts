// The built-in browser and the iOS Simulator, shown in a task's side panel, which you and the agents share.
import { create } from "zustand";
import type { BrowserPage, BrowserTabs } from "../lib/types";

import type { BrowserSize } from "../features/preview/browserModel";

export type PreviewTab = "browser" | "simulator";

const NO_PAGE: BrowserPage = { url: "", title: "", loading: false, favicon: "" };

const WIDTH_KEY = "starkline.preview.width";
export const MIN_WIDTH = 360;
const MAX_DEFAULT_WIDTH = 560;
/** Until it's been dragged, the side panel takes this share of the window while it shows one. */
const DEFAULT_SHARE = 0.36;

const defaultWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_DEFAULT_WIDTH, Math.round(window.innerWidth * DEFAULT_SHARE)));

const savedWidth = () => {
  try {
    const n = Number(window.localStorage.getItem(WIDTH_KEY));
    return n && Number.isFinite(n) && n >= MIN_WIDTH ? n : defaultWidth();
  } catch {
    return defaultWidth();
  }
};

interface PreviewState {
  /** One of them is showing (in the side panel of the task on screen). */
  open: boolean;
  tab: PreviewTab;
  /** The side panel's width while it shows one. */
  width: number;
  /** The browser's tabs, as the backend last reported them. */
  tabs: BrowserTabs;
  /** The page in the tab showing (empty when there is none). */
  page: BrowserPage;
  /** The simulator on show; null for the first one running. */
  simulator: string | null;
  size: BrowserSize;
  setSize: (size: BrowserSize) => void;
  show: (tab: PreviewTab) => void;
  close: () => void;
  setWidth: (width: number) => void;
  applyTabs: (tabs: BrowserTabs) => void;
  showSimulator: (udid: string | null) => void;
}

export const usePreview = create<PreviewState>((set) => ({
  open: false,
  tab: "browser",
  width: savedWidth(),
  tabs: { tabs: [], active: null },
  page: NO_PAGE,
  simulator: null,
  size: "fit",
  setSize: (size) => set({ size }),
  show: (tab) => set({ open: true, tab }),
  close: () => set({ open: false }),
  setWidth: (width) => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      // Not saved; it still applies now.
    }
    set({ width });
  },
  applyTabs: (tabs) => {
    const current = tabs.tabs.find((t) => t.id === tabs.active);
    set({ tabs, page: current ? { url: current.url, title: current.title, loading: current.loading, favicon: current.favicon } : NO_PAGE });
  },
  showSimulator: (simulator) => set({ simulator }),
}));
