import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../design";

interface AutomationCardProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Short current state ("Every 30 minutes", "Off"). */
  status: string;
  active: boolean;
  error?: string | null;
  footnote?: string;
  children: ReactNode;
}

export default function AutomationCard({ icon: Icon, title, description, status, active, error, footnote, children }: AutomationCardProps) {
  return (
    <section className={cx("automation-card", active && "is-active")} aria-label={title}>
      <header className="automation-head">
        <span className="automation-icon" aria-hidden>
          <Icon size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} />
        </span>
        <div className="automation-heading">
          <h2 className="automation-title">{title}</h2>
          <p className="automation-description">{description}</p>
        </div>
        <span className={cx("automation-status", active && "is-on")}>{status}</span>
      </header>
      <div className="automation-controls">{children}</div>
      {error && (
        <p className="automation-error" role="alert">
          {error}
        </p>
      )}
      {footnote && <p className="automation-footnote">{footnote}</p>}
    </section>
  );
}
