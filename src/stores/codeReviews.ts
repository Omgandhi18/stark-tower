import { create } from "zustand";
import { codeReviews } from "../lib/api";
import type { CodeReviews } from "../lib/types";

export const useCodeReviews = create<CodeReviews & { apply: (value: CodeReviews) => void; refresh: () => Promise<void> }>((set) => ({
  items: [],
  connections: [],
  has_host: false,
  apply: (value) => set(value),
  refresh: async () => set(await codeReviews()),
}));
