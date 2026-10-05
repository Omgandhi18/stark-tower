/** The environment variable an engine kind reads its API key from. */
export function apiKeyNameFor(kind: string): string {
  switch (kind) {
    case "codex":
      return "OPENAI_API_KEY";
    case "opencode":
      return "OPENCODE_API_KEY";
    default:
      return "ANTHROPIC_API_KEY";
  }
}

/** What to run in Terminal to sign a provider's CLI in (Starkline never signs in for you). */
export function signInCommandFor(kind: string): string | null {
  switch (kind) {
    case "claude-code":
      return "claude auth login";
    case "codex":
      return "codex login";
    case "opencode":
      return "opencode auth login";
    default:
      return null;
  }
}
