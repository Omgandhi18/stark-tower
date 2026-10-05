import { BellOff, CheckCheck, Search } from "lucide-react";
import { Button, EmptyState, InlineCode, Portrait, SelectField, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { formatRelative } from "../../lib/time";
import type { Agent, Notification } from "../../lib/types";
import { needsYou } from "../../stores/notifications";
import { folderName } from "../../stores/workspace";
import { groupByDay, presentKind, type NotificationSort, type NotificationView } from "./notificationModel";

const SORTS = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
];

const EMPTY: Record<NotificationView, { title: string; body: string }> = {
  "needs-you": { title: "Nothing needs you", body: "Approvals, questions, finished or blocked work, and missed runs show up here." },
  updates: { title: "No updates", body: "Failed checks and actions your rules allowed show up here." },
  history: { title: "Nothing yet", body: "Every notification stays here until you archive it." },
};

interface NotificationListProps {
  view: NotificationView;
  items: readonly Notification[];
  agents: readonly Agent[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  query: string;
  onQuery: (query: string) => void;
  sort: NotificationSort;
  onSort: (sort: NotificationSort) => void;
  onMarkAllRead: () => void;
  now: number;
}

export default function NotificationList({ view, items, agents, selectedId, onSelect, query, onQuery, sort, onSort, onMarkAllRead, now }: NotificationListProps) {
  const groups = groupByDay(items, now);
  return (
    <section className="notification-list" aria-label="Notifications">
      <div className="notification-tools">
        <label className="notification-search">
          <Search aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          <input
            type="search"
            className="selectable"
            placeholder="Search notifications"
            aria-label="Search notifications"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </label>
        <Button icon={CheckCheck} onClick={onMarkAllRead}>
          Mark all as read
        </Button>
        <SelectField label="Order" hideLabel value={sort} options={SORTS} onChange={(value) => onSort(value as NotificationSort)} className="notification-sort" />
      </div>
      {items.length === 0 ? (
        <EmptyState icon={BellOff} title={query ? "No matches" : EMPTY[view].title} body={query ? "Try other words or clear the filters." : EMPTY[view].body} />
      ) : (
        <div className="notification-groups">
          {groups.map((group) => (
            <section key={group.label} className="notification-group" aria-label={group.label}>
              <h3 className="notification-day">{group.label}</h3>
              <ul className="notification-items">
                {group.items.map((n) => {
                  const kind = presentKind(n.kind);
                  const agent = agents.find((a) => a.id === n.agent_id);
                  const name = agent?.name ?? n.agent_id;
                  return (
                    <li key={n.id}>
                      <button
                        type="button"
                        className={cx("notification-item", `tone-${kind.tone}`, n.id === selectedId && "is-selected", !n.read && "is-unread")}
                        aria-current={n.id === selectedId ? "true" : undefined}
                        onClick={() => onSelect(n.id)}
                      >
                        <Portrait name={name} figure={agent?.figure} accent={agent?.accent} size={40} />
                        <span className="notification-text">
                          <span className="notification-who">
                            <span className="notification-agent">{name}</span>
                            <span className="notification-verb">{kind.verb}</span>
                            <time className="notification-time">{formatRelative(n.ts, now)}</time>
                          </span>
                          <span className="notification-title">
                            <InlineCode text={n.title} />
                          </span>
                          {n.body && (
                            <span className="notification-body">
                              <InlineCode text={n.body} />
                            </span>
                          )}
                          <span className="notification-tags">
                            {n.cwd && <Tag>{folderName(n.cwd)}</Tag>}
                            <Tag tone={needsYou(n) ? "attention" : "neutral"}>{kind.label}</Tag>
                            {n.outcome && <Tag tone="success">{n.outcome}</Tag>}
                          </span>
                        </span>
                        {!n.read && <span className="notification-unread" aria-label="Unread" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
