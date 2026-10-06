import { useId, type CSSProperties } from "react";
import { cx } from "../../design";
import { effortLabel, nearestLevel } from "./modelSettings";
import "./modelSettings.css";

interface EffortSliderProps {
  /** The levels the model takes, lowest first. */
  levels: readonly string[];
  /** The level the model runs at when none is chosen, where the provider says. */
  defaultLevel: string | null;
  /** The chosen level; "" for the model's own default. */
  value: string;
  onChange: (level: string) => void;
  /** Names the model when it has no levels to choose. */
  modelName: string;
  label?: string;
}

const at = (fraction: number) => ({ "--effort-at": fraction }) as CSSProperties;

/**
 * How hard the model thinks, from faster to smarter: a stop for each level it takes, with its
 * default marked. Until a level is chosen the model's default holds ("Use default" goes back to it).
 */
export default function EffortSlider({ levels, defaultLevel, value, onChange, modelName, label = "Effort" }: EffortSliderProps) {
  const labelId = useId();
  if (levels.length < 2) {
    return (
      <div className="effort-field">
        <span className="field-label">{label}</span>
        <span className="field-helper">
          {levels.length ? `${modelName} always runs at ${effortLabel(levels[0]).toLowerCase()} effort.` : `${modelName} has no effort setting.`}
        </span>
      </div>
    );
  }
  const last = levels.length - 1;
  const usual = defaultLevel && levels.includes(defaultLevel) ? defaultLevel : null;
  const level = value ? nearestLevel(levels, value) : usual;
  const index = level ? levels.indexOf(level) : Math.floor(last / 2);
  const usualIndex = usual ? levels.indexOf(usual) : -1;
  const name = level ? effortLabel(level) : "Default";
  const isUsual = level !== null && level === usual;
  const spoken = !level ? "The model's default" : isUsual ? `${name}, the default` : name;

  return (
    <div className="effort-field">
      <div className="effort-head">
        <span id={labelId} className="field-label">
          {label}
        </span>
        <span className="effort-value">
          {name}
          {isUsual && <span className="effort-value-note"> · default</span>}
        </span>
        {value && (
          <button type="button" className="effort-reset" onClick={() => onChange("")}>
            Use default
          </button>
        )}
      </div>
      <div className={cx("effort-track", !level && "is-unset")} style={at(index / last)}>
        <span className="effort-fill" aria-hidden />
        {levels.map((l, i) => (
          <span key={l} className={cx("effort-tick", level !== null && i <= index && "is-filled")} style={at(i / last)} aria-hidden />
        ))}
        <input
          data-autofocus
          type="range"
          className="effort-range"
          min={0}
          max={last}
          step={1}
          value={index}
          aria-labelledby={labelId}
          aria-valuetext={spoken}
          onChange={(e) => onChange(levels[Number(e.target.value)])}
          // Nothing chosen and no default known: the first click chooses even the stop it starts on.
          onClick={(e) => !level && onChange(levels[Number(e.currentTarget.value)])}
        />
      </div>
      <div className="effort-scale" aria-hidden>
        {usualIndex !== 0 && <span>Faster</span>}
        {usual && (
          <span className={cx("effort-usual", usualIndex === 0 && "is-first", usualIndex === last && "is-last")} style={at(usualIndex / last)}>
            Default
          </span>
        )}
        {usualIndex !== last && <span className="effort-scale-end">Smarter</span>}
      </div>
    </div>
  );
}
