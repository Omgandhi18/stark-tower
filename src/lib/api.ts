import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Agent,
  ChatEvent,
  DispatchResult,
  LedgerEntry,
  ProjectsState,
  PtyData,
  ReviewRequest,
  StatusEvent,
  StoredMessage,
} from "./types";

// ---- Commands (Rust) --------------------------------------------------------

export const listAgents = () => invoke<Agent[]>("list_agents");

export const getLedger = (limit = 60) =>
  invoke<LedgerEntry[]>("get_ledger", { limit });

export const spawnAgent = (agentId: string, cols: number, rows: number) =>
  invoke<void>("spawn_agent", { agentId, cols, rows });

export const ptyWrite = (agentId: string, data: string) =>
  invoke<void>("pty_write", { agentId, data });

export const ptyResize = (agentId: string, cols: number, rows: number) =>
  invoke<void>("pty_resize", { agentId, cols, rows });

export const killAgent = (agentId: string) =>
  invoke<void>("kill_agent", { agentId });

export const dispatchTask = (prompt: string, cols: number, rows: number) =>
  invoke<DispatchResult>("dispatch_task", { prompt, cols, rows });

// ---- Chat (headless Claude Code) ----

export const chatSend = (agentId: string, text: string, dir?: string) =>
  invoke<void>("chat_send", { agentId, text, dir: dir ?? null });

export const chatStop = (agentId: string) =>
  invoke<void>("chat_stop", { agentId });

/** Load an agent's persisted transcript to rehydrate the chat on reopen. */
export const getChat = (agentId: string, limit?: number) =>
  invoke<StoredMessage[]>("get_chat", { agentId, limit: limit ?? null });

export const onChatEvent = (cb: (e: ChatEvent) => void): Promise<UnlistenFn> =>
  listen<ChatEvent>("chat://event", (evt) => cb(evt.payload));

// ---- Human-in-the-loop review (the lavish alternative) ----

export const onReviewRequest = (
  cb: (r: ReviewRequest) => void,
): Promise<UnlistenFn> =>
  listen<ReviewRequest>("review://request", (evt) => cb(evt.payload));

export const reviewRespond = (id: string, decision: string) =>
  invoke<void>("review_respond", { id, decision });

export const getProject = () => invoke<string>("get_project");

export const listProjects = () => invoke<ProjectsState>("list_projects");

export const setProject = (path: string) =>
  invoke<ProjectsState>("set_project", { path });

export const addProject = (path: string) =>
  invoke<ProjectsState>("add_project", { path });

export const removeProject = (path: string) =>
  invoke<ProjectsState>("remove_project", { path });

export const requestAssist = (
  from: string,
  to: string,
  note: string,
  cols: number,
  rows: number,
) => invoke<void>("request_assist", { from, to, note, cols, rows });

// ---- Events (Rust -> UI) ----------------------------------------------------

export const onPtyData = (cb: (e: PtyData) => void): Promise<UnlistenFn> =>
  listen<PtyData>("pty://data", (evt) => cb(evt.payload));

export const onAgentStatus = (cb: (e: StatusEvent) => void): Promise<UnlistenFn> =>
  listen<StatusEvent>("agent://status", (evt) => cb(evt.payload));

export const onLedgerEntry = (cb: (e: LedgerEntry) => void): Promise<UnlistenFn> =>
  listen<LedgerEntry>("ledger://entry", (evt) => cb(evt.payload));

export const onBreakerTrip = (cb: (agentId: string) => void): Promise<UnlistenFn> =>
  listen<string>("breaker://trip", (evt) => cb(evt.payload));

export const onAssistLink = (
  cb: (e: { from: string; to: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ from: string; to: string }>("assist://link", (evt) => cb(evt.payload));
