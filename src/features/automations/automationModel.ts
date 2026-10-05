// How Automations words schedules, settings and runs, and slices the list.
// Pure functions over the stored automations, so the wording can be tested.
import { AlarmClockOff, CircleCheck, CircleDashed, CirclePause, CircleX, SkipForward, type LucideIcon } from "lucide-react";
import type { StateTone } from "../../lib/status";
import type { Automation, AutomationInput, AutomationRun, Schedule } from "../../lib/types";

/** Monday first, matching the backend's day numbers (0 = Monday). */
export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const HOURS_PER_HALF_DAY = 12;
const DAYS_AHEAD_BY_NAME = 6;
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTES_PER_HOUR = 60;

export const DEFAULT_TIME = "09:00";
export const DEFAULT_HOURS = 4;
export const DEFAULT_MAX_MINUTES = 60;

export type ScheduleKind = Schedule["kind"];

export const SCHEDULE_KINDS: ReadonlyArray<{ value: ScheduleKind; label: string }> = [
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Once a week" },
  { value: "everyHours", label: "Every few hours" },
];

export const HOUR_CHOICES = [1, 2, 3, 4, 6, 8, 12, 24] as const;
export const RUNTIME_CHOICES = [15, 30, 60, 120, 240, 480] as const;

interface PolicyOption {
  value: string;
  /** In the editor. */
  label: string;
  /** In the summary of an automation. */
  summary: string;
}

export const MISSED_OPTIONS: readonly PolicyOption[] = [
  { value: "run_once", label: "Run it once, as soon as it can", summary: "Runs once at the next chance" },
  { value: "skip", label: "Skip it and wait for the next run", summary: "Skips it and waits for the next run" },
  { value: "ask", label: "Ask me first", summary: "Asks you whether to run it" },
];

export const NOTIFY_OPTIONS: readonly PolicyOption[] = [
  { value: "failure", label: "Only when a run fails or stops", summary: "When a run fails or stops" },
  { value: "always", label: "After every run", summary: "After every run" },
  { value: "never", label: "Never; I'll check here", summary: "Never; results stay here" },
];

const summaryOf = (options: readonly PolicyOption[], value: string) => options.find((o) => o.value === value)?.summary ?? value;
export const describeMissed = (policy: string) => summaryOf(MISSED_OPTIONS, policy);
export const describeNotify = (policy: string) => summaryOf(NOTIFY_OPTIONS, policy);

/** "02:00" → "2:00 AM". */
export function formatClock(time: string): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m)) return time;
  const suffix = h < HOURS_PER_HALF_DAY ? "AM" : "PM";
  const hour = h % HOURS_PER_HALF_DAY === 0 ? HOURS_PER_HALF_DAY : h % HOURS_PER_HALF_DAY;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

const clockOf = (at: Date) => formatClock(`${at.getHours()}:${at.getMinutes()}`);

/** "Every weekday at 2:00 AM", "Every Thursday at 5:00 PM", "Every 4 hours". */
export function describeSchedule(schedule: Schedule): string {
  switch (schedule.kind) {
    case "daily":
      return `Every day at ${formatClock(schedule.time)}`;
    case "weekdays":
      return `Every weekday at ${formatClock(schedule.time)}`;
    case "weekly":
      return `Every ${WEEKDAYS[schedule.day] ?? "week"} at ${formatClock(schedule.time)}`;
    case "everyHours":
      return schedule.hours === 1 ? "Every hour" : `Every ${schedule.hours} hours`;
  }
}

/** The same schedule as another kind, keeping its time, day or hours where they carry over. */
export function withKind(schedule: Schedule, kind: ScheduleKind): Schedule {
  const time = "time" in schedule ? schedule.time : DEFAULT_TIME;
  switch (kind) {
    case "daily":
    case "weekdays":
      return { kind, time };
    case "weekly":
      return { kind, day: "day" in schedule ? schedule.day : 0, time };
    case "everyHours":
      return { kind, hours: "hours" in schedule ? schedule.hours : DEFAULT_HOURS };
  }
}

const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A coming run: "Today at 5:00 PM", "Tomorrow at 2:00 AM", "Thursday at 9:00 AM", "Oct 20 at 9:00 AM". */
export function formatWhen(at: number, now: number): string {
  const date = new Date(at);
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  const clock = clockOf(date);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Tomorrow at ${clock}`;
  if (days === -1) return `Yesterday at ${clock}`;
  if (days > 1 && days <= DAYS_AHEAD_BY_NAME) return `${WEEKDAYS[(date.getDay() + 6) % 7]} at ${clock}`;
  return `${MONTHS[date.getMonth()]} ${date.getDate()} at ${clock}`;
}

/** A run's place in the history: "Oct 5, 2:00 AM". */
export function formatStamp(at: number): string {
  const date = new Date(at);
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${clockOf(date)}`;
}

/** "45 minutes", "1 hour", "1 hour 30 minutes", "8 hours". */
export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  const rest = minutes % MINUTES_PER_HOUR;
  const h = hours === 1 ? "1 hour" : `${hours} hours`;
  const m = rest === 1 ? "1 minute" : `${rest} minutes`;
  if (!hours) return m;
  return rest ? `${h} ${m}` : h;
}

/** The runtime choices, including an automation's own limit if it's not a standard one. */
export function runtimeChoices(current: number): number[] {
  const choices: number[] = [...RUNTIME_CHOICES];
  return choices.includes(current) ? choices : [...choices, current].sort((a, b) => a - b);
}

export interface RunPresentation {
  label: string;
  tone: StateTone;
  icon: LucideIcon;
}

const RUNS: Record<string, RunPresentation> = {
  running: { label: "Running", tone: "running", icon: CircleDashed },
  succeeded: { label: "Finished", tone: "success", icon: CircleCheck },
  failed: { label: "Failed", tone: "danger", icon: CircleX },
  missed: { label: "Missed", tone: "attention", icon: AlarmClockOff },
  skipped: { label: "Skipped", tone: "idle", icon: SkipForward },
};

export const presentRun = (status: string): RunPresentation => RUNS[status] ?? RUNS.skipped;

const TRIGGERS: Record<string, string> = { you: "Run by you", late: "Ran late" };

/** What started a run, when it wasn't simply its schedule. */
export const presentTrigger = (trigger: string): string | null => TRIGGERS[trigger] ?? null;

/** How long a run took, once it has both ends. */
export const runDuration = (run: AutomationRun): number | null =>
  run.started !== null && run.finished !== null ? Math.max(0, run.finished - run.started) : null;

/** How an automation is doing, in a word or two. */
export function automationHealth(a: Automation): RunPresentation {
  if (!a.enabled) return { label: "Paused", tone: "idle", icon: CirclePause };
  switch (a.last_status) {
    case "running":
      return { label: "Running now", tone: "running", icon: CircleDashed };
    case "failed":
      return { label: "Last run failed", tone: "danger", icon: CircleX };
    case "missed":
      return { label: "Missed its last run", tone: "attention", icon: AlarmClockOff };
    case "succeeded":
      return { label: "Healthy", tone: "success", icon: CircleCheck };
    default:
      return { label: "Waiting for its first run", tone: "idle", icon: CircleDashed };
  }
}

export type AutomationFilter = "all" | "active" | "paused";

/** The automations one filter and search show, in name order. */
export function visibleAutomations(items: readonly Automation[], filter: AutomationFilter, query: string): Automation[] {
  const q = query.trim().toLowerCase();
  return items
    .filter((a) => filter === "all" || (filter === "active" ? a.enabled : !a.enabled))
    .filter((a) => !q || [a.name, a.instruction, a.agent_id, a.cwd].some((field) => field.toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** What the editor starts from: an automation as it is, or a new one. */
export function draftFor(a: Automation | undefined, defaults: { agentId: string; cwd: string }): AutomationInput {
  if (a) {
    const { id, name, agent_id, cwd, instruction, schedule, enabled, missed, notify, max_minutes, wake } = a;
    return { id, name, agent_id, cwd, instruction, schedule, enabled, missed, notify, max_minutes, wake };
  }
  return {
    id: null,
    name: "",
    agent_id: defaults.agentId,
    cwd: defaults.cwd,
    instruction: "",
    schedule: { kind: "weekdays", time: DEFAULT_TIME },
    enabled: true,
    missed: "run_once",
    notify: "failure",
    max_minutes: DEFAULT_MAX_MINUTES,
    wake: false,
  };
}
