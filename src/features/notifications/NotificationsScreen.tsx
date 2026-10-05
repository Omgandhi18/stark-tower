import { useEffect, useMemo, useState } from "react";
import { BellRing } from "lucide-react";
import { EmptyState, ICON_STROKE } from "../../design";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import { useNotifications } from "../../stores/notifications";
import { useWorkspace } from "../../stores/workspace";
import NotificationList from "./NotificationList";
import NotificationNav from "./NotificationNav";
import NotificationSummary from "./NotificationSummary";
import ReviewDetail from "./ReviewDetail";
import { NO_FILTERS, viewCounts, visibleNotifications, type NotificationFilters, type NotificationSort, type NotificationView } from "./notificationModel";
import "./notifications.css";

const CLOCK_MS = 30_000;
const HEADER_ICON_SIZE = 26;

/** Everything that needs you, every update, and the full history, across projects. */
export default function NotificationsScreen() {
  const items = useNotifications((s) => s.items);
  const markRead = useNotifications((s) => s.markRead);
  const markAllRead = useNotifications((s) => s.markAllRead);
  const pending = useAttention((s) => s.pending);
  const agents = useAgents((s) => s.agents);
  const projects = useWorkspace((s) => s.projects);
  const reviewId = useNavigation((s) => s.reviewId);
  const notificationId = useNavigation((s) => s.notificationId);
  const focusNotification = useNavigation((s) => s.focusNotification);
  const [view, setView] = useState<NotificationView>("needs-you");
  const [filters, setFilters] = useState<NotificationFilters>(NO_FILTERS);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<NotificationSort>("newest");
  const now = useNow(CLOCK_MS);

  const visible = useMemo(() => visibleNotifications(items, view, filters, query, sort), [items, view, filters, query, sort]);
  const counts = useMemo(() => viewCounts(items), [items]);
  // A review opened from elsewhere (Work, a task) selects its notification.
  const requested = reviewId ? items.find((n) => n.review_id === reviewId) : items.find((n) => n.id === notificationId);
  const selected = requested ?? visible[0];
  const review = selected?.review_id ? pending.find((r) => r.id === selected.review_id) : undefined;

  useEffect(() => {
    if (selected && !selected.read) void markRead([selected.id]).catch(() => undefined);
  }, [selected, markRead]);

  return (
    <div className="notifications-screen">
      <header className="notifications-header">
        <BellRing aria-hidden size={HEADER_ICON_SIZE} strokeWidth={ICON_STROKE} className="notifications-header-icon" />
        <div>
          <h1 className="screen-title">Notifications</h1>
          <p className="screen-subtitle">What your agents need from you, and what they did, across every project.</p>
        </div>
      </header>
      <div className="notifications-body">
        <NotificationNav view={view} counts={counts} onView={setView} filters={filters} onFilters={setFilters} projects={projects} agents={agents} />
        <NotificationList
          view={view}
          items={visible}
          agents={agents}
          selectedId={selected?.id ?? null}
          onSelect={focusNotification}
          query={query}
          onQuery={setQuery}
          sort={sort}
          onSort={setSort}
          onMarkAllRead={() => void markAllRead().catch(() => undefined)}
          now={now}
        />
        <div className="notification-detail-pane">
          {selected ? (
            review ? (
              <ReviewDetail key={review.id} review={review} agent={agents.find((a) => a.id === review.agentId)} now={now} />
            ) : (
              <NotificationSummary key={selected.id} notification={selected} agent={agents.find((a) => a.id === selected.agent_id)} now={now} />
            )
          ) : (
            <EmptyState icon={BellRing} title="Pick a notification" body="Its details and any decision it needs appear here." />
          )}
        </div>
      </div>
    </div>
  );
}
