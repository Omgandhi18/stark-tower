import { useState } from "react";
import { Button, Portrait, TextField, Toggle } from "../../design";
import { cancelVoiceDownload, downloadVoices, removeVoices, setVoiceSettings, stopSpeaking, updateAgent } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { VoiceSettings } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useVoices } from "../../stores/voices";
import VoicePicker from "../voices/VoicePicker";
import { defaultVoice, DEFAULT_VOICE_SETTINGS } from "../voices/voiceModel";
import "../voices/voices.css";

const WHAT_SPEAKS = [
  ["reminders", "Reminders"],
  ["ready", "Work ready for review"],
  ["needs_you", "An agent needs you"],
  ["failures", "Failures"],
  ["replies", "Replies you aren't looking at"],
] as const;

export default function VoicesSettings() {
  const config = useConfig((s) => s.config);
  const apply = useConfig((s) => s.apply);
  const status = useVoices((s) => s.status);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e, "Couldn't change voices. Try again."));
    } finally {
      setBusy(false);
    }
  };
  if (!config) return <p role="status">Loading voice settings…</p>;
  const settings = { ...DEFAULT_VOICE_SETTINGS, ...config.voices };
  const change = <K extends keyof VoiceSettings>(key: K, value: VoiceSettings[K]) =>
    void run(async () => apply(await setVoiceSettings({ ...settings, [key]: value })));
  const ready = status?.model === "ready";
  return (
    <div className="settings-section">
      <header className="screen-header">
        <h1 className="screen-title">Voices</h1>
        <p className="screen-subtitle">Voices run on this Mac. Nothing you hear is sent anywhere.</p>
      </header>
      <section className="settings-card" aria-label="Voice model">
        <h2 className="settings-card-title">Kokoro voices</h2>
        {!status ? (
          <p role="status">Checking voices…</p>
        ) : ready ? (
          <>
            <p role="status">Voices are ready. Download size: 350 MB.</p>
            {!settings.enabled && (
              <Button variant="primary" disabled={busy} onClick={() => change("enabled", true)}>
                Turn voices on
              </Button>
            )}
            <Button disabled={busy} onClick={() => void run(async () => apply(await removeVoices()))}>
              Remove voices
            </Button>
          </>
        ) : status.model === "downloading" ? (
          <>
            <p role="status">Downloading voices… {Math.round((status.downloaded / status.total) * 100)}%</p>
            <progress aria-label="Voice download" value={status.downloaded} max={status.total} />
            <Button disabled={busy} onClick={() => void run(cancelVoiceDownload)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <p>Voices haven't been downloaded. Download them once to hear your team offline.</p>
            <Button disabled={busy} onClick={() => void run(downloadVoices)}>
              Download voices (350 MB)
            </Button>
          </>
        )}
        {status?.error && <p role="alert">{status.error}</p>}
      </section>
      <section className="settings-card" aria-label="Speech settings">
        <Toggle label="Voices on" checked={settings.enabled} disabled={!ready || busy} onChange={(v) => change("enabled", v)} />
        <h2 className="settings-card-title">What speaks</h2>
        {WHAT_SPEAKS.map(([key, label]) => (
          <Toggle
            key={key}
            label={label}
            checked={settings[key]}
            disabled={busy}
            onChange={(v) => change(key, v)}
            description={key === "replies" ? "The first two sentences, when Starkline is in the background or you're on another screen." : undefined}
          />
        ))}
        <Toggle label="Only when Starkline isn't in front" checked={settings.background_only} disabled={busy} onChange={(v) => change("background_only", v)} />
        <Toggle
          label="Quiet hours"
          checked={settings.quiet_hours}
          disabled={busy}
          onChange={(v) => change("quiet_hours", v)}
          description="Use this Mac's local time. Matching times mean quiet all day."
        />
        {settings.quiet_hours && (
          <div className="form-grid">
            <TextField
              label="Quiet from"
              type="time"
              value={settings.quiet_from}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) change("quiet_from", e.target.value);
              }}
            />
            <TextField
              label="Quiet to"
              type="time"
              value={settings.quiet_to}
              disabled={busy}
              onChange={(e) => {
                if (e.target.value) change("quiet_to", e.target.value);
              }}
            />
          </div>
        )}
        <TextField
          label={`Volume (${Math.round(settings.volume * 100)}%)`}
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={settings.volume}
          disabled={busy}
          onChange={(e) => change("volume", Number(e.target.value))}
        />
        {status?.agent_id && <Button onClick={() => void run(stopSpeaking)}>Stop speaking</Button>}
      </section>
      <section className="settings-card" aria-label="Team voices">
        <h2 className="settings-card-title">Your team</h2>
        <p className="voice-note">Original voices, with no actor imitations. Choose a voice, pace and pitch for each agent.</p>
        {config.agents.map((agent) => (
          <fieldset key={agent.id} className="voice-agent" disabled={busy}>
            <legend>
              <Portrait name={agent.name} figure={agent.figure} accent={agent.accent} size={32} /> {agent.name}
            </legend>
            <VoicePicker
              agentId={agent.id}
              name={agent.name}
              voice={agent.voice ?? defaultVoice(agent.id)}
              onChange={(voice) => void run(async () => apply(await updateAgent({ ...agent, voice })))}
            />
          </fieldset>
        ))}
      </section>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
