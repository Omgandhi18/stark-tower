// The choices a list's settings offer: which project it's tied to, and what assigning does.
import type { ProjectInfo } from "../../lib/types";
import { START_MODES } from "./todoModel";

export const NO_PROJECT = "";

export const projectOptions = (projects: readonly ProjectInfo[]) => [
  { value: NO_PROJECT, label: "No project" },
  ...projects.map((p) => ({ value: p.path, label: p.name })),
];

export const startOptions = START_MODES.map((m) => ({ value: m.value, label: m.label }));

export const startHint = (mode: string) => START_MODES.find((m) => m.value === mode)?.hint ?? "";
