import { useEffect, useMemo, useState } from "react";
import { X, Bot, Cpu, RotateCcw, Check, Shield } from "lucide-react";
import type { AgentConfig, AppConfig, EngineConfig } from "../lib/types";
import {
  removeEngine,
  resetConfig,
  updateAgent,
  updateEngine,
} from "../lib/api";

interface Props {
  config: AppConfig;
  onConfig: (c: AppConfig) => void;
  onClose: () => void;
}

type Tab = "agents" | "engines";

const FIGURES = [
  { id: "masc", label: "Figure A" },
  { id: "fem", label: "Figure B" },
  { id: "synth", label: "Synth" },
];

const AUTH_METHODS = [
  { id: "cli-login", label: "CLI login (use what's signed in)" },
  { id: "api-key-env", label: "API key" },
  { id: "none", label: "None" },
];

/** Configuration surface: customize the roster (names, roles, sprites, accents,
 *  personalities, engine, model) and manage the engines agents run on. */
export default function Settings({ config, onConfig, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("agents");

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        className="settings glass"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="settings-head">
          <div className="settings-title">
            <span className="settings-title-main">Configuration</span>
            <span className="settings-title-sub">
              Your roster & engines — bring your own AI or use ours
            </span>
          </div>
          <div className="settings-tabs">
            <button
              className={`seg ${tab === "agents" ? "on" : ""}`}
              onClick={() => setTab("agents")}
            >
              <Bot size={14} strokeWidth={2} /> Agents
            </button>
            <button
              className={`seg ${tab === "engines" ? "on" : ""}`}
              onClick={() => setTab("engines")}
            >
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
              if (
                confirm(
                  "Restore the built-in engines and roster? This wipes your customizations.",
                )
              ) {
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

function AgentsTab({
  config,
  onConfig,
}: {
  config: AppConfig;
  onConfig: (c: AppConfig) => void;
}) {
  const [selId, setSelId] = useState(config.agents[0]?.id ?? "");
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [saved, setSaved] = useState(false);

  const current = useMemo(
    () => config.agents.find((a) => a.id === selId) ?? null,
    [config.agents, selId],
  );

  // Load a fresh editable draft whenever the selection changes.
  useEffect(() => {
    setDraft(current ? { ...current } : null);
    setSaved(false);
  }, [current]);

  const set = <K extends keyof AgentConfig>(k: K, v: AgentConfig[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d));

  const dirty =
    draft && current && JSON.stringify(draft) !== JSON.stringify(current);

  const save = async () => {
    if (!draft) return;
    const next = await updateAgent(draft);
    onConfig(next);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
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
            <span className="srow-dot" style={{ background: a.accent }} />
            <span className="srow-main">
              <span className="srow-name">{a.name}</span>
              <span className="srow-sub">{a.role}</span>
            </span>
          </button>
        ))}
      </aside>

      {draft ? (
        <div className="settings-form">
          <div className="frow two">
            <label className="field">
              <span className="field-l">Name</span>
              <input
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-l">Role</span>
              <input
                value={draft.role}
                onChange={(e) => set("role", e.target.value)}
              />
            </label>
          </div>

          <div className="frow three">
            <label className="field">
              <span className="field-l">Accent</span>
              <span className="color-field">
                <input
                  type="color"
                  value={draft.accent || "#59cfff"}
                  onChange={(e) => set("accent", e.target.value)}
                />
                <input
                  className="color-hex"
                  value={draft.accent}
                  onChange={(e) => set("accent", e.target.value)}
                />
              </span>
            </label>
            <label className="field">
              <span className="field-l">Sprite</span>
              <select
                value={draft.figure}
                onChange={(e) => set("figure", e.target.value)}
              >
                {FIGURES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
                {!FIGURES.some((f) => f.id === draft.figure) && (
                  <option value={draft.figure}>{draft.figure}</option>
                )}
              </select>
            </label>
            <label className="field">
              <span className="field-l">Kind</span>
              <input value={draft.kind} disabled />
            </label>
          </div>

          <div className="frow two">
            <label className="field">
              <span className="field-l">Engine</span>
              <select
                value={draft.engine}
                onChange={(e) => set("engine", e.target.value)}
              >
                {engines.map((e) => (
                  <option key={e.id} value={e.id} disabled={!e.enabled}>
                    {e.label}
                    {e.enabled ? "" : " (disabled)"}
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
              {saved ? (
                <>
                  <Check size={14} strokeWidth={2.5} /> Saved
                </>
              ) : (
                "Save changes"
              )}
            </button>
            {dirty && <span className="dirty-note">unsaved</span>}
          </div>
        </div>
      ) : (
        <div className="settings-form empty">Select an agent to edit.</div>
      )}
    </div>
  );
}

// ---- Engines ---------------------------------------------------------------

function EnginesTab({
  config,
  onConfig,
}: {
  config: AppConfig;
  onConfig: (c: AppConfig) => void;
}) {
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

  const apiKey = draft?.auth.env.ANTHROPIC_API_KEY ?? draft?.auth.env.OPENAI_API_KEY ?? "";
  const apiKeyName =
    draft?.kind === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  const dirty =
    draft && current && JSON.stringify(draft) !== JSON.stringify(current);

  const inUse = draft
    ? config.agents.some((a) => a.engine === draft.id)
    : false;

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
          <button
            key={e.id}
            className={`srow ${e.id === selId ? "on" : ""}`}
            onClick={() => setSelId(e.id)}
          >
            <span
              className="srow-dot"
              style={{ background: e.enabled ? "var(--ok)" : "var(--line)" }}
            />
            <span className="srow-main">
              <span className="srow-name">{e.label}</span>
              <span className="srow-sub">
                {e.kind}
                {e.supports_mcp ? " · full" : " · basic"}
              </span>
            </span>
          </button>
        ))}
      </aside>

      {draft ? (
        <div className="settings-form">
          <div className="frow two">
            <label className="field">
              <span className="field-l">Label</span>
              <input
                value={draft.label}
                onChange={(e) => set("label", e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-l">Command</span>
              <input
                value={draft.command}
                onChange={(e) => set("command", e.target.value)}
                spellCheck={false}
              />
            </label>
          </div>

          <div className="frow two">
            <label className="field">
              <span className="field-l">Auth</span>
              <select
                value={draft.auth.method}
                onChange={(e) =>
                  set("auth", { ...draft.auth, method: e.target.value })
                }
              >
                {AUTH_METHODS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-l">
                Model <span className="field-hint">default</span>
              </span>
              <input
                value={draft.model}
                placeholder="engine default"
                onChange={(e) => set("model", e.target.value)}
              />
            </label>
          </div>

          {draft.auth.method === "api-key-env" && (
            <label className="field">
              <span className="field-l">
                {apiKeyName} <span className="field-hint">stored locally</span>
              </span>
              <input
                type="password"
                value={apiKey}
                placeholder="sk-…"
                spellCheck={false}
                onChange={(e) =>
                  set("auth", {
                    ...draft.auth,
                    env: { ...draft.auth.env, [apiKeyName]: e.target.value },
                  })
                }
              />
            </label>
          )}

          <div className="engine-flags">
            <label className="chk">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              <span>Enabled</span>
            </label>
            <span
              className={`mcp-badge ${draft.supports_mcp ? "on" : ""}`}
              title="Whether this engine supports delegation, ask_human, and the permission gate"
            >
              <Shield size={12} strokeWidth={2} />
              {draft.supports_mcp
                ? "Full: delegation + review"
                : "Basic: chat only"}
            </span>
          </div>

          <div className="form-actions">
            <button className="btn-primary" disabled={!dirty} onClick={save}>
              {saved ? (
                <>
                  <Check size={14} strokeWidth={2.5} /> Saved
                </>
              ) : (
                "Save engine"
              )}
            </button>
            {!inUse && !["claude-code", "codex", "opencode"].includes(draft.id) && (
              <button
                className="btn-danger"
                onClick={async () => onConfig(await removeEngine(draft.id))}
              >
                Remove
              </button>
            )}
            {inUse && <span className="dirty-note">in use by an agent</span>}
          </div>
        </div>
      ) : (
        <div className="settings-form empty">Select an engine to edit.</div>
      )}
    </div>
  );
}
