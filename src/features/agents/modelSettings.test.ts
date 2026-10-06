import { describe, expect, it } from "vitest";
import type { ModelChoice } from "../../lib/types";
import { defaultChoice, effortFor, effortLabel, effortLevels, modelRows, nearestLevel, runningModel } from "./modelSettings";

const model = (id: string, name: string, efforts: string[], extra: Partial<ModelChoice> = {}): ModelChoice => ({
  id,
  name,
  default: false,
  description: "",
  efforts,
  default_effort: null,
  older: false,
  ...extra,
});

const EVERY = ["low", "medium", "high", "xhigh", "max"];
const OPUS = model("claude-opus-5-5", "Opus 5.5", EVERY, { default_effort: "medium" });
const HAIKU = model("claude-haiku-4-5", "Haiku 4.5", []);
const OLD_OPUS = model("claude-opus-4-6", "Opus 4.6", ["low", "medium", "high", "max"], { older: true, default_effort: "high" });
const MODELS = [OPUS, HAIKU, OLD_OPUS];

describe("effort levels", () => {
  it("names levels as people say them", () => {
    expect(effortLabel("xhigh")).toBe("Extra high");
    expect(effortLabel("max")).toBe("Max");
    expect(effortLabel("minimal")).toBe("Minimal");
    expect(effortLabel("")).toBe("Default");
  });

  it("finds the nearest level a model takes, the lower one on a tie", () => {
    expect(nearestLevel(["low", "medium", "high", "max"], "xhigh")).toBe("high");
    expect(nearestLevel(["low", "medium", "high"], "max")).toBe("high");
    expect(nearestLevel(["medium", "high"], "minimal")).toBe("medium");
    expect(nearestLevel([], "high")).toBe("");
  });

  it("carries the effort over to a new model as closely as it can", () => {
    expect(effortFor(OLD_OPUS, "xhigh")).toBe("high");
    expect(effortFor(OPUS, "xhigh")).toBe("xhigh");
    expect(effortFor(HAIKU, "max")).toBe("");
    // The model's own default stays its own default, and nothing is known of an unlisted model.
    expect(effortFor(OPUS, "")).toBe("");
    expect(effortFor(undefined, "max")).toBe("max");
  });

  it("offers every level the provider's models take for a model it didn't list", () => {
    expect(effortLevels(MODELS, OLD_OPUS)).toEqual(["low", "medium", "high", "max"]);
    expect(effortLevels(MODELS, undefined)).toEqual(EVERY);
    expect(effortLevels([HAIKU], undefined)).toEqual([]);
  });
});

describe("the model an agent runs on", () => {
  it("is its own, else the provider's in Starkline, else the provider's default", () => {
    const codex = [model("gpt-5.6-sol", "GPT-5.6 Sol", ["low", "medium", "high"], { default: true }), model("gpt-5.5", "GPT-5.5", ["low"])];
    expect(runningModel(codex, "gpt-5.5", "")?.name).toBe("GPT-5.5");
    expect(runningModel(codex, "", "gpt-5.5")?.name).toBe("GPT-5.5");
    expect(runningModel(codex, "", "")?.name).toBe("GPT-5.6 Sol");
    expect(runningModel(MODELS, "", "")).toBeUndefined();
    expect(runningModel(MODELS, "claude-sonnet-4-5", "")).toBeUndefined();
  });

  it("names the default by what it runs on", () => {
    expect(defaultChoice(MODELS, "claude-opus-5-5", "Claude Code").name).toBe("Default (Opus 5.5)");
    expect(defaultChoice(MODELS, "", "Claude Code")).toEqual({ name: "Default", note: "Whatever Claude Code is set to use" });
    expect(defaultChoice([model("gpt-5.6-sol", "GPT-5.6 Sol", [], { default: true })], "", "Codex").name).toBe("Default (GPT-5.6 Sol)");
  });
});

describe("the model list", () => {
  const ids = (rows: ReturnType<typeof modelRows>) => rows.map((r) => (r.kind === "model" || r.kind === "custom" ? r.id : r.kind));

  it("puts the current models first and the older ones under More models", () => {
    expect(ids(modelRows(MODELS, "", "", false))).toEqual(["default", "claude-opus-5-5", "claude-haiku-4-5", "more"]);
    expect(ids(modelRows(MODELS, "", "", true))).toEqual(["default", "claude-opus-5-5", "claude-haiku-4-5", "more", "claude-opus-4-6"]);
  });

  it("keeps a model the provider didn't list where it can be seen", () => {
    expect(ids(modelRows(MODELS, "claude-sonnet-4-5", "", false))).toEqual(["default", "claude-sonnet-4-5", "claude-opus-5-5", "claude-haiku-4-5", "more"]);
  });

  it("searches names and IDs across every model, and offers what was typed as an ID", () => {
    expect(ids(modelRows(MODELS, "", "opus", false))).toEqual(["claude-opus-5-5", "claude-opus-4-6", "opus"]);
    expect(ids(modelRows(MODELS, "", "Opus 4", false))).toEqual(["claude-opus-4-6"]);
    expect(ids(modelRows(MODELS, "", "claude-haiku-4-5", false))).toEqual(["claude-haiku-4-5"]);
  });
});
