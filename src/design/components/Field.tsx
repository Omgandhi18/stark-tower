import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";

interface FieldShellProps {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string | null;
  className?: string;
  children: (ids: { id: string; describedBy?: string }) => ReactNode;
}

/** Label above, control, then helper or error text below. */
export function FieldShell({ label, hideLabel, helper, error, className, children }: FieldShellProps) {
  const id = useId();
  const noteId = helper || error ? `${id}-note` : undefined;
  return (
    <div className={cx("field", error && "has-error", className)}>
      <label htmlFor={id} className={cx("field-label", hideLabel && "visually-hidden")}>
        {label}
      </label>
      {children({ id, describedBy: noteId })}
      {(error || helper) && (
        <span id={noteId} className={error ? "field-error" : "field-helper"} role={error ? "alert" : undefined}>
          {error || helper}
        </span>
      )}
    </div>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string | null;
}

export function TextField({ label, hideLabel, helper, error, className, ...input }: TextFieldProps) {
  return (
    <FieldShell label={label} hideLabel={hideLabel} helper={helper} error={error} className={className}>
      {({ id, describedBy }) => (
        <input id={id} aria-describedby={describedBy} aria-invalid={Boolean(error)} className="input" {...input} />
      )}
    </FieldShell>
  );
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  hideLabel?: boolean;
  helper?: string;
  error?: string | null;
}

export function TextArea({ label, hideLabel, helper, error, className, ...input }: TextAreaProps) {
  return (
    <FieldShell label={label} hideLabel={hideLabel} helper={helper} error={error} className={className}>
      {({ id, describedBy }) => (
        <textarea id={id} aria-describedby={describedBy} aria-invalid={Boolean(error)} className="input textarea" {...input} />
      )}
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface SelectFieldProps {
  label: string;
  hideLabel?: boolean;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  helper?: string;
  error?: string | null;
  disabled?: boolean;
  className?: string;
  /** A leading glyph naming what is being chosen (useful when the label is hidden). */
  icon?: LucideIcon;
}

/** A native select (keyboard, VoiceOver and the macOS menu for free). */
export function SelectField({ label, hideLabel, value, options, onChange, helper, error, disabled, className, icon: Icon }: SelectFieldProps) {
  return (
    <FieldShell label={label} hideLabel={hideLabel} helper={helper} error={error} className={className}>
      {({ id, describedBy }) => (
        <span className="select-wrap">
          {Icon && <Icon aria-hidden className="select-icon" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />}
          <select
            id={id}
            aria-describedby={describedBy}
            className={cx("input select", Icon && "has-icon")}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden className="select-chevron" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        </span>
      )}
    </FieldShell>
  );
}
