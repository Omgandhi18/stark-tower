import type { ReactNode } from "react";
import { cx } from "../cx";

interface KeepAliveProps {
  active: boolean;
  children: ReactNode;
  className?: string;
  label?: string;
}

/**
 * Keeps a view mounted while another is shown. The hidden view keeps its size,
 * scroll offsets and state, and is skipped for painting, focus and assistive tech.
 */
export function KeepAlive({ active, children, className, label }: KeepAliveProps) {
  return (
    <div
      className={cx("keep-alive", !active && "is-inactive", className)}
      inert={!active}
      aria-hidden={!active || undefined}
      aria-label={label}
    >
      {children}
    </div>
  );
}
