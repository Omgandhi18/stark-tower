import { useEffect, useState } from "react";
import { Button, Dialog, Portrait, TextArea, cx } from "../../design";
import { studioAvailable, studioJob, studioDraw, studioCancel, studioApply, onStudioProgress, listAgents } from "../../lib/api";
import type { Choices, Look } from "../../lib/bindings";
import type { AgentConfig } from "../../lib/types";
import { errorMessage } from "../../lib/errors";
import { fileUrl } from "../attachments/fileUrl";
import { useConfig } from "../../stores/config";
import { useAgents } from "../../stores/agents";
import { useLooks } from "../../stores/looks";
import { FIGURES } from "../agents/appearance";
import { CHOICES, LOOK_THEMES, initialChoices, choicesValid, complete, drawing } from "./studioModel";
import "./studio.css";

interface Props {
  agent: AgentConfig;
  onClose: () => void;
  onApplied?: (agent: AgentConfig) => void;
}

export default function CharacterStudio(props: Props) {
  const saved = useLooks((s) => (props.agent.look ? s.looks[props.agent.look] : undefined));
  const loaded = useLooks((s) => s.loaded);
  if (props.agent.look && !loaded) {
    return (
      <Dialog open title={`Character Studio · ${props.agent.name}`} onClose={props.onClose} actions={<Button onClick={props.onClose}>Close</Button>}>
        <p role="status">Loading the current look…</p>
      </Dialog>
    );
  }
  return <StudioEditor {...props} initial={saved?.choices ?? initialChoices(props.agent)} />;
}

function StudioEditor({ agent, onClose, onApplied, initial }: Props & { initial: Choices }) {
  const [choices, setChoices] = useState(initial);
  const [look, setLook] = useState<Look | null>(null);
  const [availability, setAvailability] = useState<string | null>("Checking Codex…");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const working = busy || drawing(look);
  const jobId = look?.id;

  useEffect(() => {
    let stopped = false;
    void studioAvailable()
      .then(() => {
        if (!stopped) setAvailability(null);
      })
      .catch((e) => {
        if (!stopped) setAvailability(errorMessage(e, "Codex couldn't be checked. Run codex login in Terminal, then check again."));
      });
    const off = onStudioProgress((next) => setLook((current) => (current?.id === next.id && next.revision >= current.revision ? next : current)));
    return () => {
      stopped = true;
      void off.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    // Events show each theme immediately; polling catches a missed event.
    const timer = window.setInterval(() => {
      void studioJob(jobId)
        .then((next) => {
          if (!stopped) setLook((current) => (current && next.revision >= current.revision ? next : current));
        })
        .catch(() => {});
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      void studioCancel(jobId).catch(() => {});
    };
  }, [jobId]);

  const checkCodex = () => {
    setAvailability("Checking Codex…");
    void studioAvailable()
      .then(() => setAvailability(null))
      .catch((e) => setAvailability(errorMessage(e, "Codex couldn't be checked. Try again.")));
  };
  const close = async () => {
    if (look && !look.saved) {
      try {
        await studioCancel(look.id);
      } catch (e) {
        setError(errorMessage(e, "The drawing couldn't be cancelled. Try again."));
        return;
      }
    }
    onClose();
  };
  const draw = async (theme?: string) => {
    setBusy(true);
    setError(null);
    try {
      setLook(await studioDraw(choices, theme ? (look?.id ?? null) : null, theme ?? null));
    } catch (e) {
      setError(errorMessage(e, "The drawing couldn't start. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const apply = async (id: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const config = await studioApply(agent.id, id);
      useConfig.getState().apply(config);
      await useLooks.getState().refresh();
      useAgents.getState().replace(await listAgents());
      if (look && look.id !== id) await studioCancel(look.id);
      const next = config.agents.find((a) => a.id === agent.id);
      if (next) onApplied?.(next);
      onClose();
    } catch (e) {
      setError(errorMessage(e, "The look couldn't be applied. Try again."));
    } finally {
      setBusy(false);
    }
  };
  const back = async () => {
    try {
      if (look) await studioCancel(look.id);
      setLook(null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e, "The drawing couldn't be discarded. Try again."));
    }
  };
  const figure = FIGURES.find((f) => f.id === choices.figure)?.label ?? "selected";

  return (
    <Dialog
      open
      dismissible={!busy}
      onClose={() => void close()}
      title={`Character Studio · ${agent.name}`}
      size="lg"
      className="character-studio"
      description="Choose a look. Codex draws a portrait for each theme with your own sign-in."
      actions={
        <>
          <Button disabled={busy} onClick={() => void close()}>
            {working ? "Cancel drawing" : "Close"}
          </Button>
          {agent.look && (
            <Button disabled={working} onClick={() => void apply(null)}>
              Use the figure's own look
            </Button>
          )}
          {look ? (
            <>
              <Button disabled={working} onClick={() => void back()}>
                Back to choices
              </Button>
              <Button variant="primary" disabled={!complete(look) || working} onClick={() => void apply(look.id)}>
                Use this look
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={availability !== null || busy || !choicesValid(choices)} onClick={() => void draw()}>
              Draw this look
            </Button>
          )}
        </>
      }
    >
      <p className="studio-room-note">
        In the room, {agent.name} is still painted {choices.figure === "helperbot" ? "as the Helper bot" : `at the ${figure} desk`}: rooms are painted scenes,
        so a new look shows in portraits. Starting from another figure also moves their desk.
      </p>
      {availability && (
        <div className="studio-setup" role="status">
          <p>{availability}</p>
          <Button onClick={checkCodex}>Check again</Button>
        </div>
      )}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <Button disabled={working || availability !== null} onClick={() => void draw()}>
            Try again
          </Button>
        </div>
      )}
      {look ? (
        <StudioResults look={look} name={agent.name} disabled={working || availability !== null} retry={(theme) => void draw(theme)} />
      ) : (
        <StudioChoices choices={choices} change={setChoices} />
      )}
    </Dialog>
  );
}

function StudioResults({ look, name, disabled, retry }: { look: Look; name: string; disabled: boolean; retry: (theme: string) => void }) {
  return (
    <div className="studio-results" aria-live="polite">
      {LOOK_THEMES.map((theme) => {
        const path = look.paths[theme.id];
        const url = path ? `${fileUrl(path)}?v=${look.revision}` : undefined;
        const status = look.progress[theme.id];
        return (
          <section key={theme.id} aria-label={`${theme.name} result`}>
            <h3>{theme.name}</h3>
            <p role="status">
              {status === "drawing"
                ? `Drawing the ${theme.name} look…`
                : status === "ready"
                  ? "Ready to use"
                  : status === "failed"
                    ? "Couldn't draw this look"
                    : "Waiting to draw…"}
            </p>
            {url && (
              <>
                <img className="studio-large" src={url} alt={`${name}'s ${theme.name} look`} />
                <div className="studio-sizes">
                  {([20, 40, 64] as const).map((size) => (
                    <div key={size}>
                      <img src={url} alt={`${theme.name} preview at ${size} pixels`} width={size} height={size} />
                      <span>{size} px</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            {look.errors[theme.id] && (
              <details>
                <summary>What Codex said</summary>
                <pre>{look.errors[theme.id]}</pre>
              </details>
            )}
            <Button disabled={disabled} onClick={() => retry(theme.id)}>
              Try again · {theme.name}
            </Button>
          </section>
        );
      })}
    </div>
  );
}

function StudioChoices({ choices, change }: { choices: Choices; change: (choices: Choices) => void }) {
  return (
    <div className="studio-choices">
      <fieldset>
        <legend>Start from</legend>
        <div className="studio-chips" role="radiogroup" aria-label="Start from">
          {FIGURES.map((f) => (
            <button
              type="button"
              role="radio"
              key={f.id}
              aria-checked={choices.figure === f.id}
              className={cx("studio-chip", choices.figure === f.id && "is-selected")}
              onClick={() => change({ ...choices, figure: f.id })}
            >
              <Portrait name={f.label} figure={f.id} size={40} />
              {f.label}
            </button>
          ))}
        </div>
      </fieldset>
      {CHOICES.map((group) => (
        <fieldset key={group.field}>
          <legend>{group.field[0].toUpperCase() + group.field.slice(1)}</legend>
          <div className="studio-chips" role="radiogroup" aria-label={group.field}>
            <button
              type="button"
              role="radio"
              aria-checked={!choices.options[group.field]}
              className={cx("studio-chip", !choices.options[group.field] && "is-selected")}
              onClick={() => {
                const options = { ...choices.options };
                delete options[group.field];
                change({ ...choices, options });
              }}
            >
              Keep from figure
            </button>
            {group.values.map((value, i) => (
              <button
                type="button"
                role="radio"
                key={value}
                aria-checked={choices.options[group.field] === value}
                className={cx("studio-chip", choices.options[group.field] === value && "is-selected")}
                onClick={() => change({ ...choices, options: { ...choices.options, [group.field]: value } })}
              >
                {group.colours && <span className="studio-swatch" style={{ background: group.colours[i] }} aria-hidden />}
                {value}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <TextArea
        label="Anything else"
        value={choices.note}
        maxLength={120}
        helper="Up to 120 characters, for example: freckles, a silver ring."
        onChange={(e) => change({ ...choices, note: e.target.value })}
      />
    </div>
  );
}
