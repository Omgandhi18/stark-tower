import { Settings2 } from "lucide-react";
import { Button, InlineCode, SelectField, Toggle, cx } from "../../design";
import { providerCapabilities } from "../../lib/api";
import { signInCommandFor } from "../../lib/engines";
import type { AgentConfig, AppConfig } from "../../lib/types";
import { useOnce } from "../../lib/useOnce";
import { useNavigation } from "../../stores/navigation";
import { useSystem } from "../../stores/system";
import { installSummary, signInSummary } from "../settings/providerDraft";
import CapabilityMatrix from "./CapabilityMatrix";
import EffortSlider from "./EffortSlider";
import ModelPicker from "./ModelPicker";
import type { AgentProblems } from "./agentDraft";
import { defaultChoice, effortFor, effortLevels, runningModel } from "./modelSettings";
import { useProviderModels } from "./useProviderModels";

interface AgentProviderFieldsProps {
  draft: AgentConfig;
  saved: AgentConfig;
  config: AppConfig;
  problems: AgentProblems;
  set: <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => void;
}

/** What runs the agent: the provider and model, whether it's ready, and what it can do here. */
export default function AgentProviderFields({ draft, saved, config, problems, set }: AgentProviderFieldsProps) {
  const openSettings = useNavigation((s) => s.openSettings);
  const health = useSystem((s) => s.health);
  const providers = useOnce("provider-capabilities", providerCapabilities);
  const engine = config.engines.find((e) => e.id === draft.engine);
  const engineHealth = health?.engines.find((h) => h.id === draft.engine);
  const caps = providers?.find((p) => p.kind === engine?.kind);
  const name = draft.name.trim() || "This agent";
  const signInCommand = engine ? signInCommandFor(engine.kind) : null;
  const signedOut = engineHealth?.installed === true && engineHealth.signIn?.signedIn === false && (engine?.auth?.method ?? "cli-login") === "cli-login";
  const ready = engine?.enabled && engineHealth?.installed && engineHealth.signIn?.signedIn !== false;
  const helpersPossible = caps ? caps.helpers.support !== "no" : true;
  const installed = engineHealth?.installed === true;
  const modelList = useProviderModels(engine?.id, installed);
  const label = engine?.label ?? "the provider";
  const models = modelList?.models ?? [];
  const engineModel = engine?.model ?? "";
  const running = runningModel(models, draft.model ?? "", engineModel);
  const fallback = defaultChoice(models, engineModel, label);
  const listStatus = !installed ? `${label} isn't installed, so it can't list its models. You can still type a model ID.` : !modelList ? `Loading ${label}'s models…` : modelList.error;
  const modelHelper = !installed
    ? `Install ${label} to choose from its models.`
    : !modelList
      ? `Loading ${label}'s models…`
      : (modelList.error ?? `${models.length} models from ${label}.`);

  // A new model keeps the effort as closely as it can; a provider of another kind starts over.
  const pickModel = (id: string) => {
    set("model", id);
    set("effort", effortFor(runningModel(models, id, engineModel), draft.effort ?? ""));
  };
  const pickEngine = (id: string) => {
    set("engine", id);
    const kind = (engineId: string | undefined) => config.engines.find((e) => e.id === engineId)?.kind;
    if (kind(id) !== kind(draft.engine)) {
      set("model", "");
      set("effort", "");
      set("helper_model", "");
    }
  };

  const engineOptions = config.engines.map((e) => ({
    value: e.id,
    label: e.enabled ? e.label : `${e.label} (turned off)`,
    disabled: !e.enabled && e.id !== saved.engine,
  }));

  return (
    <>
      <fieldset className="form-section">
        <legend className="form-section-title">Provider</legend>
        <div className="form-grid">
          <SelectField label="Runs on" value={draft.engine ?? ""} options={engineOptions} error={problems.engine} onChange={pickEngine} />
          <ModelPicker label="Model" value={draft.model ?? ""} models={models} fallback={fallback} status={listStatus} helper={modelHelper} onChange={pickModel} />
          {modelList?.models && (
            <div className="agent-effort">
              <EffortSlider
                levels={effortLevels(models, running)}
                defaultLevel={running?.default_effort ?? null}
                value={draft.effort ?? ""}
                modelName={running?.name ?? (draft.model || "This model")}
                onChange={(level) => set("effort", level)}
              />
            </div>
          )}
        </div>
        <div className="agent-provider-status">
          <span className={cx("provider-dot", ready ? "tone-success" : engine?.enabled ? "tone-attention" : "tone-idle")} aria-hidden />
          <span>
            {engine?.enabled === false ? `${engine.label} is turned off` : installSummary(engineHealth)}
            {engine?.enabled !== false && signInSummary(engineHealth) && <> · {signInSummary(engineHealth)}</>}
          </span>
          <Button size="sm" variant="ghost" icon={Settings2} onClick={() => openSettings("providers")}>
            Provider settings
          </Button>
        </div>
        {signedOut && signInCommand && (
          <p className="agent-provider-hint" role="status">
            <InlineCode text={`${name} can't work until ${engine?.label} is signed in. Run \`${signInCommand}\` in Terminal.`} />
          </p>
        )}
      </fieldset>

      <fieldset className="form-section">
        <legend className="form-section-title">Temporary helpers</legend>
        <p className="form-section-note">
          {caps?.helpers.note ?? "Short-lived helpers the agent starts for side work, reporting back to it."}
          {helpersPossible && " They follow the same permissions."}
        </p>
        <Toggle
          label="Can start temporary helpers"
          checked={helpersPossible && (draft.helpers ?? true)}
          disabled={!helpersPossible}
          description={
            helpersPossible ? `Helpers report to ${name} and end when their work is done.` : `${engine?.label ?? "This provider"} has no helpers to turn on.`
          }
          onChange={(on) => set("helpers", on)}
        />
        {engine?.kind === "claude-code" && (draft.helpers ?? true) && (
          <ModelPicker
            label="Helper model"
            value={draft.helper_model ?? ""}
            models={models}
            fallback={{ name: "Claude Code's choice", note: "Claude Code picks a model for each helper" }}
            status={listStatus}
            helper="A smaller model keeps side work quick and cheap."
            onChange={(id) => set("helper_model", id)}
          />
        )}
      </fieldset>

      <section className="form-section" aria-labelledby={`capabilities-${saved.id}`}>
        <h3 id={`capabilities-${saved.id}`} className="form-section-title">
          How providers compare
        </h3>
        <p className="form-section-note">What Starkline can do with an agent on each provider, as built today.</p>
        {providers ? <CapabilityMatrix providers={providers} current={engine?.kind ?? ""} /> : <p className="form-section-note">Loading…</p>}
      </section>
    </>
  );
}
