import { UserRound } from "lucide-react";
import { SelectField } from "../../design";
import { useAgents } from "../../stores/agents";

const NOBODY = "";

interface AgentPickerProps {
  /** Who'll do it; null for nobody yet. */
  value: string | null;
  onChange: (agentId: string | null) => void;
  /** Says what's being assigned, for screen readers. */
  label: string;
  disabled?: boolean;
  hideLabel?: boolean;
  className?: string;
}

/** Who'll do a to-do: nobody, or an agent on the team. */
export default function AgentPicker({ value, onChange, label, disabled, hideLabel = true, className }: AgentPickerProps) {
  const agents = useAgents((s) => s.agents);
  const options = [{ value: NOBODY, label: "Nobody" }, ...agents.map((a) => ({ value: a.id, label: a.name }))];
  return (
    <SelectField
      label={label}
      hideLabel={hideLabel}
      icon={UserRound}
      value={value ?? NOBODY}
      options={options}
      disabled={disabled}
      onChange={(next) => onChange(next === NOBODY ? null : next)}
      className={className}
    />
  );
}
