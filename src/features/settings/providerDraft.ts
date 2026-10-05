// Editing a provider (engine) configuration.
import type { AppConfig, EngineConfig, EngineHealth } from "../../lib/types";
import { apiKeyNameFor } from "../../lib/engines";

export const AUTH_METHODS = [
  { value: "cli-login", label: "Use the CLI's own sign-in" },
  { value: "api-key-env", label: "API key" },
  { value: "none", label: "No sign-in" },
] as const;

/** Providers Starkline ships with; they can be turned off but not removed. */
export const BUILT_IN_PROVIDERS: readonly string[] = ["claude-code", "codex", "opencode"];

export const apiKeyOf = (engine: EngineConfig) => engine.auth?.env?.[apiKeyNameFor(engine.kind)] ?? "";

/** The same engine with its API key replaced (blank removes it). */
export function withApiKey(engine: EngineConfig, key: string): EngineConfig {
  const name = apiKeyNameFor(engine.kind);
  const env = { ...(engine.auth?.env ?? {}) };
  if (key) env[name] = key;
  else delete env[name];
  return { ...engine, auth: { ...engine.auth, env } };
}

export const withAuthMethod = (engine: EngineConfig, method: string): EngineConfig => ({
  ...engine,
  auth: { ...engine.auth, method },
});

export function isProviderDirty(draft: EngineConfig, saved: EngineConfig | undefined): boolean {
  return !saved || JSON.stringify(draft) !== JSON.stringify(saved);
}

export interface ProviderProblems {
  label?: string;
  command?: string;
}

export function validateProvider(draft: EngineConfig): ProviderProblems {
  const problems: ProviderProblems = {};
  if (!draft.label.trim()) problems.label = "Give the provider a name.";
  if (!draft.command.trim()) problems.command = "Enter the command that starts it.";
  return problems;
}

export const canRemoveProvider = (engine: EngineConfig, config: AppConfig) =>
  !BUILT_IN_PROVIDERS.includes(engine.id) && !config.agents.some((a) => a.engine === engine.id);

/** "Installed, 2.1.3", "Not found on this Mac", or "Checking". */
export function installSummary(health: EngineHealth | undefined): string {
  if (!health) return "Checking";
  if (!health.installed) return "Not found on this Mac";
  return health.version ? `Installed, ${health.version}` : "Installed";
}

/** "Signed in · ChatGPT", "Not signed in", or "Checking" while the CLI hasn't answered. */
export function signInSummary(health: EngineHealth | undefined): string {
  if (!health?.installed) return "";
  if (!health.signIn) return "Checking";
  if (!health.signIn.signedIn) return "Not signed in";
  return health.signIn.detail ? `Signed in · ${health.signIn.detail}` : "Signed in";
}
