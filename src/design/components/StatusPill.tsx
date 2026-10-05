import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import type { StateTone } from "../../lib/status";

interface StatusPillProps {
  label: string;
  tone: StateTone;
  icon?: LucideIcon;
  /** Spin the icon (a live, in-progress state). Static under reduced motion. */
  live?: boolean;
  className?: string;
}

/** A state label with its colour and icon: never colour alone. */
export function StatusPill({ label, tone, icon: Icon, live = false, className }: StatusPillProps) {
  return (
    <span className={cx("status-pill", `tone-${tone}`, className)}>
      {Icon && (
        <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className={live ? "spin-slow" : undefined} />
      )}
      {label}
    </span>
  );
}
