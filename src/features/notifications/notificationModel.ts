// How the Notification Centre slices its record: by view, filter and search,
// grouped by day. Pure functions over the stored notifications.
import {
  AlarmClock,
  CalendarX2,
  CircleCheckBig,
  FileSearch,
  MessageCircleQuestion,
  OctagonAlert,
  ShieldAlert,
  ShieldCheck,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { StateTone } from "../../lib/status";
import type { Notification } from "../../lib/types";
import { needsYou } from "../../stores/notifications";

export type NotificationView = "needs-you" | "updates" | "history";
export type NotificationSort = "newest" | "oldest";

export interface NotificationFilters {
  project: string;
  agent: string;
  kind: string;
}

export const NO_FILTERS: NotificationFilters = { project: "", agent: "", kind: "" };

export interface KindPresentation {
  label: string;
  /** After the agent's name: "needs your approval". */
  verb: string;
  tone: StateTone;
  icon: LucideIcon;
}

const KINDS: Record<string, KindPresentation> = {
  approval: { label: "Approval", verb: "needs your approval", tone: "attention", icon: ShieldAlert },
  question: { label: "Question", verb: "has a question", tone: "review", icon: MessageCircleQuestion },
  review: { label: "Review", verb: "needs your review", tone: "review", icon: FileSearch },
  task_ready: { label: "Ready for review", verb: "is ready for review", tone: "review", icon: CircleCheckBig },
  task_blocked: { label: "Blocked", verb: "is blocked", tone: "danger", icon: OctagonAlert },
  check_failed: { label: "Failed check", verb: "had a check fail", tone: "danger", icon: TriangleAlert },
  rule_used: { label: "Allowed by a rule", verb: "went ahead under your rule", tone: "success", icon: ShieldCheck },
  automation_missed: { label: "Missed run", verb: "missed a scheduled run", tone: "attention", icon: CalendarX2 },
  automation_failed: { label: "Run didn't start", verb: "couldn't start a scheduled run", tone: "danger", icon: CalendarX2 },
  reminder: { label: "Reminder", verb: "reminds you", tone: "attention", icon: AlarmClock },
};

export const KIND_OPTIONS = Object.entries(KINDS).map(([value, k]) => ({ value, label: k.label }));

export const presentKind = (kind: string): KindPresentation => KINDS[kind] ?? KINDS.review;

const inView = (n: Notification, view: NotificationView) =>
  view === "needs-you" ? needsYou(n) : view === "updates" ? n.urgency === "update" : true;

const matches = (n: Notification, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || [n.title, n.body, n.agent_id, n.cwd].some((field) => field.toLowerCase().includes(q));
};

const inProject = (cwd: string, project: string) => !project || cwd === project || cwd.startsWith(`${project}/`);

/** The notifications one view shows, filtered, searched and sorted. */
export function visibleNotifications(
  items: readonly Notification[],
  view: NotificationView,
  filters: NotificationFilters,
  query: string,
  sort: NotificationSort,
): Notification[] {
  const shown = items.filter(
    (n) =>
      inView(n, view) &&
      inProject(n.cwd, filters.project) &&
      (!filters.agent || n.agent_id === filters.agent) &&
      (!filters.kind || n.kind === filters.kind) &&
      matches(n, query),
  );
  return [...shown].sort((a, b) => (sort === "newest" ? b.ts - a.ts : a.ts - b.ts));
}

export function viewCounts(items: readonly Notification[]) {
  return {
    "needs-you": items.filter(needsYou).length,
    updates: items.filter((n) => n.urgency === "update" && !n.read).length,
    history: 0,
  } satisfies Record<NotificationView, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "Today", "Yesterday", or the date. */
export function dayLabel(at: number, now: number): string {
  const today = startOfDay(now);
  const day = startOfDay(at);
  if (day === today) return "Today";
  if (day === today - DAY_MS) return "Yesterday";
  return new Date(at).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
}

/** Consecutive runs of notifications from the same day. */
export function groupByDay(items: readonly Notification[], now: number): Array<{ label: string; items: Notification[] }> {
  const groups: Array<{ label: string; items: Notification[] }> = [];
  for (const n of items) {
    const label = dayLabel(n.ts, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(n);
    else groups.push({ label, items: [n] });
  }
  return groups;
}
