import { useEffect, useMemo, useState } from "react";
import { themeInfo, useActiveTheme } from "../../app/theme";
import { hasRoom, roomFor } from "../../environment/reference/rooms";
import { useActivity } from "../../stores/activity";
import { useAgents } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import EnvironmentView, { type DisplayMode } from "./EnvironmentView";

interface EnvironmentScreenProps {
  /** Dev fidelity check in progress: show exactly what the mockup shows. */
  comparing?: boolean;
}

/** The team at work in the room. Click anyone to talk to them where they stand. */
export default function EnvironmentScreen({ comparing = false }: EnvironmentScreenProps) {
  const agents = useAgents((s) => s.agents);
  const helpers = useActivity((s) => s.helpers);
  const pending = useAttention((s) => s.pending);
  const waitingOnYou = useMemo(() => new Set(pending.map((r) => r.agentId)), [pending]);
  const focusId = useNavigation((s) => s.agentId);
  const focusAgent = useNavigation((s) => s.focusAgent);
  const [mode, setMode] = useState<DisplayMode>("live");
  const activeTheme = useActiveTheme();
  const room = roomFor(activeTheme);
  // Until a theme's own room is built, its team works in After Hours R&D; say so rather than pretend.
  const notice = hasRoom(activeTheme) ? undefined : `The ${themeInfo(activeTheme).name} room isn't built yet, so your team works in After Hours R&D.`;

  // Dev builds: ⌥R flips between live agents and the mockup's reference state.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== "KeyR") return;
      e.preventDefault();
      setMode((m) => (m === "live" ? "reference" : "live"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <EnvironmentView
      key={room.id}
      room={room}
      agents={agents}
      helpers={helpers}
      waitingOnYou={waitingOnYou}
      awaitingYou={pending.length}
      mode={comparing ? "reference" : mode}
      focusId={focusId}
      onSelectAgent={focusAgent}
      notice={notice}
    />
  );
}
