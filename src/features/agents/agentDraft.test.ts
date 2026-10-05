import { describe, expect, it } from "vitest";
import type { AgentConfig, AppConfig } from "../../lib/types";
import { isDirty, newAgentConfig, validateAgent } from "./agentDraft";

const agent = (over: Partial<AgentConfig>): AgentConfig => ({
  id: "friday",
  name: "FRIDAY",
  role: "Full-stack",
  kind: "worker",
  accent: "#4fd0ff",
  figure: "engineer",
  engine: "claude-code",
  model: "",
  personality: "",
  home_x: 2,
  home_y: 13,
  enabled: true,
  ...over,
});

const config: AppConfig = {
  engines: [
    { id: "codex", label: "Codex", kind: "codex", command: "codex", enabled: false },
    { id: "claude-code", label: "Claude Code", kind: "claude-code", command: "claude", enabled: true },
  ],
  agents: [agent({}), agent({ id: "jarvis", name: "JARVIS", kind: "orchestrator", figure: "commander", home_x: 5, accent: "#7cf5c4" })],
};

describe("newAgentConfig", () => {
  it("picks an unused look, colour and desk on an enabled provider", () => {
    const created = newAgentConfig(config, 1_700_000_000_000);
    expect(created.id).toBe("agent-loyw3v28");
    expect(created.engine).toBe("claude-code");
    expect(created.figure).toBe("architect");
    expect(created.accent).toBe("#ffd166");
    expect([created.home_x, created.home_y]).toEqual([11, 13]);
  });
});

describe("validateAgent", () => {
  it("needs a unique name", () => {
    expect(validateAgent(agent({ name: "  " }), config).name).toBe("Give the agent a name.");
    expect(validateAgent(agent({ name: "jarvis" }), config).name).toBe("Another agent already has this name.");
    expect(validateAgent(agent({}), config)).toEqual({});
  });

  it("checks the colour and provider", () => {
    expect(validateAgent(agent({ accent: "teal" }), config).accent).toBeDefined();
    expect(validateAgent(agent({ engine: "gone" }), config).engine).toBe("Choose a provider.");
  });
});

describe("isDirty", () => {
  it("compares with the saved agent", () => {
    expect(isDirty(agent({}), agent({}))).toBe(false);
    expect(isDirty(agent({ role: "Backend" }), agent({}))).toBe(true);
    expect(isDirty(agent({}), undefined)).toBe(true);
  });

  it("compares the tone dials by their values", () => {
    const tone = { humour: 2, sarcasm: 3, formality: 4, enthusiasm: 1, detail: 1 };
    expect(isDirty(agent({ tone: { ...tone } }), agent({ tone }))).toBe(false);
    expect(isDirty(agent({ tone: { ...tone, humour: 3 } }), agent({ tone }))).toBe(true);
  });

  it("counts helper settings, with unset meaning on", () => {
    expect(isDirty(agent({ helpers: false }), agent({}))).toBe(true);
    expect(isDirty(agent({ helpers: true }), agent({}))).toBe(false);
    expect(isDirty(agent({ helper_model: "haiku" }), agent({}))).toBe(true);
  });
});
