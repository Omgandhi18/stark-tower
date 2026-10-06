import { useState } from "react";
import { Square, Volume2 } from "lucide-react";
import { Button } from "../../design";
import { speakVoice, stopSpeaking } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useConfig } from "../../stores/config";
import { useVoices } from "../../stores/voices";
import "./voices.css";

export default function ReadAloud({ agentId, text, messageId }: { agentId: string; text: string; messageId: string }) {
  const status = useVoices((s) => s.status);
  const enabled = useConfig((s) => s.config?.voices?.enabled ?? false);
  const [error, setError] = useState<string | null>(null);
  const token = `message:${agentId}:${messageId}`;
  const speaking = status?.token === token;
  const read = async () => {
    setError(null);
    try {
      if (speaking) await stopSpeaking();
      else await speakVoice(agentId, text, token);
    } catch (e) {
      setError(errorMessage(e, "Couldn't read this message. Try again."));
    }
  };
  return (
    <div className="read-aloud">
      <Button
        variant="ghost"
        size="sm"
        icon={speaking ? Square : Volume2}
        disabled={!speaking && (!enabled || status?.model !== "ready")}
        title={!enabled ? "Turn voices on in Settings → Voices" : undefined}
        onClick={() => void read()}
      >
        {speaking ? "Stop" : "Read aloud"}
      </Button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
