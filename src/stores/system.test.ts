import { describe, expect, it } from "vitest";
import type { EngineHealth, RuntimeHealth } from "../lib/types";
import { runtimeStatus } from "./system";

const claude: EngineHealth = {
  id: "claude-code",
  label: "Claude Code",
  kind: "claude-code",
  enabled: true,
  installed: true,
  path: "/bin/claude",
  version: "2.1.289",
  signIn: { signedIn: true, detail: "Claude account" },
};

const health = (over: Partial<RuntimeHealth> = {}): RuntimeHealth => ({
  host: "app",
  engines: [claude],
  dataStore: true,
  bridge: true,
  bridgeError: null,
  liveSessions: 0,
  node: "v22.11.0",
  nodePath: "/opt/homebrew/bin/node",
  shellPath: { shell: "/bin/zsh", read: true, error: null, elapsedMs: 640, added: 12, readAt: 0, reading: false },
  background: true,
  ...over,
});

const used = new Set(["claude-code"]);

describe("the runtime status says what's wrong, in words", () => {
  it("is ready when agents can run", () => {
    expect(runtimeStatus(health(), used).label).toBe("Ready");
    expect(runtimeStatus(null, used).label).toBe("Checking…");
  });

  it("counts Node.js as there once found, before its version is known", () => {
    expect(runtimeStatus(health({ node: null }), used).label).toBe("Ready");
    expect(runtimeStatus(health({ node: null, nodePath: null }), used)).toMatchObject({ label: "Node.js missing", tone: "danger" });
  });

  it("names the most serious problem first", () => {
    expect(runtimeStatus(health({ dataStore: false, bridge: false }), used).label).toBe("Storage problem");
    expect(runtimeStatus(health({ bridge: false }), used).label).toBe("Bridge offline");
    expect(runtimeStatus(health({ engines: [{ ...claude, installed: false }] }), used).label).toBe("Needs setup");
  });

  it("asks for sign-in only for providers someone runs on", () => {
    const signedOut = { ...claude, signIn: { signedIn: false, detail: null } };
    expect(runtimeStatus(health({ engines: [signedOut] }), used)).toMatchObject({
      label: "Sign-in needed",
      detail: "Claude Code isn't signed in, so agents on it can't work.",
    });
    expect(runtimeStatus(health({ engines: [signedOut] }), new Set(["codex"])).label).toBe("Ready");
  });
});
