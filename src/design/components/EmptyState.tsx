import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** One or two sentences: why it's empty and how to fill it. */
  body?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}

export function EmptyState({ icon: Icon, title, body, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cx("empty-state", compact && "is-compact", className)}>
      <span className="empty-state-icon" aria-hidden>
        <Icon size={compact ? ICON_SIZE.lg : ICON_SIZE.xl} strokeWidth={ICON_STROKE} />
      </span>
      <p className="empty-state-title">{title}</p>
      {body && <p className="empty-state-body">{body}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

interface SkeletonRowsProps {
  rows?: number;
  className?: string;
  /** Names what is loading, for screen readers. */
  label: string;
}

/** Placeholder rows shaped like the content they stand in for. */
export function SkeletonRows({ rows = 3, className, label }: SkeletonRowsProps) {
  return (
    <div className={cx("skeleton-rows", className)} role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-row">
          <span className="skeleton skeleton-avatar" />
          <span className="skeleton-lines">
            <span className="skeleton skeleton-line" />
            <span className="skeleton skeleton-line is-short" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: string }) {
  return <kbd className="kbd">{children}</kbd>;
}
