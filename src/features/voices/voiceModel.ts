import type { Voice, VoiceSettings } from "../../lib/types";

export const VOICE_GROUPS = [
  {
    label: "American female",
    prefix: "af",
    description: "American woman",
    names: ["alloy", "aoede", "bella", "heart", "jessica", "kore", "nicole", "nova", "river", "sarah", "sky"],
  },
  { label: "American male", prefix: "am", description: "American man", names: ["adam", "echo", "eric", "fenrir", "liam", "michael", "onyx", "puck", "santa"] },
  { label: "British female", prefix: "bf", description: "British woman", names: ["alice", "emma", "isabella", "lily"] },
  { label: "British male", prefix: "bm", description: "British man", names: ["daniel", "fable", "george", "lewis"] },
].map((group) => ({
  ...group,
  options: group.names.map((name) => ({ value: `${group.prefix}_${name}`, label: `${name[0].toUpperCase()}${name.slice(1)}, ${group.description}` })),
}));

export function defaultVoice(id: string): Voice {
  const defaults: Record<string, [string, number, number]> = {
    jarvis: ["bm_george", 0.95, 0],
    friday: ["bf_emma", 1, 0],
    vision: ["am_michael", 0.9, 0],
    edith: ["af_bella", 1.08, 0],
    karen: ["af_heart", 1.05, 0],
    veronica: ["af_alloy", 1.05, 0],
    "dum-e": ["am_puck", 1.15, 4],
    dume: ["am_puck", 1.15, 4],
  };
  const [name, speed, pitch] = defaults[id] ?? ["af_heart", 1, 0];
  return { name, speed, pitch };
}
export const DEFAULT_VOICE_SETTINGS: Required<VoiceSettings> = {
  enabled: false,
  reminders: true,
  ready: true,
  needs_you: true,
  failures: true,
  replies: false,
  background_only: false,
  quiet_hours: false,
  quiet_from: "22:00",
  quiet_to: "08:00",
  volume: 0.7,
};
