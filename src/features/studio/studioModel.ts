import { ACCENTS, FIGURES } from "../agents/appearance";
import type { Choices, Look } from "../../lib/bindings";

export const CHOICES: ReadonlyArray<{ field: string; values: readonly string[]; colours?: readonly string[] }> = [
  {
    field: "skin tone",
    values: ["porcelain", "fair", "sand", "olive", "brown", "deep brown"],
    colours: ["#f6dfd0", "#eac4a3", "#d8ae7e", "#b99065", "#895b3d", "#513427"],
  },
  { field: "hair style", values: ["short", "cropped", "long", "curly", "coily", "bun", "ponytail", "braids", "shaved", "bald"] },
  { field: "hair colour", values: ["black", "dark brown", "brown", "auburn", "blonde", "grey", "white", "your accent colour"] },
  { field: "facial hair", values: ["none", "stubble", "moustache", "beard"] },
  { field: "glasses", values: ["none", "round", "rectangular", "tech visor", "sunglasses"] },
  { field: "headwear", values: ["none", "headset", "earpiece", "headphones", "cap", "beanie"] },
  { field: "signature accessory", values: ["none", "scarf", "tie", "bow tie", "pendant", "ID badge", "pin in your accent colour"] },
  { field: "expression", values: ["calm", "smiling", "focused", "wry"] },
  { field: "personal accent", values: ACCENTS, colours: ACCENTS },
];
export const LOOK_THEMES = [
  { id: "own", name: "After Hours R&D" },
  { id: "studio-office", name: "Studio Office" },
  { id: "mori-cafe", name: "Mori Cafe" },
] as const;
export function initialChoices(agent: { figure?: string; accent?: string | null }): Choices {
  return {
    figure: agent.figure ?? "recon",
    options: ACCENTS.includes(agent.accent?.toLowerCase() ?? "") ? { "personal accent": agent.accent!.toLowerCase() } : {},
    note: "",
  };
}
export function choicesValid(choices: Choices): boolean {
  return (
    FIGURES.some((f) => f.id === choices.figure) &&
    Array.from(choices.note).length <= 120 &&
    Object.entries(choices.options).every(([field, value]) =>
      CHOICES.some((group) => group.field === field && typeof value === "string" && group.values.includes(value)),
    )
  );
}
export const drawing = (look: Look | null) => !!look && Object.values(look.progress).some((s) => s === "queued" || s === "drawing");
export const complete = (look: Look | null) => !!look && LOOK_THEMES.every((t) => look.progress[t.id] === "ready");
