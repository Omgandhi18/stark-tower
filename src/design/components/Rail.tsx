import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import { RAIL_HOME } from "../usePeek";
import { CountBadge, type BadgeTone } from "./Badge";

interface RailProps {
  /** Names the group for screen readers ("Side panel, collapsed"). */
  label: string;
  children: ReactNode;
  className?: string;
}

/** A collapsed side panel: its controls as a column of icons, each still doing its job. */
export function Rail({ label, children, className }: RailProps) {
  return (
    <div role="group" aria-label={label} className={cx("rail", className)}>
      {children}
    </div>
  );
}

interface RailButtonProps {
  label: string;
  icon?: LucideIcon;
  /** Drawn instead of the icon (a portrait, say). */
  children?: ReactNode;
  /** A badge on the icon's corner; hidden at zero. */
  count?: number;
  tone?: BadgeTone;
  /** What the panel is showing, or the task on screen. */
  current?: boolean;
  /** Where keyboard focus goes back to when the peeked panel is put away. */
  home?: boolean;
  /** The tooltip; the label by default. */
  title?: string;
  onClick: (fromKeyboard: boolean) => void;
}

export function RailButton({ label, icon: Icon, children, count = 0, tone = "neutral", current, home, title, onClick }: RailButtonProps) {
  return (
    <button
      type="button"
      className={cx("rail-btn", current && "is-current")}
      aria-label={count > 0 ? `${label} (${count})` : label}
      aria-current={current ? "true" : undefined}
      title={title ?? label}
      {...(home ? { [RAIL_HOME]: "" } : {})}
      // A click from Enter or Space carries no click count.
      onClick={(e) => onClick(e.detail === 0)}
    >
      {children ?? (Icon && <Icon aria-hidden size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />)}
      <CountBadge count={count} label={label} tone={tone} className="rail-badge" />
    </button>
  );
}

export function RailDivider() {
  return <span className="rail-divider" aria-hidden />;
}
