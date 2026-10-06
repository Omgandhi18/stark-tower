import { useState } from "react";
import { Volume2, Square } from "lucide-react";
import { Button, FieldShell, TextField } from "../../design";
import { speakVoice, stopSpeaking } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Voice } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useVoices } from "../../stores/voices";
import { VOICE_GROUPS } from "./voiceModel";
import "./voices.css";

export default function VoicePicker({ agentId, name, voice, onChange }: { agentId: string; name: string; voice: Voice; onChange: (voice: Voice) => void }) {
  const [error, setError] = useState<string | null>(null);
  const status = useVoices((s) => s.status);
  const enabled = useConfig((s) => s.config?.voices?.enabled ?? false);
  const token = `preview:${agentId}`;
  const speaking = status?.token === token;
  const preview = async () => {
    setError(null);
    try {
      if (speaking) await stopSpeaking();
      else await speakVoice(agentId, `This is how ${name} sounds.`, token, voice);
    } catch (e) {
      setError(errorMessage(e, "Couldn't preview this voice. Try again."));
    }
  };
  return (
    <div className="voice-picker">
      <FieldShell label="Voice">
        {({ id, describedBy }) => (
          <select
            id={id}
            aria-describedby={describedBy}
            className="input select"
            value={voice.name}
            onChange={(e) => onChange({ ...voice, name: e.target.value })}
          >
            {VOICE_GROUPS.map((group) => (
              <optgroup key={group.prefix} label={group.label}>
                {group.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
      </FieldShell>
      <TextField
        label={`Speed (${voice.speed.toFixed(2)}×)`}
        type="range"
        min="0.8"
        max="1.3"
        step="0.01"
        value={voice.speed}
        onChange={(e) => onChange({ ...voice, speed: Number(e.target.value) })}
      />
      <TextField
        label={`Pitch (${voice.pitch > 0 ? "+" : ""}${voice.pitch} semitones)`}
        type="range"
        min="-6"
        max="6"
        step="1"
        value={voice.pitch}
        onChange={(e) => onChange({ ...voice, pitch: Number(e.target.value) })}
      />
      <Button size="sm" icon={speaking ? Square : Volume2} disabled={!speaking && (!enabled || status?.model !== "ready")} onClick={() => void preview()}>
        {speaking ? "Stop" : "Preview"}
      </Button>
      {!enabled && <p className="voice-note">Download and turn voices on in Settings → Voices to preview.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
