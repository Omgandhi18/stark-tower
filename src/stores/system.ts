// The app's own condition: what the agent runtime can do, whether this Mac is
// being kept awake, and whether a newer release exists.
import { create } from "zustand";
import { powerState, runtimeHealth, setKeepAwake } from "../lib/api";
import type { StateTone } from "../lib/status";
import type { PowerState, RuntimeHealth, UpdateStatus } from "../lib/types";

interface SystemState {
  health: RuntimeHealth | null;
  power: PowerState | null;
  update: UpdateStatus | null;
  refreshHealth: () => Promise<void>;
  refreshPower: () => Promise<void>;
  applyPower: (state: PowerState) => void;
  applyUpdate: (status: UpdateStatus) => void;
  /** Ask the backend to change the keep-awake permission. */
  toggleKeepAwake: (enabled: boolean) => Promise<void>;
}

export const useSystem = create<SystemState>((set) => ({
  health: null,
  power: null,
  update: null,
  refreshHealth: async () => set({ health: await runtimeHealth() }),
  refreshPower: async () => set({ power: await powerState() }),
  applyPower: (power) => set({ power }),
  applyUpdate: (update) => set({ update }),
  toggleKeepAwake: async (enabled) => set({ power: await setKeepAwake(enabled) }),
}));

/** The runtime's condition in a couple of words, and a sentence on what it means. */
export interface RuntimeStatus {
  label: string;
  tone: StateTone;
  detail: string;
}

const names = (list: readonly string[]) => (list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`);

/**
 * What stops agents working, most serious first. `usedEngines` are the
 * providers some enabled agent runs on: only their sign-in matters.
 */
export function runtimeStatus(health: RuntimeHealth | null, usedEngines: ReadonlySet<string>): RuntimeStatus {
  if (!health) return { label: "Checking…", tone: "idle", detail: "Starkline is checking what agents need to run." };
  if (!health.dataStore) return { label: "Storage problem", tone: "danger", detail: "Chats and tasks can't be saved right now." };
  if (!health.bridge) {
    return { label: "Bridge offline", tone: "danger", detail: "Agents can't delegate, ask you questions or ask for approval until it's back." };
  }
  // Node.js runs the bridge; it counts as there once found, even before its version is known.
  if (!health.nodePath) {
    return { label: "Node.js missing", tone: "danger", detail: "Agents need Node.js to delegate, ask you questions and ask for approval." };
  }
  if (!health.engines.some((e) => e.enabled && e.installed)) {
    return { label: "Needs setup", tone: "attention", detail: "Install a provider and turn it on so agents can run." };
  }
  const signedOut = health.engines.filter((e) => usedEngines.has(e.id) && e.installed && e.signIn?.signedIn === false).map((e) => e.label);
  if (signedOut.length) {
    return { label: "Sign-in needed", tone: "attention", detail: `${names(signedOut)} isn't signed in, so agents on it can't work.` };
  }
  return { label: "Ready", tone: "success", detail: "Agents can run, delegate, ask you questions and ask for approval." };
}
