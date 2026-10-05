// Who asked for a task: the developer ("you"), one of their automations
// ("automation:<id>"), or the agent that delegated it (its id). Matches the backend.
import type { Agent, Automation } from "./types";

export const BY_DEVELOPER = "you";
const AUTOMATION_PREFIX = "automation:";

/** The automation that started a task, if one did. */
export function automationOf(requestedBy: string): number | null {
  if (!requestedBy.startsWith(AUTOMATION_PREFIX)) return null;
  const id = Number(requestedBy.slice(AUTOMATION_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Work the developer asked for, themselves or on a schedule (not a delegation). */
export const askedByDeveloper = (requestedBy: string) => requestedBy === BY_DEVELOPER || automationOf(requestedBy) !== null;

/** "You", "Automation: Nightly review", or the delegating agent's name. */
export function requesterName(requestedBy: string, agents: readonly Agent[], automations: readonly Automation[]): string {
  if (requestedBy === BY_DEVELOPER) return "You";
  const automationId = automationOf(requestedBy);
  if (automationId !== null) {
    const name = automations.find((a) => a.id === automationId)?.name;
    return name ? `Automation: ${name}` : "An automation";
  }
  return agents.find((a) => a.id === requestedBy)?.name ?? requestedBy;
}
