import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, ShieldCheck, Settings as SettingsIcon } from "lucide-react";
import type { AppConfig } from "../lib/types";
import { setOnboarded, updateAgent, updateEngine } from "../lib/api";

interface Props {
  config: AppConfig;
  onDone: (c: AppConfig) => void;
}

const STEPS = [
  { key: "welcome", label: "Boot" },
  { key: "engine", label: "Power source" },
  { key: "roster", label: "Crew" },
  { key: "ready", label: "Online" },
];

/** The env var name an engine kind expects its API key under. */
function keyNameFor(kind: string): string {
  switch (kind) {
    case "codex":
      return "OPENAI_API_KEY";
    case "opencode":
      return "OPENCODE_API_KEY";
    default:
      return "ANTHROPIC_API_KEY";
  }
}

/** A thin schematic arc-reactor mark — concentric HUD rings, not a glowing orb.
 *  Matches the app's brand-core motif; the outer ring idles slowly when online. */
function Reactor({ live }: { live: boolean }) {
  return (
    <svg className={`ob-reactor ${live ? "live" : ""}`} viewBox="0 0 120 120" aria-hidden="true">
      <g className="ob-reactor-spin" fill="none" stroke="currentColor">
        <circle cx="60" cy="60" r="52" strokeWidth="1" strokeOpacity="0.28" strokeDasharray="3 7" />
      </g>
      <g fill="none" stroke="currentColor">
        <circle cx="60" cy="60" r="40" strokeWidth="1.25" strokeOpacity="0.55" />
        <circle cx="60" cy="60" r="27" strokeWidth="1" strokeOpacity="0.35" />
        {[0, 60, 120, 180, 240, 300].map((a) => (
          <line
            key={a}
            x1="60"
            y1="20"
            x2="60"
            y2="27"
            strokeWidth="1.25"
            strokeOpacity="0.5"
            transform={`rotate(${a} 60 60)`}
          />
        ))}
      </g>
      <circle cx="60" cy="60" r="12" className="ob-reactor-core" />
    </svg>
  );
}

/** First-run setup: pick the engine that powers the lab, connect an account,
 *  meet the crew. Everything is editable later from Configuration, and the whole
 *  flow is skippable. */
export default function Onboarding({ config, onDone }: Props) {
  const [step, setStep] = useState(0);
  const [engineId, setEngineId] = useState(config.agents[0]?.engine || "claude-code");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const engine = config.engines.find((e) => e.id === engineId);
  const keyName = engine ? keyNameFor(engine.kind) : "ANTHROPIC_API_KEY";
  const last = step === STEPS.length - 1;

  // Names are user-configurable, so the copy reads from config rather than
  // assuming the built-in roster (the orchestrator may not be called JARVIS).
  const orchestrator =
    config.agents.find((a) => a.kind === "orchestrator" && a.enabled) ??
    config.agents.find((a) => a.kind === "orchestrator") ??
    config.agents[0];
  const orchName = orchestrator?.name || "your lead agent";
  const crewCount = config.agents.filter((a) => a.enabled).length;

  const back = () => setStep((s) => Math.max(0, s - 1));
  const next = () => setStep((s) => Math.min(STEPS.length - 1, s + 1));

  const finish = async () => {
    setBusy(true);
    try {
      let cfg = config;
      const eng = cfg.engines.find((e) => e.id === engineId);
      if (eng && apiKey.trim()) {
        cfg = await updateEngine({
          ...eng,
          enabled: true,
          auth: { method: "api-key-env", env: { ...eng.auth.env, [keyName]: apiKey.trim() } },
        });
      } else if (eng && !eng.enabled) {
        cfg = await updateEngine({ ...eng, enabled: true });
      }
      for (const a of cfg.agents) {
        if (a.engine !== engineId) cfg = await updateAgent({ ...a, engine: engineId });
      }
      cfg = await setOnboarded(true);
      onDone(cfg);
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    setBusy(true);
    try {
      onDone(await setOnboarded(true));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ob-backdrop">
      <div className="ob">
        {/* Identity rail — persistent across steps */}
        <aside className="ob-rail">
          <div className="ob-brand">
            <Reactor live={last} />
            <span className="ob-brand-name">STARK&nbsp;TOWER</span>
            <span className="ob-brand-tag">Agent lab · first boot</span>
          </div>

          <ol className="ob-stepper">
            {STEPS.map((s, i) => (
              <li
                key={s.key}
                className={`ob-tick ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}
              >
                <span className="ob-tick-mark">
                  {i < step ? <Check size={12} strokeWidth={3} /> : String(i + 1).padStart(2, "0")}
                </span>
                <span className="ob-tick-label">{s.label}</span>
              </li>
            ))}
          </ol>
        </aside>

        {/* Content pane */}
        <section className="ob-main">
          <div className="ob-content" key={step}>
            {step === 0 && (
              <>
                <h1 className="ob-h1">Bring your lab online.</h1>
                <p className="ob-body">
                  Stark Tower runs a team of AI agents from one chat. {orchName} routes the work;
                  specialists build, research, and ship across your projects at once.
                </p>
                <ul className="ob-facts">
                  <li>
                    <b>Direct one, or the whole team.</b> Talk to {orchName} or task any specialist
                    yourself.
                  </li>
                  <li>
                    <b>Runs in parallel.</b> Different jobs in different repos, at the same time.
                  </li>
                  <li>
                    <b>Yours to shape.</b> Names, briefs, sprites, and engines are all editable.
                  </li>
                </ul>
              </>
            )}

            {step === 1 && (
              <>
                <h1 className="ob-h1">Choose your power source.</h1>
                <p className="ob-body">
                  Every agent runs on an engine. Claude Code is fully wired; the others are in
                  preview. You can give each agent its own later.
                </p>
                <div className="ob-engines">
                  {config.engines.map((e) => {
                    const on = engineId === e.id;
                    return (
                      <button
                        key={e.id}
                        className={`ob-engine ${on ? "on" : ""}`}
                        onClick={() => setEngineId(e.id)}
                        aria-pressed={on}
                      >
                        <span className="ob-engine-radio" />
                        <span className="ob-engine-text">
                          <span className="ob-engine-name">{e.label}</span>
                          <span className="ob-engine-desc">
                            {e.supports_mcp
                              ? "Delegation, live review, and the command gate."
                              : "Chat only for now. Delegation lands with its adapter."}
                          </span>
                        </span>
                        <span className={`ob-tag ${e.supports_mcp ? "full" : "basic"}`}>
                          {e.supports_mcp ? (
                            <>
                              <ShieldCheck size={11} strokeWidth={2} /> Full
                            </>
                          ) : (
                            "Preview"
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <label className="ob-field">
                  <span className="ob-field-l">{keyName}</span>
                  <input
                    type="password"
                    value={apiKey}
                    placeholder={`Optional. Blank uses your signed-in ${engine?.label ?? "CLI"}.`}
                    spellCheck={false}
                    onChange={(ev) => setApiKey(ev.target.value)}
                  />
                  <span className="ob-field-hint">Stored locally on this machine.</span>
                </label>
              </>
            )}

            {step === 2 && (
              <>
                <h1 className="ob-h1">Your standing crew.</h1>
                <p className="ob-body">
                  {crewCount} agents, ready now. Rename them, rewrite their briefs, and reskin them
                  anytime from{" "}
                  <SettingsIcon size={13} strokeWidth={2} className="ob-inline-ic" /> Configuration.
                </p>
                <div className="ob-roster">
                  {config.agents
                    .filter((a) => a.enabled)
                    .map((a) => (
                      <div key={a.id} className="ob-agent">
                        <span className="ob-agent-bar" style={{ background: a.accent }} />
                        <span className="ob-agent-name">{a.name}</span>
                        <span className="ob-agent-role">{a.role}</span>
                      </div>
                    ))}
                </div>
              </>
            )}

            {step === 3 && (
              <>
                <h1 className="ob-h1">Reactor online.</h1>
                <p className="ob-body">
                  Open a channel to {orchName} and hand off the first job. Everything here stays
                  editable from the gear menu whenever you want to change it.
                </p>
                <div className="ob-ready-note">
                  Powered by <b>{engine?.label ?? "Claude Code"}</b>
                  {apiKey.trim() ? " · your API key" : " · your signed-in account"}
                </div>
              </>
            )}
          </div>

          <footer className="ob-foot">
            {step > 0 ? (
              <button className="ob-ghost" onClick={back} disabled={busy}>
                <ArrowLeft size={14} strokeWidth={2} /> Back
              </button>
            ) : (
              <button className="ob-ghost quiet" onClick={skip} disabled={busy}>
                Skip setup
              </button>
            )}
            <span className="ob-foot-sp" />
            <button className="ob-cta" onClick={last ? finish : next} disabled={busy}>
              {busy ? "Setting up" : last ? "Enter the tower" : "Continue"}
              {!busy && <ArrowRight size={15} strokeWidth={2.25} />}
            </button>
          </footer>
        </section>
      </div>
    </div>
  );
}
