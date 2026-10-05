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
