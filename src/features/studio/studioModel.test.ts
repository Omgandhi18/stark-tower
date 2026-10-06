import { describe, expect, it } from "vitest";
import { CHOICES, choicesValid, initialChoices, complete, drawing } from "./studioModel";
import type { Look } from "../../lib/bindings";
describe("Studio choices", () => {
  it("keeps features until explicitly chosen and carries the personal accent", () => {
    const choices = initialChoices({ figure: "recon", accent: "#7CF5C4" });
    expect(choices).toEqual({ figure: "recon", options: { "personal accent": "#7cf5c4" }, note: "" });
    expect(choicesValid(choices)).toBe(true);
    for (const group of CHOICES) for (const value of group.values) expect(choicesValid({ ...choices, options: { [group.field]: value } })).toBe(true);
  });
  it("validates the note, figure and controlled options", () => {
    const choices = initialChoices({});
    expect(choicesValid({ ...choices, note: "🧑".repeat(120) })).toBe(true);
    expect(choicesValid({ ...choices, note: "x".repeat(121) })).toBe(false);
    expect(choicesValid({ ...choices, figure: "../escape" })).toBe(false);
    expect(choicesValid({ ...choices, options: { glasses: "invented" } })).toBe(false);
    expect(choicesValid({ ...choices, options: { unknown: "none" } })).toBe(false);
  });
  it("waits for all themes, including a retried theme", () => {
    const look: Look = {
      id: "look-test",
      choices: initialChoices({}),
      paths: {},
      errors: {},
      revision: 1,
      saved: false,
      progress: { own: "ready", "studio-office": "drawing", "mori-cafe": "ready" },
    };
    expect(drawing(look)).toBe(true);
    expect(complete(look)).toBe(false);
    look.progress["studio-office"] = "failed";
    expect(drawing(look)).toBe(false);
    expect(complete(look)).toBe(false);
    look.progress["studio-office"] = "ready";
    expect(complete(look)).toBe(true);
    expect(complete(null)).toBe(false);
  });
});
