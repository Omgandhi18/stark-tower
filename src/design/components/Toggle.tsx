import { useId } from "react";
import { cx } from "../cx";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Visible label; pass hideLabel to keep it for screen readers only. */
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
  /** Extra line under the label. */
  description?: string;
  className?: string;
}

/** An on/off switch with a real label. */
export function Toggle({ checked, onChange, label, hideLabel = false, disabled = false, description, className }: ToggleProps) {
  const id = useId();
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className={cx("toggle-row", disabled && "is-disabled", className)}>
      <span className={cx("toggle-text", hideLabel && "visually-hidden")}>
        <label htmlFor={id} className="toggle-label">
          {label}
        </label>
        {description && (
          <span id={descId} className="toggle-description">
            {description}
          </span>
        )}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={descId}
        disabled={disabled}
        className={cx("switch", checked && "is-on")}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" aria-hidden />
      </button>
    </div>
  );
}
