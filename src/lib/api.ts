import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { commands, type AutomationInput, type PowerState, type Result } from "./bindings";
import type { Attachment, ChatEvent, ChatSwitch, TaskEvent, LedgerEntry, PtyData, ReviewRequest, StatusEvent, UsageUpdate, UpdateStatus } from "./types";

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

/** Close a reviewed task: it leaves the Work board but stays in history. */
export const closeTask = (id: string) => commands.closeTask(id);
export const reviewTask = (id: string) => ok(commands.reviewTask(id));

export const onTasksChanged = (cb: () => void): Promise<UnlistenFn> => listen("tasks://changed", () => cb());

/** Pick an interrupted task back up where it left off. */
export const resumeTask = (id: string) => ok(commands.resumeTask(id));

/** Quit for real: every agent session stops. Closing the window doesn't. */
export const quitApp = () => commands.quitApp();

/** Quitting was asked for while agents work; the payload is how many. */
export const onQuitRequested = (cb: (busy: number) => void): Promise<UnlistenFn> => listen<number>("app://quit-requested", (evt) => cb(evt.payload));

export const loginItemEnabled = () => commands.loginItemEnabled();

/** Open Starkline at login, in the background (or stop doing so). */
export const setLoginItem = (enabled: boolean) => ok(commands.setLoginItem(enabled));

/** Hand work to an agent: it starts in its own conversation, or waits its turn. */
export const startTask = (agentId: string, prompt: string, dir?: string, attachments: Attachment[] = []) =>
  ok(commands.startTask(agentId, prompt, dir ?? null, attachments));

/** The task screen's data; null if the task no longer exists. */
export const getTaskDetail = (id: string) => commands.getTaskDetail(id);

/** The readable diff of one changed file in the task's folder. */
export const getTaskFileDiff = (id: string, path: string) => ok(commands.getTaskFileDiff(id, path));

// ---- Notification Centre and permission rules ----

export const listNotifications = (limit?: number) => commands.listNotifications(limit ?? null);

export const markNotificationsRead = (ids: number[]) => commands.markNotificationsRead(ids);

export const markAllNotificationsRead = () => commands.markAllNotificationsRead();

export const onNotificationsChanged = (cb: () => void): Promise<UnlistenFn> => listen("notifications://changed", () => cb());

/** Rules the developer granted; revoked ones too when asked. */
export const listPermissionRules = (includeRevoked = false) => commands.listPermissionRules(includeRevoked);

/** Take a rule back: what it covered needs approval again. */
export const revokePermissionRule = (id: number) => commands.revokePermissionRule(id);

export const onRulesChanged = (cb: () => void): Promise<UnlistenFn> => listen("rules://changed", () => cb());

/** Every rule of Starkline's permission policy and its tier. */
export const permissionPolicy = () => commands.permissionPolicy();

/** What Starkline can do with an agent on each kind of provider, as built. */
export const providerCapabilities = () => commands.providerCapabilities();

/** The models a provider offers, as its CLI lists them. */
export const providerModels = (engineId: string) => ok(commands.providerModels(engineId));

// ---- Automations ----

export const listAutomations = () => commands.listAutomations();

/** Create (no id) or change an automation; rejects with the reason it can't be saved. */
export const saveAutomation = (input: AutomationInput) => ok(commands.saveAutomation(input));

export const setAutomationEnabled = (id: number, enabled: boolean) => ok(commands.setAutomationEnabled(id, enabled));

export const deleteAutomation = (id: number) => ok(commands.deleteAutomation(id));

/** Run it now, outside its schedule. */
export const runAutomationNow = (id: number) => ok(commands.runAutomationNow(id));

/** Don't make up a missed run; wait for the next one. */
export const skipMissedRun = (id: number) => commands.skipMissedRun(id);

export const listAutomationRuns = (id: number) => commands.listAutomationRuns(id);

export const onAutomationsChanged = (cb: () => void): Promise<UnlistenFn> => listen("automations://changed", () => cb());

/** Something happened in a task (a file changed, a check passed). */
export const onTaskEvent = (cb: (e: TaskEvent) => void): Promise<UnlistenFn> => listen<TaskEvent>("tasks://event", (evt) => cb(evt.payload));

/** An agent moved to another conversation (new chat, reopened chat, a task started). */
export const onChatSwitched = (cb: (s: ChatSwitch) => void): Promise<UnlistenFn> => listen<ChatSwitch>("chat://switched", (evt) => cb(evt.payload));

/** An agent's durable memory markdown (what it curates across sessions). */
export const getMemory = (agentId: string) => commands.getMemory(agentId);

export const spawnAgent = (agentId: string, cols: number, rows: number) => ok(commands.spawnAgent(agentId, cols, rows));

export const ptyWrite = (agentId: string, data: string) => ok(commands.ptyWrite(agentId, data));

export const ptyResize = (agentId: string, cols: number, rows: number) => ok(commands.ptyResize(agentId, cols, rows));

export const killAgent = (agentId: string) => ok(commands.killAgent(agentId));

/** Release Ultron containment for a Blocked agent. */
export const unblockAgent = (agentId: string) => commands.unblockAgent(agentId);

export const dispatchTask = (prompt: string, cols: number, rows: number) => ok(commands.dispatchTask(prompt, cols, rows));

// ---- Chat (headless Claude Code) ----

export const chatSend = (agentId: string, text: string, dir?: string, attachments: Attachment[] = []) =>
  ok(commands.chatSend(agentId, text, dir ?? null, attachments));

// ---- attachments ----

/** Keep copies of files the developer picked or dropped, to send with a message. */
export const attachFiles = (paths: string[]) => ok(commands.attachFiles(paths));

/** Keep a pasted file (base64 contents). */
export const attachData = (name: string, data: string) => ok(commands.attachData(name, data));

/** Forget files attached to a message that was never sent. */
export const discardAttachments = (attachments: Attachment[]) => commands.discardAttachments(attachments);

/** The start of a chat's text or HTML file, for its preview. */
export const readAttachmentText = (path: string) => ok(commands.readAttachmentText(path));

export const chatStop = (agentId: string) => commands.chatStop(agentId);

/** Load an agent's persisted transcript to rehydrate the chat on reopen. */
export const getChat = (agentId: string, limit?: number) => commands.getChat(agentId, limit ?? null);

// ---- saved chats (conversations) ----

export const listConversations = () => commands.listConversations();

/** The agent's current saved chat (if any), including the folder it runs in. */
export const activeConversation = (agentId: string) => commands.activeConversation(agentId);

/** Delete a chat for good (its messages); tasks that ran in it stay in history. */
export const deleteConversation = (conversationId: number) => ok(commands.deleteConversation(conversationId));
/** A fresh chat with an agent, in a project folder or where the agent works now. */
export const newChat = (agentId: string, cwd?: string) => commands.newChat(agentId, cwd ?? null);

export const openConversation = (conversationId: number) => commands.openConversation(conversationId);

export const onConversationsChanged = (cb: () => void): Promise<UnlistenFn> => listen("conversations://changed", () => cb());

// ---- maintenance (bugs) ----

export const getBugs = () => commands.getBugs();

export const setBugStatus = (id: number, status: string) => commands.setBugStatus(id, status);

export const runMaintenance = () => ok(commands.runMaintenance());

export const onBugsChanged = (cb: () => void): Promise<UnlistenFn> => listen("bugs://changed", () => cb());

/** List files and folders under a directory for the chat's @ file picker. */
export const listFiles = (dir: string, limit?: number) => commands.listFiles(dir, limit ?? null);

export const onChatEvent = (cb: (e: ChatEvent) => void): Promise<UnlistenFn> => listen<ChatEvent>("chat://event", (evt) => cb(evt.payload));

// ---- Human-in-the-loop review (the lavish alternative) ----

export const onReviewRequest = (cb: (r: ReviewRequest) => void): Promise<UnlistenFn> => listen<ReviewRequest>("review://request", (evt) => cb(evt.payload));

export const reviewRespond = (id: string, decision: string) => commands.reviewRespond(id, decision);

/** Everything agents are blocked on right now, oldest first. */
export const pendingReviews = () => commands.pendingReviews();

/** A review was decided (or its agent went away). Payload: the review id. */
export const onReviewResolved = (cb: (id: string) => void): Promise<UnlistenFn> => listen<string>("review://resolved", (evt) => cb(evt.payload));

export const getProject = () => commands.getProject();

export const listProjects = () => commands.listProjects();

export const setProject = (path: string) => ok(commands.setProject(path));

export const addProject = (path: string) => ok(commands.addProject(path));

export const removeProject = (path: string) => commands.removeProject(path);

// ---- configuration (engines + roster) ----

export const getConfig = () => commands.getConfig();

export const updateAgent = (agent: Parameters<typeof commands.updateAgent>[0]) => commands.updateAgent(agent);
/** Where an agent's tone dials start (a built-in agent's character, else neutral). */
export const defaultTone = (agentId: string) => commands.defaultTone(agentId);

export const removeAgent = (id: string) => commands.removeAgent(id);

export const updateEngine = (engine: Parameters<typeof commands.updateEngine>[0]) => commands.updateEngine(engine);

export const removeEngine = (id: string) => commands.removeEngine(id);

export const setOnboarded = (value: boolean) => commands.setOnboarded(value);

/** Set the standup mission cadence in minutes (0 = off). */
export const setStandupMinutes = (minutes: number) => commands.setStandupMinutes(minutes);

export const setLighting = (mode: string) => commands.setLighting(mode);

/** Change how Starkline looks (rnd | office | mori). */
export const setTheme = (theme: string, outfits: string) => ok(commands.setTheme(theme, outfits));

export const resetConfig = () => commands.resetConfig();

export const onConfigChanged = (cb: (c: Awaited<ReturnType<typeof commands.getConfig>>) => void): Promise<UnlistenFn> =>
  listen<Awaited<ReturnType<typeof commands.getConfig>>>("config://changed", (evt) => cb(evt.payload));

export const requestAssist = (from: string, to: string, note: string, cols: number, rows: number) => ok(commands.requestAssist(from, to, note, cols, rows));

// ---- Events (Rust -> UI) ----------------------------------------------------

export const onPtyData = (cb: (e: PtyData) => void): Promise<UnlistenFn> => listen<PtyData>("pty://data", (evt) => cb(evt.payload));

export const onAgentStatus = (cb: (e: StatusEvent) => void): Promise<UnlistenFn> => listen<StatusEvent>("agent://status", (evt) => cb(evt.payload));

export const onUsageUpdate = (cb: (u: UsageUpdate) => void): Promise<UnlistenFn> => listen<UsageUpdate>("usage://update", (evt) => cb(evt.payload));

export const checkUpdate = () => commands.checkUpdate();

export const onUpdateStatus = (cb: (s: UpdateStatus) => void): Promise<UnlistenFn> => listen<UpdateStatus>("update://status", (evt) => cb(evt.payload));

export const onLedgerEntry = (cb: (e: LedgerEntry) => void): Promise<UnlistenFn> => listen<LedgerEntry>("ledger://entry", (evt) => cb(evt.payload));

export const onBreakerTrip = (cb: (agentId: string) => void): Promise<UnlistenFn> => listen<string>("breaker://trip", (evt) => cb(evt.payload));

export const onAssistLink = (cb: (e: { from: string; to: string }) => void): Promise<UnlistenFn> =>
  listen<{ from: string; to: string }>("assist://link", (evt) => cb(evt.payload));

// ---- Runtime health and power ----

/** Installed provider CLIs, data store and agent bridge, right now. */
export const runtimeHealth = () => commands.runtimeHealth();

/** A provider CLI answered a background check (its version, or whether it's signed in). */
export const onHealthChanged = (cb: () => void): Promise<UnlistenFn> => listen("health://changed", () => cb());

export const powerState = () => commands.powerState();

/** Allow (or stop allowing) Starkline to keep this Mac awake while agents work. */
export const setKeepAwake = (enabled: boolean) => commands.setKeepAwake(enabled);

export const onPowerState = (cb: (s: PowerState) => void): Promise<UnlistenFn> => listen<PowerState>("power://state", (evt) => cb(evt.payload));

// ---- Native dialogs ----

/** Ask for a folder with the macOS picker; null if the developer cancels. */
export async function pickFolder(title: string): Promise<string | null> {
  const chosen = await openDialog({ directory: true, multiple: false, title });
  return typeof chosen === "string" ? chosen : null;
}

/** Ask for files to attach with the macOS picker; none if the developer cancels. */
export async function pickFiles(title: string): Promise<string[]> {
  const chosen = await openDialog({ multiple: true, directory: false, title });
  if (Array.isArray(chosen)) return chosen;
  return typeof chosen === "string" ? [chosen] : [];
}
