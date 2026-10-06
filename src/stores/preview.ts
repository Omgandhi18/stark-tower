// The preview beside a conversation: the built-in browser and the iOS Simulator.
import { create } from "zustand";
import type { BrowserPage } from "../lib/types";

export type PreviewTab = "browser" | "simulator";

const WIDTH_KEY = "starkline.preview.width";
export const MIN_WIDTH = 360;
const MAX_DEFAULT_WIDTH = 560;
/** Until it's been dragged, the preview takes this share of the window. */
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
  open: boolean;
  tab: PreviewTab;
  width: number;
  /** The browser's page, as the backend last reported it. */
  page: BrowserPage;
  /** The simulator on show; null for the first one running. */
  simulator: string | null;
  show: (tab: PreviewTab) => void;
  toggle: () => void;
  close: () => void;
  setTab: (tab: PreviewTab) => void;
  setWidth: (width: number) => void;
  applyPage: (page: BrowserPage) => void;
  showSimulator: (udid: string | null) => void;
}

export const usePreview = create<PreviewState>((set) => ({
  open: false,
  tab: "browser",
  width: savedWidth(),
  page: { url: "", title: "", loading: false },
  simulator: null,
  show: (tab) => set({ open: true, tab }),
  toggle: () => set((s) => ({ open: !s.open })),
  close: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
  setWidth: (width) => {
    try {
      window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
    } catch {
      // Not saved; it still applies now.
    }
    set({ width });
  },
  applyPage: (page) => set({ page }),
  showSimulator: (simulator) => set({ simulator }),
}));
