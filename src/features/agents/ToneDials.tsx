import { useEffect, useId, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "../../design";
import { defaultTone } from "../../lib/api";
import type { Tone } from "../../lib/types";

interface Dial {
  key: keyof Tone;
  label: string;
  /** What the lowest and highest steps mean. */
  low: string;
  high: string;
  /** One word per step, lowest first. */
  steps: readonly string[];
}

const DIALS: readonly Dial[] = [
  { key: "humour", label: "Humour", low: "Serious", high: "Playful", steps: ["None", "Rare", "Now and then", "Playful", "Very playful"] },
  { key: "sarcasm", label: "Sarcasm", low: "Earnest", high: "Sarcastic", steps: ["None", "Barely", "Dry wit", "Sarcastic", "Very sarcastic"] },
  { key: "formality", label: "Formality", low: "Casual", high: "Formal", steps: ["Very casual", "Relaxed", "Professional", "Formal", "Very formal"] },
  { key: "enthusiasm", label: "Enthusiasm", low: "Reserved", high: "Upbeat", steps: ["Calm", "Reserved", "Warm", "Upbeat", "Bursting"] },
  { key: "detail", label: "Detail", low: "Brief", high: "Thorough", steps: ["Minimal", "Brief", "Balanced", "Thorough", "Exhaustive"] },
];

interface ToneDialsProps {
  agentId: string;
  name: string;
  /** The draft's dials; missing on agents saved before dials existed. */
  tone: Tone | null | undefined;
  onChange: (tone: Tone) => void;
}

/** How an agent comes across, dial by dial. The dials win where the written personality says otherwise. */
export default function ToneDials({ agentId, name, tone, onChange }: ToneDialsProps) {
  const id = useId();
  const [usual, setUsual] = useState<Tone | null>(null);

  useEffect(() => {
    let current = true;
    defaultTone(agentId)
      .then((t) => current && setUsual(t))
      .catch((e) => console.error("[agents] couldn't read the default tone", e));
    return () => {
      current = false;
    };
  }, [agentId]);

  const shown = tone ?? usual;
  const atUsual = Boolean(shown && usual && DIALS.every((d) => shown[d.key] === usual[d.key]));

  return (
    <div className="tone-dials">
      <div className="tone-dials-head">
        <p className="form-section-note">How {name} comes across. Where these and the instructions disagree, the dials win.</p>
        <Button variant="ghost" size="sm" icon={RotateCcw} disabled={!usual || atUsual} onClick={() => usual && onChange(usual)}>
          Use {name}'s usual tone
        </Button>
      </div>
      {shown &&
        DIALS.map((dial) => {
          const value = shown[dial.key];
          const inputId = `${id}-${dial.key}`;
          return (
            <div key={dial.key} className="tone-dial">
              <label htmlFor={inputId} className="tone-dial-label">
                {dial.label}
              </label>
              <div className="tone-dial-track">
                <input
                  id={inputId}
                  type="range"
                  className="tone-dial-input"
                  min={0}
                  max={dial.steps.length - 1}
                  step={1}
                  value={value}
                  aria-valuetext={dial.steps[value]}
                  onChange={(e) => onChange({ ...shown, [dial.key]: Number(e.target.value) })}
                />
                <span className="tone-dial-ends" aria-hidden>
                  <span>{dial.low}</span>
                  <span>{dial.high}</span>
                </span>
              </div>
              <span className="tone-dial-value">{dial.steps[value]}</span>
            </div>
          );
        })}
    </div>
  );
}
