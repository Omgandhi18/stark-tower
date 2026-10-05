import { useCallback, useEffect, useRef, useState } from "react";
import { getTaskDetail, onChatEvent, onTaskEvent, onTasksChanged } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { TaskDetail } from "../../lib/types";

/** Bursts of activity (every tool call) refresh the screen at most this often. */
const REFRESH_MS = 800;

type DetailState = { status: "loading" } | { status: "missing" } | { status: "error"; message: string } | { status: "ready"; detail: TaskDetail };

/** A task's full detail, kept fresh while its agents work. */
export function useTaskDetail(taskId: string | null) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const timer = useRef<number | null>(null);
  const conversation = state.status === "ready" ? state.detail.task.conversation_id : null;

  const load = useCallback(() => {
    if (!taskId) return;
    getTaskDetail(taskId)
      .then((detail) => setState(detail ? { status: "ready", detail } : { status: "missing" }))
      .catch((e) => setState({ status: "error", message: errorMessage(e, "The task couldn't be loaded.") }));
  }, [taskId]);

  const refreshSoon = useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      load();
    }, REFRESH_MS);
  }, [load]);

  useEffect(() => {
    load();
    const subscriptions = [
      onTasksChanged(refreshSoon),
      onTaskEvent((e) => {
        if (e.task_id === taskId) refreshSoon();
      }),
    ];
    return () => {
      for (const s of subscriptions) s.then((off) => off()).catch(() => undefined);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, [taskId, load, refreshSoon]);

  // The conversation fills in as the owner works.
  useEffect(() => {
    if (conversation === null) return;
    const off = onChatEvent((e) => {
      if (e.conversationId === conversation || e.taskId === taskId) refreshSoon();
    });
    return () => {
      off.then((stop) => stop()).catch(() => undefined);
    };
  }, [conversation, taskId, refreshSoon]);

  return { state, reload: load };
}
