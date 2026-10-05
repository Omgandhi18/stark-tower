import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "../cx";
import { ICON_SIZE, ICON_STROKE } from "../icons";
import { CountBadge } from "./Badge";

interface SectionHeaderProps {
  title: string;
  icon?: LucideIcon;
  count?: number;
  /** Right-aligned controls. */
  actions?: ReactNode;
  as?: "h2" | "h3";
  className?: string;
}

/** A section title with an optional count and actions. */
export function SectionHeader({ title, icon: Icon, count, actions, as: Heading = "h2", className }: SectionHeaderProps) {
  return (
    <div className={cx("section-header", className)}>
      {Icon && <Icon aria-hidden size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} className="section-header-icon" />}
      <Heading className="section-title">{title}</Heading>
      {count !== undefined && <CountBadge count={count} label="items" tone="neutral" showZero />}
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Accessible name when the panel is a landmark region. */
  label?: string;
}

/** A raised card. Use only where elevation means something (grouping, focus). */
export function Panel({ children, className, label }: PanelProps) {
  return (
    <section className={cx("panel", className)} aria-label={label}>
      {children}
    </section>
  );
}
