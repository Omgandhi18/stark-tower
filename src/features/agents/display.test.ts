import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../lib/types";
import { engineLabel, providerLabel } from "./display";

const config: AppConfig = {
  engines: [{ id: "claude-code", label: "Claude Code", kind: "claude-code", command: "claude", model: "sonnet" }],
  agents: [
    { id: "friday", name: "FRIDAY", role: "", kind: "worker", engine: "claude-code", model: "opus", home_x: 0, home_y: 0 },
    { id: "karen", name: "KAREN", role: "", kind: "worker", engine: "claude-code", model: "", home_x: 0, home_y: 0 },
  ],
};

describe("provider labels", () => {
  it("names the provider, then the agent's model or the provider default", () => {
    expect(providerLabel("friday", "claude-code", config)).toBe("Claude Code · opus");
    expect(providerLabel("karen", "claude-code", config)).toBe("Claude Code · sonnet");
    expect(providerLabel("x", "codex", null)).toBe("codex");
    expect(engineLabel("claude-code", config)).toBe("Claude Code");
  });
});
