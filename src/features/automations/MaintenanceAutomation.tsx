import { useState } from "react";
import { Bug as BugIcon, CircleCheck, Wrench } from "lucide-react";
import { Button, EmptyState, OverflowMenu, Tag, ICON_SIZE, ICON_STROKE } from "../../design";
import { runMaintenance, setBugStatus } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import AutomationCard from "./AutomationCard";
import { BUG_STATUS, bugCounts, nextStatuses, presentBugStatus } from "./bugs";

const CLOCK_MS = 60_000;

/** Bugs agents reported in Starkline itself, and the maintenance agent that fixes them. */
export default function MaintenanceAutomation() {
  const bugs = useWorkspace((s) => s.bugs);
  const loaded = useWorkspace((s) => s.loaded.bugs);
  const agents = useAgents((s) => s.agents);
  const openConversation = useNavigation((s) => s.openConversation);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const now = useNow(CLOCK_MS);
  const maintainer = agents.find((a) => a.kind === "maintenance");
  const counts = bugCounts(bugs);
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id;

  const fixAll = async () => {
    setStarting(true);
    setError(null);
    try {
      await runMaintenance();
      if (maintainer) openConversation(maintainer.id);
    } catch (e) {
      setError(errorMessage(e, "The maintenance run couldn't start."));
    } finally {
      setStarting(false);
    }
  };

  const status = counts.fixing > 0 ? `Fixing ${counts.fixing}` : counts.open > 0 ? `${counts.open} open` : "No open bugs";

  return (
    <AutomationCard
      icon={Wrench}
      title="App maintenance"
      description={`When an agent runs into a bug in Starkline itself, it files it here. ${maintainer?.name ?? "The maintenance agent"} can work through the open ones in the Starkline source folder.`}
      status={status}
      active={counts.open + counts.fixing > 0}
      error={error}
    >
      <div className="maintenance-bar">
        <Button variant="primary" icon={Wrench} disabled={starting || counts.open === 0 || !maintainer} onClick={fixAll}>
          {counts.open > 0 ? `Fix ${counts.open} open ${counts.open === 1 ? "bug" : "bugs"}` : "Fix open bugs"}
        </Button>
        {!maintainer && <span className="maintenance-note">Add a maintenance agent on Agents to fix bugs.</span>}
      </div>
      {loaded && bugs.length === 0 ? (
        <EmptyState compact icon={CircleCheck} title="No bugs reported" body="Agents file bugs here when Starkline gets in their way." />
      ) : (
        <ul className="bug-list">
          {bugs.map((bug) => {
            const presentation = presentBugStatus(bug.status);
            return (
              <li key={bug.id} className="bug-row">
                <BugIcon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="bug-icon" />
                <div className="bug-text">
                  <span className="bug-title">{bug.title}</span>
                  {bug.detail && <span className="bug-detail">{bug.detail}</span>}
                  <span className="bug-meta">
                    Reported by {nameOf(bug.reporter)}, {formatRelative(bug.created, now)}
                  </span>
                </div>
                <Tag tone={presentation.tone}>{presentation.label}</Tag>
                <OverflowMenu
                  label={`Change status of ${bug.title}`}
                  items={nextStatuses(bug.status).map((s) => ({
                    id: s,
                    label: BUG_STATUS[s].action,
                    onSelect: () => {
                      setBugStatus(bug.id, s).catch((e) => setError(errorMessage(e, "The bug couldn't be updated.")));
                    },
                  }))}
                />
              </li>
            );
          })}
        </ul>
      )}
    </AutomationCard>
  );
}
