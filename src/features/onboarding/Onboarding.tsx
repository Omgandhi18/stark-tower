import { useState } from "react";
import { ArrowLeft, ArrowRight, Bell, Building2, Check, FolderPlus, LayoutGrid, RefreshCw, type LucideIcon } from "lucide-react";
import { portraitKey, Button, Dialog, Portrait, TextField, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { addProject, pickFolder, setOnboarded, updateAgent, updateEngine } from "../../lib/api";
import { apiKeyNameFor } from "../../lib/engines";
import { errorMessage } from "../../lib/errors";
import type { AppConfig } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useSystem } from "../../stores/system";
import { folderName, useWorkspace } from "../../stores/workspace";
import { installSummary, withApiKey } from "../settings/providerDraft";
import "./onboarding.css";

const STEPS = ["Welcome", "Provider", "Project", "Team"] as const;
const LAST = STEPS.length - 1;

const FACTS: ReadonlyArray<{ icon: LucideIcon; text: string }> = [
  { icon: LayoutGrid, text: "Hand work to one agent or the whole team, and see everything that's running in one place." },
  { icon: Bell, text: "Agents stop and ask before running risky commands, and wait for your answers." },
  { icon: Building2, text: "Watch the team at their desks, and talk to anyone where they sit." },
];

/** First run: pick a provider, add a project, meet the team. Every choice can be changed later. */
export default function Onboarding({ config }: { config: AppConfig }) {
  const apply = useConfig((s) => s.apply);
  const health = useSystem((s) => s.health);
  const refreshHealth = useSystem((s) => s.refreshHealth);
  const projects = useWorkspace((s) => s.projects);
  const applyProjects = useWorkspace((s) => s.applyProjects);
  const [step, setStep] = useState(0);
  const [engineId, setEngineId] = useState(() => config.engines.find((e) => e.enabled)?.id ?? config.engines[0]?.id ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const engine = config.engines.find((e) => e.id === engineId);
  const team = config.agents.filter((a) => a.enabled !== false && a.kind !== "maintenance");
  const lead = team.find((a) => a.kind === "orchestrator");

  const attempt = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, failure));
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = () =>
    attempt(async () => {
      const path = await pickFolder("Choose a project folder");
      if (path) applyProjects(await addProject(path));
    }, "That folder couldn't be added.");

  const finish = () =>
    attempt(async () => {
      if (engine) {
        const configured = apiKey.trim()
          ? withApiKey({ ...engine, enabled: true, auth: { ...engine.auth, method: "api-key-env" } }, apiKey.trim())
          : { ...engine, enabled: true };
        const updated = await updateEngine(configured);
        for (const agent of updated.agents) {
          if (agent.engine !== engine.id) await updateAgent({ ...agent, engine: engine.id });
        }
      }
      apply(await setOnboarded(true));
    }, "Setup couldn't be saved.");

  const skip = () => attempt(async () => apply(await setOnboarded(true)), "Setup couldn't be closed.");

  const titles = [
    "Welcome to Starkline",
    "Choose what runs your agents",
    "Add a project",
    "Meet your team",
  ];
  const descriptions = [
    `A team of AI coding agents on your Mac. ${lead?.name ?? "Your lead agent"} plans and routes the work; specialists build, research and review in your projects.`,
    "Each agent runs on a command-line provider installed on this Mac. You can mix providers per agent later.",
    "Agents work inside folders on your Mac. Add the repository you want help with first.",
    `${team.length} agents are ready. Rename them or change how they work any time on Agents.`,
  ];

  return (
    <Dialog
      open
      dismissible={false}
      onClose={() => undefined}
      size="lg"
      className="onboarding"
      title={titles[step]}
      description={descriptions[step]}
      actions={
        <>
          {step === 0 ? (
            <Button variant="ghost" disabled={busy} onClick={skip}>
              Skip setup
            </Button>
          ) : (
            <Button variant="ghost" icon={ArrowLeft} disabled={busy} onClick={() => setStep((s) => s - 1)}>
              Back
            </Button>
          )}
          <span className="onboarding-spacer" />
          {error && (
            <span className="onboarding-error" role="alert">
              {error}
            </span>
          )}
          {step < LAST ? (
            <Button variant="primary" trailingIcon={ArrowRight} disabled={busy} onClick={() => setStep((s) => s + 1)}>
              Continue
            </Button>
          ) : (
            <Button variant="primary" icon={Check} disabled={busy} onClick={finish}>
              Start working
            </Button>
          )}
        </>
      }
    >
      <ol className="onboarding-steps" aria-label="Setup steps">
        {STEPS.map((label, i) => (
          <li key={label} className={cx("onboarding-step", i === step && "is-current", i < step && "is-done")} aria-current={i === step ? "step" : undefined}>
            <span className="onboarding-step-mark">{i < step ? <Check aria-hidden size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <ul className="onboarding-facts">
          {FACTS.map(({ icon: Icon, text }) => (
            <li key={text}>
              <span className="onboarding-fact-icon" aria-hidden>
                <Icon size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              </span>
              {text}
            </li>
          ))}
        </ul>
      )}

      {step === 1 && (
        <div className="onboarding-providers">
          <div className="onboarding-choices" role="radiogroup" aria-label="Provider">
            {config.engines.map((e) => {
              const engineHealth = health?.engines.find((h) => h.id === e.id);
              return (
                <button
                  key={e.id}
                  type="button"
                  role="radio"
                  aria-checked={e.id === engineId}
                  className="onboarding-choice"
                  onClick={() => setEngineId(e.id)}
                >
                  <span className="onboarding-radio" aria-hidden />
                  <span className="onboarding-choice-text">
                    <span className="onboarding-choice-name">{e.label}</span>
                    <span className="onboarding-choice-meta">
                      {installSummary(engineHealth)}. {e.supports_mcp ? "Full support." : "Chat only for now."}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="onboarding-provider-foot">
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void refreshHealth().catch(() => undefined)}>
              Check again
            </Button>
          </div>
          {engine && (
            <TextField
              label={`${apiKeyNameFor(engine.kind)} (optional)`}
              type="password"
              autoComplete="off"
              value={apiKey}
              placeholder={`Leave blank to use ${engine.label}'s own sign-in`}
              helper="Kept in this Mac's local Starkline data."
              onChange={(e) => setApiKey(e.target.value)}
            />
          )}
        </div>
      )}

      {step === 2 && (
        <div className="onboarding-projects">
          {projects.length > 0 && (
            <ul className="onboarding-project-list">
              {projects.map((p) => (
                <li key={p.path}>
                  <span className="onboarding-project-name">{p.name || folderName(p.path)}</span>
                  <span className="onboarding-project-path mono">{p.path}</span>
                </li>
              ))}
            </ul>
          )}
          <Button icon={FolderPlus} disabled={busy} onClick={chooseFolder}>
            {projects.length ? "Add another folder" : "Choose a folder"}
          </Button>
          {projects.length === 0 && <p className="onboarding-note">You can also add projects later from Work.</p>}
        </div>
      )}

      {step === 3 && (
        <ul className="onboarding-team">
          {team.map((a) => (
            <li key={a.id}>
              <Portrait name={a.name} figure={portraitKey(a)} accent={a.accent} size={48} />
              <span className="onboarding-team-name">{a.name}</span>
              <span className="onboarding-team-role">{a.role}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
