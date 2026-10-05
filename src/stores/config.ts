// The editable configuration: engines (providers) and the roster.
import { create } from "zustand";
import type { AppConfig } from "../lib/types";

interface ConfigState {
  config: AppConfig | null;
  /** Set when the config could not be read, so screens can say why. */
  error: string | null;
  apply: (config: AppConfig) => void;
  fail: (message: string) => void;
}

export const useConfig = create<ConfigState>((set) => ({
  config: null,
  error: null,
  apply: (config) => set({ config, error: null }),
  fail: (message) => set({ error: message }),
}));
