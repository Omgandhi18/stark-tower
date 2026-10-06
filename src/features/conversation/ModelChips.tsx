import { Box, ChevronDown, Gauge, type LucideIcon } from "lucide-react";
import { ICON_SIZE, ICON_STROKE, Popover, type PopoverTriggerProps } from "../../design";
import { useConfig } from "../../stores/config";
import { useSystem } from "../../stores/system";
import EffortSlider from "../agents/EffortSlider";
import { ModelMenu } from "../agents/ModelPicker";
import { defaultChoice, effortFor, effortLabel, effortLevels, findModel, nearestLevel, runningModel } from "../agents/modelSettings";
import { useProviderModels } from "../agents/useProviderModels";
import { saveQuickSettings } from "./quickSettings";

interface ChipProps {
  trigger: PopoverTriggerProps;
  icon: LucideIcon;
  text: string;
  /** What it changes ("FRIDAY's model"). */
  title: string;
}

function Chip({ trigger, icon: Icon, text, title }: ChipProps) {
  return (
    <button {...trigger} type="button" className="composer-chip" aria-haspopup="dialog" title={title}>
      <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
      <span className="composer-chip-text">{text}</span>
      <ChevronDown aria-hidden className="composer-chip-chevron" size={12} strokeWidth={ICON_STROKE} />
    </button>
  );
}

/** The agent's model and effort under its message box, each changed in place. */
export default function ModelChips({ agentId, agentName }: { agentId: string; agentName: string }) {
  const agent = useConfig((s) => s.config?.agents.find((a) => a.id === agentId));
  const engine = useConfig((s) => s.config?.engines.find((e) => e.id === agent?.engine));
  const installed = useSystem((s) => s.health?.engines.find((h) => h.id === engine?.id)?.installed === true);
  const list = useProviderModels(engine?.id, installed);
  if (!agent || !engine) return null;

  const models = list?.models ?? [];
  const model = agent.model ?? "";
  const effort = agent.effort ?? "";
  const engineModel = engine.model ?? "";
  const running = runningModel(models, model, engineModel);
  const levels = effortLevels(models, running);
  const usual = running?.default_effort ?? null;
  const fallback = defaultChoice(models, engineModel, engine.label);
  const modelText = model ? (findModel(models, model)?.name ?? model) : fallback.name === "Default" ? "Default model" : fallback.name;
  const effortText = `${effortLabel(effort ? nearestLevel(levels, effort) || effort : (usual ?? ""))} effort`;
  const status = !installed ? `${engine.label} isn't installed here.` : !list ? `Loading ${engine.label}'s models…` : list.error;
  const note = <p className="chip-popover-note">Applies from {agentName}'s next message.</p>;

  return (
    <>
      <Popover label={`Model for ${agentName}`} className="chip-popover model-popover" trigger={(p) => <Chip trigger={p} icon={Box} text={modelText} title={`${agentName}'s model`} />}>
        {(close) => (
          <>
            <ModelMenu
              models={models}
              value={model}
              fallback={fallback}
              status={status}
              label={`Models for ${agentName}`}
              onPick={(id) => {
                close();
                if (id !== model) void saveQuickSettings(agentId, { model: id, effort: effortFor(runningModel(models, id, engineModel), effort) });
              }}
            />
            {note}
          </>
        )}
      </Popover>
      {levels.length > 1 && (
        <Popover
          label={`Effort for ${agentName}`}
          className="chip-popover effort-popover"
          trigger={(p) => <Chip trigger={p} icon={Gauge} text={effortText} title={`How hard ${agentName} thinks`} />}
        >
          {() => (
            <>
              <EffortSlider
                levels={levels}
                defaultLevel={usual}
                value={effort}
                modelName={running?.name ?? modelText}
                onChange={(level) => void saveQuickSettings(agentId, { effort: level })}
              />
              {note}
            </>
          )}
        </Popover>
      )}
    </>
  );
}
