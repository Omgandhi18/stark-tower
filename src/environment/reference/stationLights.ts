// What a station's light says about its agent: the screens glow while it
// works, and amber light pools under it while it waits on the developer.
import type { Agent } from "../../lib/types";
import type { StationLight } from "./referenceRenderer";

const WORKING: readonly string[] = ["working", "thinking"];

/** Waiting on the developer (a question, an approval, a review) outranks working. */
export function lightFor(agent: Pick<Agent, "status">, waitingOnYou = false): StationLight | undefined {
  if (waitingOnYou || agent.status === "blocked") return "waiting";
  if (WORKING.includes(agent.status)) return "working";
  return undefined;
}
