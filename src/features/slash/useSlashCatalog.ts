import { useCallback, useEffect, useRef, useState } from "react";
import { onSlashChanged, slashCatalog } from "../../lib/api";
import type { SlashCatalog } from "../../lib/types";

type Load = { id: string; status: "idle" | "loading" | "ready" | "error"; catalog: SlashCatalog | null };

/** Opening the menu again within this long reuses the answer it has. */
const FRESH_MS = 2000;

/** The last answer for each chat, so reopening the menu shows something at once. */
const recent = new Map<string, SlashCatalog>();

/**
 * What an agent's chat can run and its MCP servers. Asked for the first time the menu is wanted
 * (`request`), then kept current: the chat's session reports its real list shortly after it starts.
 */
export function useSlashCatalog(agentId: string, conversationId: number | null, folder: string) {
  const id = `${agentId}|${conversationId ?? ""}|${folder}`;
  const [load, setLoad] = useState<Load>({ id, status: "idle", catalog: recent.get(id) ?? null });
  // Which chat the menu was asked for, and when it last fetched: both start over for another chat.
  const wantedFor = useRef("");
  const fetched = useRef({ id: "", at: 0 });

  const fetchNow = useCallback(() => {
    fetched.current = { id, at: Date.now() };
    slashCatalog(agentId, conversationId, folder)
      .then((catalog) => {
        recent.set(id, catalog);
        setLoad({ id, status: "ready", catalog });
      })
      .catch(() => setLoad((l) => (recent.has(id) ? l : { id, status: "error", catalog: null })));
  }, [agentId, conversationId, folder, id]);

  const request = useCallback(() => {
    wantedFor.current = id;
    if (fetched.current.id === id && Date.now() - fetched.current.at < FRESH_MS) return;
    setLoad((l) => (l.id === id ? { ...l, status: l.catalog ? "ready" : "loading" } : { id, status: recent.has(id) ? "ready" : "loading", catalog: recent.get(id) ?? null }));
    fetchNow();
  }, [fetchNow, id]);

  useEffect(() => {
    if (conversationId === null) return;
    const off = onSlashChanged((changed) => {
      if (changed === conversationId && wantedFor.current === id) fetchNow();
    });
    return () => void off.then((unlisten) => unlisten());
  }, [conversationId, fetchNow, id]);

  const current: Load = load.id === id ? load : { id, status: "idle", catalog: recent.get(id) ?? null };
  return { catalog: current.catalog, status: current.status, request, reload: fetchNow };
}
