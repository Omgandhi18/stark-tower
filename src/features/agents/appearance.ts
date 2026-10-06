// How an agent can look. Each figure has a portrait and a station in the room,
// so picking one also decides where the agent sits. The helper bot (DUM-E's
// look) has a portrait but no desk: it suits a maintenance agent.
export interface FigureOption {
  id: string;
  label: string;
}

export const FIGURES: readonly FigureOption[] = [
  { id: "commander", label: "Commander" },
  { id: "architect", label: "Architect" },
  { id: "engineer", label: "Engineer" },
  { id: "recon", label: "Recon" },
  { id: "specialist", label: "Specialist" },
  { id: "operative", label: "Operative" },
  { id: "helperbot", label: "Helper bot" },
];

/** Personal colours: the portrait ring, initials and the agent's marks in the room. */
export const ACCENTS: readonly string[] = ["#4fd0ff", "#7cf5c4", "#ffd166", "#ff9e64", "#ff6b78", "#e86b9a", "#c08cff", "#8ab4ff", "#9aa7b2"];

export const isHexColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);
