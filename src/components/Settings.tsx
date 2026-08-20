import { useEffect, useMemo, useState } from "react";
import { X, Bot, Cpu, RotateCcw, Check, Shield, Plus, Trash2, Shuffle } from "lucide-react";
import type { AgentConfig, AppConfig, EngineConfig } from "../lib/types";
import { PALETTE, PRESETS, randomizeRecipe, serializeRecipe } from "../lib/charArt";
import CharacterPortrait from "./CharacterPortrait";
import { removeAgent, removeEngine, resetConfig, updateAgent, updateEngine } from "../lib/api";

interface Props {
  config: AppConfig;
  onConfig: (c: AppConfig) => void;
  onClose: () => void;
}

type Tab = "agents" | "engines";

const AUTH_METHODS = [
  { id: "cli-login", label: "CLI login (use what's signed in)" },
  { id: "api-key-env", label: "API key" },
  { id: "none", label: "None" },
];

// Free bullpen desk tiles a new agent can drop into (the ones the default
// roster doesn't occupy).
const DESKS: [number, number][] = [
  [2, 13], [5, 13], [11, 13], [14, 13],
  [2, 16], [5, 16], [8, 16], [11, 16], [14, 16],
];

export default function Settings({ config, onConfig, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("agents");

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div className="settings glass" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <div className="settings-title">
            <span className="settings-title-main">Configuration</span>
            <span className="settings-title-sub">
              Your roster and engines, bring your own AI or use ours
            </span>
          </div>
          <div className="settings-tabs">
            <button className={`seg ${tab === "agents" ? "on" : ""}`} onClick={() => setTab("agents")}>
              <Bot size={14} strokeWidth={2} /> Agents
            </button>
            <button className={`seg ${tab === "engines" ? "on" : ""}`} onClick={() => setTab("engines")}>
              <Cpu size={14} strokeWidth={2} /> Engines
            </button>
          </div>
          <button className="settings-x" onClick={onClose} title="Close">
            <X size={16} strokeWidth={2} />
          </button>
        </header>

        {tab === "agents" ? (
          <AgentsTab config={config} onConfig={onConfig} />
        ) : (
          <EnginesTab config={config} onConfig={onConfig} />
        )}

        <footer className="settings-foot">
          <button
            className="settings-reset"
            onClick={async () => {
              if (confirm("Restore the built-in engines and roster? This wipes your customizations.")) {
                onConfig(await resetConfig());
              }
            }}
          >
            <RotateCcw size={13} strokeWidth={2} /> Reset to defaults
          </button>
        </footer>
      </div>
    </div>
  );
}

// ---- Agents ----------------------------------------------------------------

function AgentsTab({ config, onConfig }: { config: AppConfig; onConfig: (c: AppConfig) => void }) {
  const [selId, setSelId] = useState(config.agents[0]?.id ?? "");
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [saved, setSaved] = useState(false);

  const current = useMemo(
    () => config.agents.find((a) => a.id === selId) ?? null,
    [config.agents, selId],
  );

  useEffect(() => {
    setDraft(current ? { ...current } : null);
    setSaved(false);
  }, [current]);

  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const dirty = draft && current && JSON.stringify(draft) !== JSON.stringify(current);

  const save = async () => {
    if (!draft) return;
    onConfig(await updateAgent(draft));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  const addAgent = async () => {
    const used = new Set(config.agents.map((a) => `${a.home_x},${a.home_y}`));
    const desk = DESKS.find((d) => !used.has(`${d[0]},${d[1]}`)) ?? [8, 8];
    const n = config.agents.filter((a) => a.kind === "worker").length;
    const agent: AgentConfig = {
      id: `agent-${Date.now().toString(36)}`,
      name: "New Agent",
      role: "Specialist",
      kind: "worker",
      accent: PALETTE[(n + 1) % PALETTE.length],
      figure: serializeRecipe(randomizeRecipe()),
      engine: config.engines.find((e) => e.enabled)?.id ?? "claude-code",
      model: "",
      personality: "",
      home_x: desk[0],
      home_y: desk[1],
      enabled: true,
    };
    onConfig(await updateAgent(agent));
    setSelId(agent.id);
  };

  const remove = async () => {
    if (!draft) return;
    onConfig(await removeAgent(draft.id));
    setSelId(config.agents.find((a) => a.id !== draft.id)?.id ?? "");
  };

  const engines = config.engines;

  return (
    <div className="settings-body">
      <aside className="settings-rail">
        {config.agents.map((a) => (
          <button
            key={a.id}
            className={`srow ${a.id === selId ? "on" : ""}`}
            onClick={() => setSelId(a.id)}
          >
            <span className="srow-face"><CharacterPortrait figure={a.figure} size={34} /></span>
            <span className="srow-main">
              <span className="srow-name">{a.name}</span>
              <span className="srow-sub">{a.role}</span>
            </span>
          </button>
        ))}
        <button className="srow-add" onClick={addAgent}>
          <Plus size={14} strokeWidth={2.5} /> Add agent
        </button>
      </aside>

      {draft ? (
        <div className="settings-form">
          {/* live preview */}
          <div className="agent-preview">
            <div className="agent-preview-stage" style={{ ["--accent" as string]: draft.accent }}>
              <span className="agent-preview-disc" />
              <CharacterPortrait figure={draft.figure} size={92} />
            </div>
            <div className="agent-preview-meta">
              <span className="agent-preview-name" style={{ color: draft.accent }}>
                {draft.name || "Unnamed"}
              </span>
              <span className="agent-preview-role">{draft.role || "No role"}</span>
              <span className="agent-preview-kind">{draft.kind}</span>
            </div>
          </div>

          <div className="frow two">
            <label className="field">
              <span className="field-l">Name</span>
              <input value={draft.name} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label className="field">
              <span className="field-l">Role</span>
              <input value={draft.role} onChange={(e) => set("role", e.target.value)} />
            </label>
          </div>

          <div className="field">
            <span className="field-l">
              Character
              <button
                type="button"
                className="char-random"
                onClick={() => set("figure", serializeRecipe(randomizeRecipe()))}
                title="Randomize a character"
              >
                <Shuffle size={11} strokeWidth={2} /> Randomize
              </button>
            </span>
            <div className="char-grid">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={`char-opt ${draft.figure === p.id ? "on" : ""}`}
                  onClick={() => set("figure", p.id)}
                  title={p.label}
                >
                  <CharacterPortrait recipe={p.recipe} size={40} />
                  <span className="char-opt-label">{p.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="field-l">Accent</span>
            <div className="accent-row">
              <div className="swatches">
                {PALETTE.map((c) => (
                  <button
                    key={c}
                    className={`swatch ${(draft.accent ?? "").toLowerCase() === c.toLowerCase() ? "on" : ""}`}
                    style={{ background: c }}
                    onClick={() => set("accent", c)}
                    title={c}
                  />
                ))}
              </div>
              <span className="accent-custom">
                <input
                  type="color"
                  value={draft.accent || "#59cfff"}
                  onChange={(e) => set("accent", e.target.value)}
                />
                <input
                  className="accent-hex"
                  value={draft.accent}
                  onChange={(e) => set("accent", e.target.value)}
                />
              </span>
            </div>
          </div>

          <div className="frow two">
            <label className="field">
              <span className="field-l">Engine</span>
              <select value={draft.engine} onChange={(e) => set("engine", e.target.value)}>
                {engines.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.enabled}>
                    {e.label}{e.enabled ? "" : " (disabled)"}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-l">
                Model <span className="field-hint">optional</span>
              </span>
              <input
                value={draft.model}
                placeholder="engine default"
                onChange={(e) => set("model", e.target.value)}
              />
            </label>
          </div>

          <label className="field grow">
            <span className="field-l">
              Personality <span className="field-hint">system prompt</span>
            </span>
            <textarea
              value={draft.personality}
              onChange={(e) => set("personality", e.target.value)}
              spellCheck={false}
            />
          </label>

          <div className="form-actions">
            <button
              className="btn-primary"
              disabled={!dirty}
              onClick={save}
              style={{ borderColor: draft.accent, color: draft.accent }}
            >
              {saved ? (<><Check size={14} strokeWidth={2.5} /> Saved</>) : "Save changes"}
            </button>
            {dirty && <span className="dirty-note">unsaved</span>}
            <span style={{ flex: 1 }} />
            {draft.kind !== "orchestrator" && (
              <button className="btn-danger" onClick={remove}>
                <Trash2 size={13} strokeWidth={2} /> Remove
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="settings-form empty">Select an agent, or add one.</div>
      )}
    </div>
  );
}

// ---- Engines ---------------------------------------------------------------

function EnginesTab({ config, onConfig }: { config: AppConfig; onConfig: (c: AppConfig) => void }) {
  const [selId, setSelId] = useState(config.engines[0]?.id ?? "");
  const [draft, setDraft] = useState<EngineConfig | null>(null);
  const [saved, setSaved] = useState(false);

  const current = useMemo(
    () => config.engines.find((e) => e.id === selId) ?? null,
    [config.engines, selId],
  );

  useEffect(() => {
    setDraft(current ? { ...current, auth: { ...current.auth } } : null);
    setSaved(false);
  }, [current]);

  const set = <K extends keyof EngineConfig>(k: K, v: EngineConfig[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const apiKeyName = draft?.kind === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const apiKey = draft?.auth?.env?.[apiKeyName] ?? "";
  const dirty = draft && current && JSON.stringify(draft) !== JSON.stringify(current);
  const inUse = draft ? config.agents.some((a) => a.engine === draft.id) : false;

  const save = async () => {
    if (!draft) return;
    onConfig(await updateEngine(draft));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div className="settings-body">
      <aside className="settings-rail">
        {config.engines.map((e) => (
          <button key={e.id} className={`srow ${e.id === selId ? "on" : ""}`} onClick={() => setSelId(e.id)}>
            <span className="srow-dot" style={{ background: e.enabled ? "var(--ok)" : "var(--line)" }} />
            <span className="srow-main">
              <span className="srow-name">{e.label}</span>
              <span className="srow-sub">{e.kind}{e.supports_mcp ? " · full" : " · basic"}</span>
            </span>
          </button>
        ))}
      </aside>

      {draft ? (
        <div className="settings-form">
          <div className="frow two">
            <label className="field">
              <span className="field-l">Label</span>
              <input value={draft.label} onChange={(e) => set("label", e.target.value)} />
            </label>
            <label className="field">
              <span className="field-l">Command</span>
              <input value={draft.command} onChange={(e) => set("command", e.target.value)} spellCheck={false} />
            </label>
          </div>

          <div className="frow two">
            <label className="field">
              <span className="field-l">Auth</span>
              <select
                value={draft.auth?.method ?? ""}
                onChange={(e) =>
                  set("auth", {
                    ...(draft.auth ?? { method: "", env: {} }),
                    method: e.target.value,
                  })
                }
              >
                {AUTH_METHODS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-l">Model <span className="field-hint">default</span></span>
              <input
                value={draft.model}
                placeholder="engine default"
                onChange={(e) => set("model", e.target.value)}
              />
            </label>
          </div>

          {draft.auth?.method === "api-key-env" && (
            <label className="field">
              <span className="field-l">{apiKeyName} <span className="field-hint">stored locally</span></span>
              <input
                type="password"
                value={apiKey}
                placeholder="sk-…"
                spellCheck={false}
                onChange={(e) =>
                  set("auth", {
                    ...(draft.auth ?? { method: "api-key-env", env: {} }),
                    env: { ...(draft.auth?.env ?? {}), [apiKeyName]: e.target.value },
                  })
                }
              />
            </label>
          )}

          <div className="engine-flags">
            <label className="chk">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              <span>Enabled</span>
            </label>
            <span className={`mcp-badge ${draft.supports_mcp ? "on" : ""}`}>
              <Shield size={12} strokeWidth={2} />
              {draft.supports_mcp ? "Full: delegation + review" : "Basic: chat only"}
            </span>
          </div>

          <div className="form-actions">
            <button className="btn-primary" disabled={!dirty} onClick={save}>
              {saved ? (<><Check size={14} strokeWidth={2.5} /> Saved</>) : "Save engine"}
            </button>
            {inUse && <span className="dirty-note">in use by an agent</span>}
            <span style={{ flex: 1 }} />
            {!inUse && !["claude-code", "codex", "opencode"].includes(draft.id) && (
              <button className="btn-danger" onClick={async () => onConfig(await removeEngine(draft.id))}>
                <Trash2 size={13} strokeWidth={2} /> Remove
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="settings-form empty">Select an engine to edit.</div>
      )}
    </div>
  );
}
