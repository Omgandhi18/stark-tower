import { useState } from "react";
import { cx } from "../../design";
import type { AppConfig } from "../../lib/types";
import { useSystem } from "../../stores/system";
import ProviderEditor from "./ProviderEditor";
import { installSummary, signInSummary } from "./providerDraft";

/** The agent CLIs Starkline can run, whether they're installed, and how they sign in. */
export default function ProviderSettings({ config }: { config: AppConfig }) {
  const health = useSystem((s) => s.health);
  const [selectedId, setSelectedId] = useState(config.engines[0]?.id ?? "");
  const selected = config.engines.find((e) => e.id === selectedId) ?? config.engines[0];

  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">Providers</h1>
        <p className="screen-subtitle">The command-line agents your team runs on. Each agent picks one on the Agents screen.</p>
      </header>
      <div className="provider-layout">
        <ul className="provider-list" aria-label="Providers">
          {config.engines.map((engine) => {
            const engineHealth = health?.engines.find((h) => h.id === engine.id);
            const ready = engine.enabled && engineHealth?.installed && engineHealth.signIn?.signedIn !== false;
            const signIn = signInSummary(engineHealth);
            return (
              <li key={engine.id}>
                <button
                  type="button"
                  className="provider-row"
                  aria-current={engine.id === selected?.id ? "true" : undefined}
                  onClick={() => setSelectedId(engine.id)}
                >
                  <span className={cx("provider-dot", ready ? "tone-success" : engine.enabled ? "tone-attention" : "tone-idle")} aria-hidden />
                  <span className="provider-row-text">
                    <span className="provider-row-name">{engine.label}</span>
                    <span className="provider-row-meta">
                      {engine.enabled ? installSummary(engineHealth) : "Turned off"}
                      {engine.enabled && signIn && <> · {signIn}</>}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {selected && <ProviderEditor key={selected.id} saved={selected} config={config} health={health?.engines.find((h) => h.id === selected.id)} />}
      </div>
    </div>
  );
}
