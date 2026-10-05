import { useState } from "react";
import { CalendarClock } from "lucide-react";
import { SelectField, Toggle } from "../../design";
import { setStandupMinutes } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useAgents, selectOrchestrator } from "../../stores/agents";
import { useConfig } from "../../stores/config";
import AutomationCard from "./AutomationCard";
import { standupLabel as label } from "./builtIns";

const INTERVALS = [15, 30, 60, 120] as const;
const DEFAULT_INTERVAL = 30;

/** The orchestrator reviews the board on a schedule while its session is open. */
export default function StandupAutomation() {
  const config = useConfig((s) => s.config);
  const apply = useConfig((s) => s.apply);
  const orchestrator = useAgents(selectOrchestrator);
  const [error, setError] = useState<string | null>(null);
  const minutes = config?.standup_minutes ?? 0;
  const name = orchestrator?.name ?? "The orchestrator";

  const set = async (next: number) => {
    setError(null);
    try {
      apply(await setStandupMinutes(next));
    } catch (e) {
      setError(errorMessage(e, "The schedule couldn't be saved."));
    }
  };

  return (
    <AutomationCard
      icon={CalendarClock}
      title="Standup check-ins"
      description={`${name} reviews running work on a schedule: it re-engages stalled agents, closes finished tasks and tells you if anything needs you. It never starts new work on its own.`}
      status={minutes > 0 ? label(minutes) : "Off"}
      active={minutes > 0}
      error={error}
      footnote={`Runs only while ${name}'s session is open, so closing Starkline or stopping the chat pauses it.`}
    >
      <Toggle label="Run check-ins" checked={minutes > 0} disabled={!config} onChange={(on) => void set(on ? DEFAULT_INTERVAL : 0)} />
      {minutes > 0 && (
        <SelectField
          label="How often"
          value={String(minutes)}
          options={INTERVALS.map((m) => ({ value: String(m), label: label(m) }))}
          onChange={(value) => void set(Number(value))}
          className="automation-select"
        />
      )}
    </AutomationCard>
  );
}
