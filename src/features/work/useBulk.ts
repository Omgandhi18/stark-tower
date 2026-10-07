import { useCallback, useMemo, useState } from "react";
import { closeTask, reviewTask } from "../../lib/api";
import type { Task } from "../../lib/types";
import { bulkTargets, taskCount, type BulkAction } from "./bulk";
import type { TaskRow } from "./board";

const APPLY: Record<BulkAction, (id: string) => Promise<unknown>> = { review: reviewTask, close: closeTask };
const DONE_AS: Record<BulkAction, string> = { review: "marked reviewed", close: "closed" };

/** Picking tasks on the board. Picks that leave it (settled elsewhere, or on the other tab) drop out. */
function useTaskSelection(selectable: readonly string[]) {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const selected = useMemo(() => new Set(selectable.filter((id) => picked.has(id))), [selectable, picked]);

  const setMany = useCallback((ids: readonly string[], on: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  const start = useCallback(() => setPicking(true), []);
  const stop = useCallback(() => {
    setPicking(false);
    setPicked(new Set());
  }, []);

  // With nothing left to pick, picking ends by itself.
  return { selecting: picking && selectable.length > 0, selected, setMany, toggle, start, stop };
}

/** Marks tasks reviewed or closes them, all at once, and says how many didn't make it. */
function useBulkRunner() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Resolves to the ids it acted on. */
  const run = useCallback(async (action: BulkAction, tasks: readonly Task[]): Promise<string[]> => {
    const targets = bulkTargets(action, tasks);
    if (targets.length === 0) return [];
    setBusy(true);
    setError(null);
    const results = await Promise.allSettled(targets.map((t) => APPLY[action](t.id)));
    setBusy(false);
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) setError(`${failed} of ${taskCount(targets.length)} couldn't be ${DONE_AS[action]}.`);
    return targets.filter((_, i) => results[i].status === "fulfilled").map((t) => t.id);
  }, []);

  return { busy, error, run, dismissError: useCallback(() => setError(null), []) };
}

/**
 * Everything Work needs to act on many tasks at once: what's picked, running an action,
 * and the close that waits for a yes. Marking reviewed happens straight away; closing
 * asks first, since a closed task can't be brought back from Work.
 */
export function useBulk(rows: readonly TaskRow[]) {
  const ids = useMemo(() => rows.map((r) => r.task.id), [rows]);
  const selection = useTaskSelection(ids);
  const runner = useBulkRunner();
  const [closing, setClosing] = useState<readonly Task[] | null>(null);
  const { run } = runner;
  const { setMany } = selection;

  const perform = useCallback(
    async (action: BulkAction, tasks: readonly Task[]) => {
      const acted = await run(action, tasks);
      setMany(acted, false);
    },
    [run, setMany],
  );

  const request = useCallback(
    (action: BulkAction, tasks: readonly Task[]) => {
      if (action === "close") setClosing(tasks);
      else void perform(action, tasks);
    },
    [perform],
  );

  const confirmClose = useCallback(() => {
    if (closing) void perform("close", closing);
    setClosing(null);
  }, [closing, perform]);

  const selectedTasks = useMemo(() => rows.filter((r) => selection.selected.has(r.task.id)).map((r) => r.task), [rows, selection.selected]);

  return {
    ...selection,
    ...runner,
    selectedTasks,
    closing,
    request,
    confirmClose,
    cancelClose: useCallback(() => setClosing(null), []),
  };
}

export type Bulk = ReturnType<typeof useBulk>;
