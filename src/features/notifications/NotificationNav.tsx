import { Bell, History, Newspaper, type LucideIcon } from "lucide-react";
import { Button, CountBadge, SelectField, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { Agent, ProjectInfo } from "../../lib/types";
import { KIND_OPTIONS, NO_FILTERS, type NotificationFilters, type NotificationView } from "./notificationModel";

const VIEWS: ReadonlyArray<{ id: NotificationView; label: string; icon: LucideIcon }> = [
  { id: "needs-you", label: "Needs you", icon: Bell },
  { id: "updates", label: "Updates", icon: Newspaper },
  { id: "history", label: "History", icon: History },
];

interface NotificationNavProps {
  view: NotificationView;
  counts: Record<NotificationView, number>;
  onView: (view: NotificationView) => void;
  filters: NotificationFilters;
  onFilters: (filters: NotificationFilters) => void;
  projects: readonly ProjectInfo[];
  agents: readonly Agent[];
}

/** The three views, and filters that narrow any of them. */
export default function NotificationNav({ view, counts, onView, filters, onFilters, projects, agents }: NotificationNavProps) {
  const filtered = filters.project || filters.agent || filters.kind;
  return (
    <div className="notification-nav">
      <nav className="notification-views" aria-label="Notification views">
        {VIEWS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cx("notification-view", id === view && "is-current")}
            aria-current={id === view ? "page" : undefined}
            onClick={() => onView(id)}
          >
            <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
            {label}
            <CountBadge count={counts[id]} label={label} tone={id === "needs-you" ? "danger" : "neutral"} />
          </button>
        ))}
      </nav>
      <div className="notification-filters">
        <div className="notification-filters-head">
          <h2 className="notification-filters-title">Filters</h2>
          {filtered && (
            <Button size="sm" variant="ghost" onClick={() => onFilters(NO_FILTERS)}>
              Clear all
            </Button>
          )}
        </div>
        <SelectField
          label="Project"
          value={filters.project}
          options={[{ value: "", label: "All projects" }, ...projects.map((p) => ({ value: p.path, label: p.name }))]}
          onChange={(project) => onFilters({ ...filters, project })}
        />
        <SelectField
          label="Agent"
          value={filters.agent}
          options={[{ value: "", label: "All agents" }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
          onChange={(agent) => onFilters({ ...filters, agent })}
        />
        <SelectField
          label="Type"
          value={filters.kind}
          options={[{ value: "", label: "All types" }, ...KIND_OPTIONS]}
          onChange={(kind) => onFilters({ ...filters, kind })}
        />
      </div>
    </div>
  );
}
