import { useEffect } from "react";
import { useAutoMode } from "../../stores/autoMode";

/** What auto mode does, in the same words wherever it's offered. */
export const AUTO_MODE_GOES_AHEAD =
  "What would ask you goes ahead on its own: installs, branches, the network, files outside the project, commands Starkline doesn't recognise and the rest.";
export const AUTO_MODE_STILL_ASKS =
  "Still asks first: committing, pushing or publishing, deleting branches, discarding changes, acting outside this Mac, destructive commands and changes to Starkline's safeguards.";
export const AUTO_MODE_REACH = "Covers this conversation and the work delegated from it.";

/** A conversation's auto mode: undefined until it's been read, then kept current by the backend's events. */
export function useAutoModeOf(conversationId: number | null): boolean | undefined {
  const on = useAutoMode((s) => (conversationId === null ? undefined : s.on[conversationId]));
  useEffect(() => {
    if (conversationId !== null && on === undefined) useAutoMode.getState().load(conversationId).catch(() => undefined);
  }, [conversationId, on]);
  return on;
}
