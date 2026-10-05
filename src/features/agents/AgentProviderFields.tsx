import { useEffect, useId, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button, InlineCode, SelectField, TextField, Toggle, cx } from "../../design";
import { providerCapabilities, providerModels } from "../../lib/api";
import { signInCommandFor } from "../../lib/engines";
import { errorMessage } from "../../lib/errors";
import type { AgentConfig, AppConfig, ModelChoice } from "../../lib/types";
import { useOnce } from "../../lib/useOnce";
import { useNavigation } from "../../stores/navigation";
import { useSystem } from "../../stores/system";
import { installSummary, signInSummary } from "../settings/providerDraft";
import CapabilityMatrix from "./CapabilityMatrix";
import type { AgentProblems } from "./agentDraft";

interface AgentProviderFieldsProps {
  draft: AgentConfig;
  saved: AgentConfig;
  config: AppConfig;
  problems: AgentProblems;
  set: <K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) => void;
}

interface ModelList {
  engine: string;
  models: ModelChoice[] | null;
  error: string | null;
}

/** The models an installed provider offers, as it lists them; asked again when the provider changes. */
function useModels(engineId: string | undefined, installed: boolean): ModelList | null {
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    if (!engineId || !installed) return;
    let live = true;
    providerModels(engineId).then(
      (models) => live && setList({ engine: engineId, models, error: null }),
      (e) => live && setList({ engine: engineId, models: null, error: errorMessage(e, "The provider didn't list its models.") }),
    );
    return () => {
      live = false;
    };
  }, [engineId, installed]);
  return list?.engine === engineId ? list : null;
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
  const modelList = useModels(engine?.id, engineHealth?.installed === true);
  const listId = useId();
  const label = engine?.label ?? "the provider";
  const modelHelper = !engineHealth?.installed
    ? `Leave empty to use ${label}'s own default.`
    : !modelList
      ? `Loading ${label}'s models…`
      : modelList.error
        ? modelList.error
        : `${modelList.models?.length ?? 0} models from ${label}. Leave empty to use the default in ${label}'s own settings.`;

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
          <SelectField label="Runs on" value={draft.engine ?? ""} options={engineOptions} error={problems.engine} onChange={(value) => set("engine", value)} />
          <TextField
            label="Model"
            value={draft.model ?? ""}
            placeholder={engine?.model ? `Provider default (${engine.model})` : "Provider default"}
            spellCheck={false}
            autoComplete="off"
            list={listId}
            helper={modelHelper}
            onChange={(e) => set("model", e.target.value)}
          />
          <datalist id={listId}>
            {(modelList?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.name === m.id ? (m.default ? "Default" : "") : `${m.name}${m.default ? ", default" : ""}`}
              </option>
            ))}
          </datalist>
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
          <TextField
            label="Helper model"
            value={draft.helper_model ?? ""}
            placeholder="Claude Code's choice"
            helper="A smaller model keeps side work quick and cheap."
            spellCheck={false}
            onChange={(e) => set("helper_model", e.target.value)}
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
