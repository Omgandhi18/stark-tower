// When reminders go off, how they repeat, and how the Reminders screen groups them.
import type { Reminder, Schedule } from "../../lib/types";
import { describeSchedule, formatWhen } from "../automations/automationModel";

const MINUTE = 60_000;
const MORNING_HOUR = 9;
const EVENING_HOUR = 18;

/** `hour`:00 on the day `days` after `now`'s. */
const dayAt = (now: number, days: number, hour: number) => {
  const d = new Date(now);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

export interface WhenChoice {
  id: string;
  label: string;
  at: number;
}

/** Quick times to set a reminder for; "This evening" only while the evening is still to come. */
export function whenChoices(now: number): WhenChoice[] {
  const choices: WhenChoice[] = [
    { id: "30m", label: "In 30 minutes", at: now + 30 * MINUTE },
    { id: "1h", label: "In 1 hour", at: now + 60 * MINUTE },
  ];
  const evening = dayAt(now, 0, EVENING_HOUR);
  if (evening - now > 60 * MINUTE) choices.push({ id: "evening", label: "This evening", at: evening });
  choices.push({ id: "morning", label: "Tomorrow morning", at: dayAt(now, 1, MORNING_HOUR) });
  return choices;
}

/** Later times for a reminder that went off. */
export function snoozeChoices(now: number): WhenChoice[] {
  return [
    { id: "10m", label: "10 minutes", at: now + 10 * MINUTE },
    { id: "1h", label: "1 hour", at: now + 60 * MINUTE },
    { id: "morning", label: "Tomorrow morning", at: dayAt(now, 1, MORNING_HOUR) },
  ];
}

export type RepeatKind = "never" | "daily" | "weekdays" | "weekly";

export const REPEAT_OPTIONS: ReadonlyArray<{ value: RepeatKind; label: string }> = [
  { value: "never", label: "Never" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
];

const clock = (at: Date) => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

/** The schedule for repeating at `at`'s time of day (and, weekly, its day); null for once. */
export function repeatFor(kind: RepeatKind, at: number): Schedule | null {
  const date = new Date(at);
  const time = clock(date);
  switch (kind) {
    case "never":
      return null;
    case "daily":
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, day: (date.getDay() + 6) % 7, time };
  }
}

export const repeatKind = (repeat: Schedule | null): RepeatKind =>
  repeat?.kind === "daily" || repeat?.kind === "weekdays" || repeat?.kind === "weekly" ? repeat.kind : "never";

/** "YYYY-MM-DDTHH:MM" for a datetime-local input, in local time. */
export function toLocalInput(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${clock(d)}`;
}

/** A datetime-local input's value as a time; null when it's incomplete. */
export function fromLocalInput(value: string): number | null {
  const at = new Date(value).getTime();
  return value && Number.isFinite(at) ? at : null;
}

/** When a reminder goes off, as its row says: "Today at 6:00 PM · Every weekday at 9:00 AM". */
export function describeWhen(r: Reminder, now: number): string {
  const next = formatWhen(r.due, now);
  return r.repeat ? `${next} · ${describeSchedule(r.repeat)}` : next;
}

export interface ReminderGroups {
  /** Went off and waiting on the developer. */
  due: Reminder[];
  /** Still to go off, soonest first. */
  coming: Reminder[];
  /** Finished, latest first. */
  done: Reminder[];
}

/**
 * The screen's sections. A repeating reminder that went off waits for its next time
 * straight away, so it counts as due while its notification is still open.
 */
export function groupReminders(items: readonly Reminder[], open: ReadonlySet<number>): ReminderGroups {
  const due = items.filter((r) => r.status === "due" || (r.status === "waiting" && open.has(r.id)));
  const dueIds = new Set(due.map((r) => r.id));
  return {
    due: due.sort((a, b) => (b.fired ?? 0) - (a.fired ?? 0)),
    coming: items.filter((r) => r.status === "waiting" && !dueIds.has(r.id)).sort((a, b) => a.due - b.due),
    done: items.filter((r) => r.status === "done").sort((a, b) => b.updated - a.updated),
  };
}
