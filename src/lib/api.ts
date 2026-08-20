import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, type Result } from "./bindings";
import type {
  ChatEvent,
  LedgerEntry,
  PtyData,
  ReviewRequest,
  StatusEvent,
  UsageUpdate,
  UpdateStatus,
} from "./types";

// Commands are the tauri-specta-generated, typed wrappers (bindings.ts). Fallible
// Rust commands (Result<T, String>) return a Result here; `ok()` unwraps it back
// to the throwing contract the app already expects.
async function ok<T>(p: Promise<Result<T, string>>): Promise<T> {
  const r = await p;
  if (r.status === "error") throw new Error(r.error);
  return r.data;
}

// ---- Commands (Rust) --------------------------------------------------------

export const listAgents = () => commands.listAgents();

export const getLedger = (limit = 60) => commands.getLedger(limit);

export const getTasks = (limit?: number) => commands.getTasks(limit ?? null);

export const onTasksChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("tasks://changed", () => cb());

/** An agent's durable memory markdown (what it curates across sessions). */
export const getMemory = (agentId: string) => commands.getMemory(agentId);

export const spawnAgent = (agentId: string, cols: number, rows: number) =>
  ok(commands.spawnAgent(agentId, cols, rows));

export const ptyWrite = (agentId: string, data: string) =>
  ok(commands.ptyWrite(agentId, data));

export const ptyResize = (agentId: string, cols: number, rows: number) =>
  ok(commands.ptyResize(agentId, cols, rows));

export const killAgent = (agentId: string) => ok(commands.killAgent(agentId));

/** Release Ultron containment for a Blocked agent. */
export const unblockAgent = (agentId: string) => commands.unblockAgent(agentId);

export const dispatchTask = (prompt: string, cols: number, rows: number) =>
  ok(commands.dispatchTask(prompt, cols, rows));

// ---- Chat (headless Claude Code) ----

export const chatSend = (agentId: string, text: string, dir?: string) =>
  ok(commands.chatSend(agentId, text, dir ?? null));

export const chatStop = (agentId: string) => commands.chatStop(agentId);

/** Load an agent's persisted transcript to rehydrate the chat on reopen. */
export const getChat = (agentId: string, limit?: number) =>
  commands.getChat(agentId, limit ?? null);

// ---- saved chats (conversations) ----

export const listConversations = () => commands.listConversations();

export const newChat = (agentId: string) => commands.newChat(agentId);

export const openConversation = (conversationId: number) =>
  commands.openConversation(conversationId);

export const onConversationsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("conversations://changed", () => cb());

/** List files and folders under a directory for the chat's @ file picker. */
export const listFiles = (dir: string, limit?: number) =>
  commands.listFiles(dir, limit ?? null);

export const onChatEvent = (cb: (e: ChatEvent) => void): Promise<UnlistenFn> =>
  listen<ChatEvent>("chat://event", (evt) => cb(evt.payload));

// ---- Human-in-the-loop review (the lavish alternative) ----

export const onReviewRequest = (
  cb: (r: ReviewRequest) => void,
): Promise<UnlistenFn> =>
  listen<ReviewRequest>("review://request", (evt) => cb(evt.payload));

export const reviewRespond = (id: string, decision: string) =>
  commands.reviewRespond(id, decision);

export const getProject = () => commands.getProject();

export const listProjects = () => commands.listProjects();

export const setProject = (path: string) => ok(commands.setProject(path));

export const addProject = (path: string) => ok(commands.addProject(path));

export const removeProject = (path: string) => commands.removeProject(path);

// ---- configuration (engines + roster) ----

export const getConfig = () => commands.getConfig();

export const updateAgent = (agent: Parameters<typeof commands.updateAgent>[0]) =>
  commands.updateAgent(agent);

export const removeAgent = (id: string) => commands.removeAgent(id);

export const updateEngine = (
  engine: Parameters<typeof commands.updateEngine>[0],
) => commands.updateEngine(engine);

export const removeEngine = (id: string) => commands.removeEngine(id);

export const setOnboarded = (value: boolean) => commands.setOnboarded(value);

/** Set the standup mission cadence in minutes (0 = off). */
export const setStandupMinutes = (minutes: number) =>
  commands.setStandupMinutes(minutes);

export const setLighting = (mode: string) => commands.setLighting(mode);

export const resetConfig = () => commands.resetConfig();

export const onConfigChanged = (
  cb: (c: Awaited<ReturnType<typeof commands.getConfig>>) => void,
): Promise<UnlistenFn> =>
  listen<Awaited<ReturnType<typeof commands.getConfig>>>(
    "config://changed",
    (evt) => cb(evt.payload),
  );

export const requestAssist = (
  from: string,
  to: string,
  note: string,
  cols: number,
  rows: number,
) => ok(commands.requestAssist(from, to, note, cols, rows));

// ---- Events (Rust -> UI) ----------------------------------------------------

export const onPtyData = (cb: (e: PtyData) => void): Promise<UnlistenFn> =>
  listen<PtyData>("pty://data", (evt) => cb(evt.payload));

export const onAgentStatus = (cb: (e: StatusEvent) => void): Promise<UnlistenFn> =>
  listen<StatusEvent>("agent://status", (evt) => cb(evt.payload));

export const onUsageUpdate = (cb: (u: UsageUpdate) => void): Promise<UnlistenFn> =>
  listen<UsageUpdate>("usage://update", (evt) => cb(evt.payload));

export const checkUpdate = () => commands.checkUpdate();

export const onUpdateStatus = (cb: (s: UpdateStatus) => void): Promise<UnlistenFn> =>
  listen<UpdateStatus>("update://status", (evt) => cb(evt.payload));

export const onLedgerEntry = (cb: (e: LedgerEntry) => void): Promise<UnlistenFn> =>
  listen<LedgerEntry>("ledger://entry", (evt) => cb(evt.payload));

export const onBreakerTrip = (cb: (agentId: string) => void): Promise<UnlistenFn> =>
  listen<string>("breaker://trip", (evt) => cb(evt.payload));

export const onAssistLink = (
  cb: (e: { from: string; to: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ from: string; to: string }>("assist://link", (evt) => cb(evt.payload));
