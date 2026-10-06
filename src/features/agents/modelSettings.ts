// Which model an agent runs on and how hard it thinks: the names pickers show, the levels a
// model takes, and what carries over when the model changes.
import type { ModelChoice } from "../../lib/types";

/** Effort levels from least to most thinking, as the backend sorts them; unknown names go last. */
const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const rank = (level: string) => {
  const at = ORDER.indexOf(level);
  return at < 0 ? ORDER.length : at;
};

const LABELS: Record<string, string> = { xhigh: "Extra high" };

/** "Extra high" for "xhigh", "Max" for "max"; "" is the model's own default. */
export const effortLabel = (level: string) => LABELS[level] ?? (level ? level[0].toUpperCase() + level.slice(1) : "Default");

/** The level in `levels` closest to `wanted`, the lower one on a tie; "" when there are none. */
export function nearestLevel(levels: readonly string[], wanted: string): string {
  if (levels.includes(wanted)) return wanted;
  let best = "";
  for (const level of levels) {
    if (!best || Math.abs(rank(level) - rank(wanted)) < Math.abs(rank(best) - rank(wanted))) best = level;
  }
  return best;
}

/**
 * The effort an agent keeps on moving to `model`: the same level when the model takes it, else
 * the nearest one it does, and none on a model without levels. Kept as it is for a model the
 * provider didn't list (nothing is known about it), and "" stays the model's own default.
 */
export function effortFor(model: ModelChoice | undefined, effort: string): string {
  if (!effort || !model) return effort;
  return nearestLevel(model.efforts, effort);
}

export const findModel = (models: readonly ModelChoice[], id: string) => (id ? models.find((m) => m.id === id) : undefined);

/**
 * What an agent runs on: its own model, else the one set for its provider in Starkline, else the
 * one the provider calls its default. Undefined when that isn't a model the provider listed.
 */
export function runningModel(models: readonly ModelChoice[], agentModel: string, engineModel: string): ModelChoice | undefined {
  const id = agentModel.trim() || engineModel.trim();
  return id ? findModel(models, id) : models.find((m) => m.default);
}

/** The levels to offer: the model's own, or, for one the provider didn't list, every level its models take. */
export function effortLevels(models: readonly ModelChoice[], model: ModelChoice | undefined): string[] {
  if (model) return model.efforts;
  return [...new Set(models.flatMap((m) => m.efforts))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** How a picker names "no model of its own": what that runs on, and where it's set. */
export function defaultChoice(models: readonly ModelChoice[], engineModel: string, providerLabel: string): { name: string; note: string } {
  const set = engineModel.trim();
  if (set) return { name: `Default (${findModel(models, set)?.name ?? set})`, note: `Set for every ${providerLabel} agent in Provider settings` };
  const own = models.find((m) => m.default);
  if (own) return { name: `Default (${own.name})`, note: `${providerLabel}'s default` };
  return { name: "Default", note: `Whatever ${providerLabel} is set to use` };
}

/** One row of the model list. */
export type ModelRow =
  | { kind: "default"; key: string }
  | { kind: "model"; key: string; id: string; model: ModelChoice; older: boolean }
  /** A model ID the provider didn't list: the agent's current one, or the one being typed. */
  | { kind: "custom"; key: string; id: string; typed: boolean }
  /** Shows or hides the older models. */
  | { kind: "more"; key: string; count: number };

/**
 * The rows a model list shows. Unfiltered: the default, the agent's model if the provider didn't
 * list it, the current models, then "More models" (with the older ones under it once opened).
 * Searching lists every match, and offers what was typed as a model ID of its own.
 */
export function modelRows(models: readonly ModelChoice[], value: string, query: string, expanded: boolean): ModelRow[] {
  const listed = (m: ModelChoice, older: boolean): ModelRow => ({ kind: "model", key: `model:${m.id}`, id: m.id, model: m, older });
  const typed = query.trim();
  if (typed) {
    const q = typed.toLowerCase();
    const rows = models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)).map((m) => listed(m, false));
    if (!/\s/.test(typed) && !models.some((m) => m.id === typed)) rows.push({ kind: "custom", key: `custom:${typed}`, id: typed, typed: true });
    return rows;
  }
  const rows: ModelRow[] = [{ kind: "default", key: "default" }];
  if (value && !models.some((m) => m.id === value)) rows.push({ kind: "custom", key: `custom:${value}`, id: value, typed: false });
  rows.push(...models.filter((m) => !m.older).map((m) => listed(m, false)));
  const more = models.filter((m) => m.older);
  if (more.length) {
    rows.push({ kind: "more", key: "more", count: more.length });
    if (expanded) rows.push(...more.map((m) => listed(m, true)));
  }
  return rows;
}

export const isChosen = (row: ModelRow, value: string) =>
  row.kind === "default" ? value === "" : row.kind === "model" || row.kind === "custom" ? row.id === value : false;
