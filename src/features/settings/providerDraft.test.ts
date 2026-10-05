import { describe, expect, it } from "vitest";
import type { AppConfig, EngineConfig } from "../../lib/types";
import { apiKeyOf, canRemoveProvider, installSummary, signInSummary, validateProvider, withApiKey } from "./providerDraft";

const engine: EngineConfig = { id: "claude-code", label: "Claude Code", kind: "claude-code", command: "claude", enabled: true };

describe("provider drafts", () => {
  it("sets and clears the API key under the provider's variable", () => {
    const keyed = withApiKey(engine, "sk-test");
    expect(keyed.auth?.env).toEqual({ ANTHROPIC_API_KEY: "sk-test" });
    expect(apiKeyOf(keyed)).toBe("sk-test");
    expect(withApiKey(keyed, "").auth?.env).toEqual({});
  });

  it("needs a name and a command", () => {
    expect(validateProvider({ ...engine, label: " ", command: "" })).toEqual({
      label: "Give the provider a name.",
      command: "Enter the command that starts it.",
    });
  });

  it("keeps built-in and in-use providers", () => {
    const custom = { ...engine, id: "local-llm" };
    const config: AppConfig = { engines: [engine, custom], agents: [] };
    expect(canRemoveProvider(engine, config)).toBe(false);
    expect(canRemoveProvider(custom, config)).toBe(true);
  });

  it("summarises whether the CLI is installed", () => {
    expect(installSummary(undefined)).toBe("Checking");
    expect(installSummary({ id: "x", label: "X", kind: "x", enabled: true, installed: true, path: "/bin/x", version: "2.1.3", signIn: null })).toBe(
      "Installed, 2.1.3",
    );
    expect(installSummary({ id: "x", label: "X", kind: "x", enabled: true, installed: false, path: null, version: null, signIn: null })).toBe(
      "Not found on this Mac",
    );
  });

  it("says whether the CLI is signed in, as it reports", () => {
    const installed = { id: "codex", label: "Codex", kind: "codex", enabled: true, installed: true, path: "/bin/codex", version: "0.148.0" };
    expect(signInSummary({ ...installed, signIn: null })).toBe("Checking");
    expect(signInSummary({ ...installed, signIn: { signedIn: true, detail: "ChatGPT" } })).toBe("Signed in · ChatGPT");
    expect(signInSummary({ ...installed, signIn: { signedIn: false, detail: null } })).toBe("Not signed in");
    expect(signInSummary({ ...installed, installed: false, signIn: null })).toBe("");
  });
});
