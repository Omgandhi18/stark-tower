import { ChevronDown, type LucideIcon } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE, type PopoverTriggerProps } from "../../design";

interface ComposerChipProps {
  trigger: PopoverTriggerProps;
  icon: LucideIcon;
  text: string;
  /** What it changes ("FRIDAY's model"). */
  title: string;
  className?: string;
}

/** A setting under the message box that opens its own picker. */
export default function ComposerChip({ trigger, icon: Icon, text, title, className }: ComposerChipProps) {
  return (
    <button {...trigger} type="button" className={cx("composer-chip", className)} aria-haspopup="dialog" title={title}>
      <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
      <span className="composer-chip-text">{text}</span>
      <ChevronDown aria-hidden className="composer-chip-chevron" size={12} strokeWidth={ICON_STROKE} />
    </button>
  );
}
