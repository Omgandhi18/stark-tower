import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { commands, type AutomationInput, type Bounds, type BrowserPage, type Budget, type CodeReviews, type CommitInput, type ExtraArgs, type Output, type PowerState, type ReminderInput, type RequestInput, type Result, type Server, type WorktreeSetup } from "./bindings";
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

// ---- Project dev servers ----

export const devserverCandidates = (folder: string) => ok(commands.devserverCandidates(folder));
export const devserverSelect = (folder: string, selected: string, custom: string) => ok(commands.devserverSelect(folder, selected, custom));
export const devserverStart = (folder: string, option?: string, command?: string) => ok(commands.devserverStart(folder, option ?? null, command ?? null));
export const devserverStop = (folder: string) => ok(commands.devserverStop(folder));
export const devserverRestart = (folder: string) => ok(commands.devserverRestart(folder));
export const devserverList = () => commands.devserverList();
export const devserverLogs = (folder: string) => ok(commands.devserverLogs(folder));
export const onDevserverChanged = (cb: (server: Server) => void): Promise<UnlistenFn> => listen<Server>("devserver://changed", (e) => cb(e.payload));
export const onDevserverOutput = (cb: (output: Output) => void): Promise<UnlistenFn> => listen<Output>("devserver://output", (e) => cb(e.payload));

// ---- Built-in browser ----

export const browserShow = (bounds: Bounds, zoom = 1) => ok(commands.browserShow(bounds, zoom));
export const browserHide = () => commands.browserHide();
/** Open what was typed in the address bar. */
export const browserNavigate = (url: string) => ok(commands.browserNavigate(url));
export const browserGo = (action: "back" | "forward" | "reload" | "stop") => ok(commands.browserGo(action));
export const browserPage = () => commands.browserPage();
export const onBrowserChanged = (cb: (page: BrowserPage) => void): Promise<UnlistenFn> => listen<BrowserPage>("browser://changed", (e) => cb(e.payload));
/** An agent opened a page: the browser comes into view. */
export const onBrowserReveal = (cb: (agentId: string) => void): Promise<UnlistenFn> =>
  listen<{ agentId: string }>("browser://reveal", (e) => cb(e.payload.agentId));
/** Point at something on the page: start, then poll until a pick comes back or picking stops. */
export const browserPicker = (action: "start" | "poll" | "cancel") => ok(commands.browserPicker(action));

// ---- iOS Simulator ----

export const simulatorStatus = () => commands.simulatorStatus();
export const simulatorBoot = (udid: string) => ok(commands.simulatorBoot(udid));
export const simulatorShutdown = (udid: string) => ok(commands.simulatorShutdown(udid));
/** The device's screen now, as a base64 JPEG. */
export const simulatorFrame = (udid: string) => ok(commands.simulatorFrame(udid));
/** A tap where the screen was clicked, in the screenshot's pixels (`width` is the screenshot's). */
export const simulatorTap = (udid: string, name: string, x: number, y: number, width: number) => ok(commands.simulatorTap(udid, name, x, y, width));
/** A swipe where the screen was dragged across, in the screenshot's pixels. */
export const simulatorSwipe = (udid: string, name: string, from: [number, number], to: [number, number], width: number) =>
  ok(commands.simulatorSwipe(udid, name, from[0], from[1], to[0], to[1], width));
export const simulatorType = (udid: string, text: string) => ok(commands.simulatorType(udid, text));
export const simulatorHome = (udid: string) => ok(commands.simulatorHome(udid));
export const simulatorOpenApp = (udid: string) => ok(commands.simulatorOpenApp(udid));
/** An agent booted a simulator or launched its app: the simulator comes into view. */
export const onSimulatorReveal = (cb: (udid: string) => void): Promise<UnlistenFn> =>
  listen<{ udid: string }>("simulator://reveal", (e) => cb(e.payload.udid));
/** What's at a point clicked on the screen, in the screenshot's pixels. */
export const simulatorPoint = (udid: string, name: string, x: number, y: number, width: number) => ok(commands.simulatorPoint(udid, name, x, y, width));
/** Recording, logs, appearance, location, push and the status bar. */
export const simulatorExtra = (udid: string, action: string, args: ExtraArgs = {}) => ok(commands.simulatorExtra(udid, action, args));
/** A device's streamed logs so far (the last 20 KB), a few times a second while they're shown. */
export const onSimulatorLogs = (cb: (logs: { udid: string; text: string }) => void): Promise<UnlistenFn> =>
  listen<{ udid: string; text: string }>("simulator://logs", (e) => cb(e.payload));

// ---- Reminders ----

export const listReminders = () => commands.listReminders();

/** Set (no id) or change a reminder; rejects with the reason it can't be saved. */
export const saveReminder = (input: ReminderInput) => ok(commands.saveReminder(input));

/** Done: a one-off is finished, a repeating one waits for its next time. */
export const completeReminder = (id: number) => ok(commands.completeReminder(id));

/** Remind me again at `until`. */
export const snoozeReminder = (id: number, until: number) => ok(commands.snoozeReminder(id, until));

export const deleteReminder = (id: number) => ok(commands.deleteReminder(id));

export const onRemindersChanged = (cb: () => void): Promise<UnlistenFn> => listen("reminders://changed", () => cb());

/** A reminder went off; its agent is reminding the developer. */
export const onReminderDue = (cb: (due: { id: number; agentId: string }) => void): Promise<UnlistenFn> =>
  listen<{ id: number; agentId: string }>("reminders://due", (e) => cb(e.payload));

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

// ---- Developer terminals ----
export const terminalOpen = (folder: string, cols: number, rows: number) => ok(commands.terminalOpen(folder, cols, rows));
export const terminalWrite = (id: string, data: string) => ok(commands.terminalWrite(id, data));
export const terminalResize = (id: string, cols: number, rows: number) => ok(commands.terminalResize(id, cols, rows));
export const terminalClose = (id: string) => ok(commands.terminalClose(id));
export const terminalList = () => commands.terminalList();
export const terminalAttach = (id: string, channel: Parameters<typeof commands.terminalAttach>[1]) => ok(commands.terminalAttach(id, channel));

export const terminalTitle = (id: string, title: string) => ok(commands.terminalTitle(id, title));

// ---- Active context ----
/** Current prompt pieces and the provider's local instruction sources. */
export const activeContext = (agentId: string, folder: string, taskId?: string) => ok(commands.activeContext(agentId, folder, taskId ?? null));
export const openContextFile = (agentId: string, folder: string, path: string, reveal: boolean, taskId?: string) => ok(commands.openContextFile(agentId, folder, path, reveal, taskId ?? null));

// ---- Spend ----
export const spendSummary = () => ok(commands.spendSummary());
export const setBudget = (budget: Budget) => ok(commands.setBudget(budget));
export const conversationSpend = (id: number) => ok(commands.conversationSpend(id));
export const onSpendChanged = (cb: () => void): Promise<UnlistenFn> => listen("spend://changed", cb);
export const listWorktrees = () => commands.listWorktrees();
export const setWorktreesEnabled = (enabled: boolean) => commands.setWorktreesEnabled(enabled);
export const saveWorktreeSetup = (project: string, setup: WorktreeSetup) => ok(commands.saveWorktreeSetup(project, setup));
export const removeWorktree = (id: string, force: boolean) => ok(commands.removeWorktree(id, force));
export const onWorkspacesChanged = (cb: () => void): Promise<UnlistenFn> => listen("workspaces://changed", () => cb());

export const deliveryInfo = (id: string) => ok(commands.deliveryInfo(id));
export const discardTaskFile = (id: string, path: string) => ok(commands.discardTaskFile(id, path));
export const commitTask = (id: string, input: CommitInput) => ok(commands.commitTask(id, input));
export const pushTask = (id: string) => ok(commands.pushTask(id));
export const draftDelivery = (id: string, paths: string[], request: boolean, token: string) => ok(commands.draftDelivery(id, paths, request, token));
export const cancelDeliveryDraft = (token: string) => commands.cancelDeliveryDraft(token);
export const createTaskRequest = (id: string, input: RequestInput) => ok(commands.createTaskRequest(id, input));
export const codeReviews = () => commands.codeReviews();
export const refreshCodeReviews = () => commands.refreshCodeReviews();
export const seeCodeReview = (id: string) => ok(commands.seeCodeReview(id));
export const askCodeReview = (id: string, agentId: string) => ok(commands.askCodeReview(id, agentId));
export const onCodeReviewsChanged = (cb: (value: CodeReviews) => void): Promise<UnlistenFn> => listen<CodeReviews>("hosting://changed", (event) => cb(event.payload));

// Quick capture stays independent of the main window.
export const setCaptureShortcut = (enabled: boolean, shortcut: string) => ok(commands.setCaptureShortcut(enabled, shortcut));
export const captureError = () => commands.captureError();
export const hideCapture = () => ok(commands.hideCapture());
export const resizeCapture = (height: number) => ok(commands.resizeCapture(height));
export const rememberCapture = (agentId: string, project: string | null, reminder: boolean) => commands.rememberCapture(agentId, project, reminder);
export const openCaptureTask = (id: string) => ok(commands.openCaptureTask(id));
export const onCaptureShown = (cb: () => void): Promise<UnlistenFn> => listen("capture://shown", () => cb());
export const onCaptureError = (cb: (error: string) => void): Promise<UnlistenFn> => listen<string>("capture://error", (event) => cb(event.payload));
export const onCaptureOpenTask = (cb: (id: string) => void): Promise<UnlistenFn> => listen<string>("capture://open-task", (event) => cb(event.payload));

// Character Studio uses the developer's Codex sign-in; portraits stay local.
export const studioAvailable = () => ok(commands.studioAvailable());
export const studioJob = (id: string) => ok(commands.studioJob(id));
export const studioLooks = () => commands.studioLooks();
export const studioDraw = (choices: import("./bindings").Choices, id: string | null, theme: string | null) => ok(commands.studioDraw(choices, id, theme));
export const studioCancel = (id: string) => ok(commands.studioCancel(id));
export const studioApply = (agentId: string, id: string | null) => ok(commands.studioApply(agentId, id));
export const onStudioProgress = (cb: (look: import("./bindings").Look) => void) => listen<import("./bindings").Look>("studio://progress", (e) => cb(e.payload));
export const onStudioChanged = (cb: () => void) => listen("studio://changed", cb);

// ---- Offline voices ----
export const voiceStatus = () => commands.voiceStatus();
export const downloadVoices = () => ok(commands.downloadVoices());
export const cancelVoiceDownload = () => commands.cancelVoiceDownload();
export const removeVoices = () => ok(commands.removeVoices());
export const setVoiceSettings = (settings: import("./types").VoiceSettings) => ok(commands.setVoiceSettings(settings));
export const speakVoice = (agentId: string, text: string, token: string, voice: import("./types").Voice | null = null) => ok(commands.speakVoice(agentId, text, token, voice));
export const stopSpeaking = () => commands.stopSpeaking();
export const voiceChatVisibility = (agentId: string | null) => commands.voiceChatVisibility(agentId);
export const onVoiceStatus = (cb: (status: import("./types").VoiceStatus) => void): Promise<UnlistenFn> => listen<import("./types").VoiceStatus>("voices://status", (e) => cb(e.payload));
