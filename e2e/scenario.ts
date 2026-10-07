// What the fake backend starts with in end-to-end tests: the default roster,
// two projects, work in every state, and one of each kind of request.
// Test fixture only; the app itself never shows this data.
import type { ConversationSpend, SpendSummary, SpendTotal, TerminalInfo } from "../src/lib/bindings";
import { DEFAULT_VOICE_SETTINGS, defaultVoice } from "../src/features/voices/voiceModel";
import type {
  AgentConfig,
  AgentStatus,
  AppConfig,
  Automation,
  AutomationRun,
  BrowserPage,
  Candidates,
  Server,
  Output,
  Bug,
  CheckRun,
  Conversation,
  FileChange,
  Notification,
  PathEntry,
  ModelChoice,
  PermissionRule,
  PlanItem,
  PolicyRule,
  ProviderCapabilities,
  PowerState,
  ProjectsState,
  Reminder,
  ReviewRequest,
  RuntimeHealth,
  SimulatorStatus,
  BrowserPick,
  ExtraState,
  StoredMessage,
  DeliveryInfo,
  CodeReviews,
  Task,
  TaskEvent,
  Worktree,
  FileClaim,
} from "../src/lib/types";

/** A phone's home screen (a small JPEG), standing in for the simulator's screen. */
const PHONE_SCREEN = "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KMUtFACYopaKAFopaKBCUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFACUUtFAC0UtFMBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBKKWigBaKWigQlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQAlFLRQA6ilooEJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAJRS0UAFFLRTASilooASilooASilooASilooASilooASilooASilooASilooASilooASilooASilooASilooAdijFLRQITFGKWigBMUYpaKAExRilooATFGKWigBMUYpaKAExRilooATFGKWigBMUYpaKAExRilooATFGKWigBMUYpaKAExRS0UALRS0UCEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAEopaKAFxRilxRimAmKMUuKMUAJijFLijFACYoxS4oxQAmKMUuKMUAJijFLijFACYoxS4oxQAmKMUuKMUAJijFLijFACYoxS4oxQAmKMUuKMUAJijFLijFACYopcUUALijFLRQITFGKWigBMUYpaKAExRilooATFGKWigBMUYpaKAExRilooATFGKWigBMUYpaKAExRilooATFGKWigBMUYpaKAExRS0UALijFLijFACYoxS4oxQAmKMUuKMUAJijFLijFACYoxS4oxQAmKMUuKMUAJijFLijFACYoxS4oxQAmKMUuKMUAJijFLijFACYoxS4oxQAmKMUuKMUAJiilxRQAtFFFAgooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD//2Q==";

/** Every test runs at this moment, so relative times and screenshots are stable. */
export const NOW = Date.parse("2026-10-05T10:30:00+05:30");
const MINUTE = 60_000;
const ago = (minutes: number) => NOW - minutes * MINUTE;

export interface Scenario {
  macNotificationPermission?: "allowed" | "denied" | "not_asked" | "provisional" | "system";
  macNotificationTestError?: string;
  spend: SpendSummary;
  conversationSpend: Record<number, ConversationSpend>;
  studio?: { available: boolean; looks: Record<string, import("../src/lib/bindings").Look>; failTheme?: string };
  /** How long after the page loads the backend starts answering (the launch race); by default at once. */
  backendReadyAfterMs?: number;
  captureVisible?: boolean;
  captureHeight?: number;
  captureError?: string;
  takenShortcuts?: string[];
  commandErrors?: Record<string, string>;
  openedCaptureTask?: string;
  config: AppConfig;
  worktrees: Worktree[];
  claims: FileClaim[];
  voices: import("../src/lib/types").VoiceStatus;
  voiceChat?: string | null;
  statuses: Record<string, AgentStatus>;
  projects: ProjectsState;
  tasks: Task[];
  delivery: Record<string, DeliveryInfo>;
  codeReviews: CodeReviews;
  draftMessage: string;
  deliveryError?: string;
  pushError?: string;
  draftDelayMs?: number;
  conversations: Conversation[];
  /** Saved transcript per conversation id. */
  transcripts: Record<number, StoredMessage[]>;
  /** The open conversation per agent. */
  current: Record<string, number>;
  reviews: ReviewRequest[];
  /** Conversations in auto mode. */
  autoMode?: number[];
  bugs: Bug[];
  health: RuntimeHealth;
  power: PowerState;
  files: Record<string, PathEntry[]>;
  memory: Record<string, string>;
  /** Local instruction files the context inspector discovers, keyed by path. */
  contextFiles: Record<string, string>;
  taskEvents: Record<string, TaskEvent[]>;
  plans: Record<string, PlanItem[]>;
  checks: Record<string, CheckRun[]>;
  /** Uncommitted changes per folder, and each file's diff. */
  changes: Record<string, FileChange[]>;
  diffs: Record<string, string>;
  branches: Record<string, string>;
  notifications: Notification[];
  rules: PermissionRule[];
  automations: Automation[];
  /** Every automation's runs, newest first. */
  automationRuns: AutomationRun[];
  policy: PolicyRule[];
  capabilities: ProviderCapabilities[];
  /** The models each provider lists, by engine id. */
  models: Record<string, ModelChoice[]>;
  /** Reminders the developer set, soonest first. */
  reminders: Reminder[];
  /** The built-in browser's page. */
  browser: BrowserPage;
  terminals: Array<TerminalInfo & { output: number[]; offset: number; input: string }>;
  browserPick: BrowserPick | null;
  picking: boolean;
  simulatorExtras: Record<string, ExtraState>;
  devservers: { candidates: Record<string, Candidates>; servers: Record<string, Server>; output: Record<string, Output>; readyAddress: string | null };
  /** Xcode's simulators, and a screenshot standing in for every frame. */
  simulator: SimulatorStatus & { frame: string };
}

const POLICY: PolicyRule[] = [
  { label: "Work inside the project", tier: "automatic" },
  { label: "Install or update dependencies", tier: "approval" },
  { label: "Create or switch branches", tier: "approval" },
  { label: "Access files outside the project", tier: "approval" },
  { label: "Reach the network", tier: "approval" },
  { label: "Commit, push, deploy or publish", tier: "never" },
  { label: "Discard, reset, clean or stash changes", tier: "never" },
];

const yes = (note: string) => ({ support: "yes" as const, note });
const no = (note: string) => ({ support: "no" as const, note });

const CAPABILITIES: ProviderCapabilities[] = [
  {
    kind: "claude-code",
    label: "Claude Code",
    resume: yes("Chats resume from Claude Code's saved session."),
    events: yes("Streams messages, tool calls and results."),
    approvals: yes("A pre-tool hook sends every call through the gate first."),
    sandbox: no("Starkline doesn't turn on Claude Code's sandbox; the gate is the safeguard."),
    helpers: yes("Claude Code subagents, on a model you can choose."),
    team_tools: yes("Through Starkline's MCP bridge."),
  },
  {
    kind: "codex",
    label: "Codex",
    resume: yes("Chats resume from the Codex thread."),
    events: yes("Streams messages, commands, file changes and plans."),
    approvals: yes("Codex asks before commands and edits; the gate answers, or asks you."),
    sandbox: yes("Commands run in Codex's workspace sandbox: writes stay in the project, with no network unless approved."),
    helpers: no("Codex doesn't start helpers in this setup."),
    team_tools: yes("Through Starkline's MCP bridge."),
  },
  {
    kind: "opencode",
    label: "OpenCode",
    resume: yes("Chats resume from the saved OpenCode session."),
    events: yes("Streams messages, tool calls and to-do lists over ACP."),
    approvals: yes("OpenCode asks before commands, edits and fetches; the gate answers, or asks you."),
    sandbox: no("OpenCode runs commands without a sandbox; the gate is the safeguard."),
    helpers: no("Starkline keeps OpenCode's subagents off: their actions can't be seen or approved from here."),
    team_tools: yes("Through Starkline's MCP bridge."),
  },
];

const EVERY_EFFORT = ["low", "medium", "high", "xhigh", "max"];

/** A Claude model as the backend lists it. */
const claudeModel = (id: string, name: string, description: string, efforts: string[], defaultEffort: string | null, older = false): ModelChoice => ({
  id,
  name,
  default: false,
  description,
  efforts,
  default_effort: defaultEffort,
  older,
});

const APP = "/Users/dev/code/checkout-web";
const API = "/Users/dev/code/payments-api";

const agent = (a: Omit<AgentConfig, "engine" | "model" | "enabled">): AgentConfig => ({
  engine: "claude-code",
  model: "",
  enabled: true,
  voice: defaultVoice(a.id),
  ...a,
});

const config: AppConfig = {
  quick_capture: { enabled: true, shortcut: "Super+Shift+Space", last_agent: null, last_project: null, last_reminder_agent: null },
  voices: { ...DEFAULT_VOICE_SETTINGS },
  version: 4,
  onboarded: true,
  standup_minutes: 0,
  keep_awake: true,
  mac_notifications: { enabled: true, in_front: true, reminders: true, requests: true, work: true, code_review: true, automations: true, budget: true, checks: false, claims: false },
  theme: "rnd",
  engines: [
    {
      id: "claude-code",
      label: "Claude Code",
      kind: "claude-code",
      command: "claude",
      supports_mcp: true,
      enabled: true,
      auth: { method: "cli-login", env: {} },
    },
    { id: "codex", label: "Codex", kind: "codex", command: "codex", supports_mcp: false, enabled: true, auth: { method: "cli-login", env: {} } },
    { id: "opencode", label: "OpenCode", kind: "opencode", command: "opencode", supports_mcp: false, enabled: false, auth: { method: "cli-login", env: {} } },
  ],
  agents: [
    agent({
      id: "jarvis",
      name: "JARVIS",
      role: "Orchestrator",
      kind: "orchestrator",
      accent: "#4fd0ff",
      figure: "commander",
      personality: "Plan the work, delegate it and report back clearly.",
      home_x: 4,
      home_y: 5,
    }),
    agent({
      id: "vision",
      name: "VISION",
      role: "Architecture & Strategy",
      kind: "worker",
      accent: "#e86b9a",
      figure: "architect",
      personality: "",
      home_x: 5,
      home_y: 10,
    }),
    agent({ id: "friday", name: "FRIDAY", role: "Full-stack", kind: "worker", accent: "#ffd166", figure: "engineer", personality: "", home_x: 8, home_y: 10 }),
    agent({
      id: "edith",
      name: "EDITH",
      role: "Recon & Research",
      kind: "worker",
      accent: "#7cf5c4",
      figure: "recon",
      personality: "",
      home_x: 11,
      home_y: 10,
    }),
    agent({
      id: "karen",
      name: "KAREN",
      role: "Frontend & UI",
      kind: "worker",
      accent: "#c08cff",
      figure: "specialist",
      personality: "",
      home_x: 14,
      home_y: 10,
    }),
    agent({
      id: "veronica",
      name: "VERONICA",
      role: "Ops & Infra",
      kind: "worker",
      accent: "#ff9e64",
      figure: "operative",
      personality: "",
      home_x: 8,
      home_y: 13,
    }),
    agent({
      id: "dum-e",
      name: "DUM-E",
      role: "Maintenance",
      kind: "maintenance",
      accent: "#9aa7b2",
      figure: "helperbot",
      personality: "",
      home_x: 1,
      home_y: 13,
    }),
  ],
};

export const task = (
  over: Partial<Task> & Pick<Task, "id" | "title" | "assignee" | "status" | "cwd">,
  startedMinutesAgo: number,
  updatedMinutesAgo: number,
): Task => ({
  ts: ago(startedMinutesAgo + 1),
  updated: ago(updatedMinutesAgo),
  detail: null,
  conversation_id: null,
  parent_id: null,
  requested_by: "you",
  prompt: over.title,
  branch: "main",
  started: ago(startedMinutesAgo),
  finished: over.status === "done" || over.status === "blocked" ? ago(updatedMinutesAgo) : null,
  plan_done: null,
  plan_total: null,
  workspace_kind: "checkout",
  project_folder: over.cwd,
  request_url: null, request_host: null, request_number: null,
  ...over,
});

let eventSeq = 0;
export const taskEvent = (taskId: string, agentId: string, kind: string, summary: string, minutesAgo: number, data: unknown = ""): TaskEvent => ({
  id: ++eventSeq,
  task_id: taskId,
  ts: ago(minutesAgo),
  agent_id: agentId,
  kind,
  summary,
  data: typeof data === "string" ? data : JSON.stringify(data),
});

const conversation = (id: number, agentId: string, title: string, cwd: string, updatedMinutesAgo: number): Conversation => ({
  id,
  agent_id: agentId,
  title,
  cwd,
  created: ago(updatedMinutesAgo + 30),
  updated: ago(updatedMinutesAgo),
  delegated: false,
  project_folder: cwd,
  branch: "",
});

const message = (id: number, role: string, fields: Partial<StoredMessage>): StoredMessage => ({
  id,
  ts: ago(20 - id),
  role,
  text: null,
  tool: null,
  detail: null,
  ...fields,
});

export function defaultScenario(): Scenario {
  return {
    spend: emptySpend(),
    conversationSpend: {},
    config,
    worktrees: [],
    claims: [],
    statuses: { jarvis: "idle", vision: "thinking", friday: "working", edith: "idle", karen: "working", veronica: "blocked", "dum-e": "offline" },
    projects: {
      active: APP,
      projects: [
        { path: APP, name: "checkout-web" },
        { path: API, name: "payments-api" },
      ],
    },
    delivery: {},
    codeReviews: { items: [], connections: [], has_host: false },
    draftMessage: "feat: redesign settings\n\nAdd search and grouped settings.",
    tasks: [
      task(
        { id: "t-refunds", title: "Ship the refunds feature", assignee: "jarvis", status: "doing", cwd: API, conversation_id: 20, plan_done: 1, plan_total: 4 },
        95,
        6,
      ),
      task(
        {
          id: "t-arch",
          title: "Refunds service architecture",
          assignee: "vision",
          status: "doing",
          cwd: API,
          parent_id: "t-refunds",
          requested_by: "jarvis",
          conversation_id: 40,
        },
        30,
        6,
      ),
      task(
        {
          id: "t-idem",
          title: "Compare idempotency strategies for refunds",
          assignee: "edith",
          status: "done",
          cwd: API,
          parent_id: "t-refunds",
          requested_by: "jarvis",
          detail: "Recommended request keys stored for 24 hours, with a unique index on (merchant, key).",
        },
        90,
        25,
      ),
      task(
        {
          id: "t-ci",
          title: "Upgrade the CI runners to Node 22",
          assignee: "veronica",
          status: "doing",
          cwd: API,
          parent_id: "t-refunds",
          requested_by: "jarvis",
        },
        70,
        14,
      ),
      task(
        {
          id: "t-settings",
          title: "Redesign the settings page",
          assignee: "friday",
          status: "doing",
          cwd: APP,
          conversation_id: 11,
          branch: "feature/settings",
          plan_done: 2,
          plan_total: 5,
        },
        48,
        3,
      ),
      task(
        { id: "t-tokens", title: "Accessible colour tokens for the checkout form", assignee: "karen", status: "doing", cwd: APP, conversation_id: 30 },
        35,
        9,
      ),
      task(
        {
          id: "t-notes",
          title: "Write the release notes for 2.4",
          assignee: "edith",
          status: "done",
          cwd: APP,
          detail: "Draft is in docs/releases/2.4.md, grouped by area with upgrade notes.",
        },
        60,
        22,
      ),
      task(
        {
          id: "t-load",
          title: "Load-test the refunds endpoint",
          assignee: "edith",
          status: "blocked",
          cwd: API,
          requested_by: "jarvis",
          detail: "Stopped: the staging database URL isn't set, so the load test can't run.",
        },
        130,
        41,
      ),
      task({ id: "t-dark", title: "Add a dark mode toggle", assignee: "friday", status: "todo", cwd: APP, started: null }, 0, 2),
      // Last night's scheduled review, already looked at and closed.
      task({ id: "t-review", title: "Nightly code review", assignee: "jarvis", status: "closed", cwd: APP, requested_by: "automation:1" }, 510, 468),
    ],
    conversations: [
      conversation(11, "friday", "Redesign the settings page", APP, 3),
      conversation(10, "friday", "Fix flaky checkout test", APP, 60 * 26),
      conversation(20, "jarvis", "Plan the refunds launch", API, 40),
      conversation(30, "karen", "Accessible colour tokens", APP, 9),
      conversation(40, "vision", "Review the refunds architecture", API, 6),
    ],
    transcripts: {
      11: [
        message(1, "user", { text: "Can you redesign the settings page? Group the options and add a search box." }),
        message(2, "tool", { tool: "Read", detail: "src/pages/Settings.tsx" }),
        message(3, "tool", { tool: "Grep", detail: "SettingsSection" }),
        message(4, "agent", {
          text: "I grouped the options into **Account**, **Payments** and **Notifications**, and added a search box that filters them as you type.\n\n```tsx\nconst visible = sections.filter((s) => s.title.toLowerCase().includes(query));\n```\n\nNext I'll update the tests.",
        }),
        message(5, "tool", { tool: "Edit", detail: "src/pages/Settings.tsx" }),
        message(6, "tool", { tool: "Bash", detail: "npm test -- settings" }),
        message(7, "artifact", {
          detail: "made",
          attachments: [
            { path: "/src/assets/portraits/engineer.png", name: "settings-search.png", mime: "image/png", kind: "image", size: 182_431 },
            { path: "/attachments/a1/pricing.html", name: "pricing.html", mime: "text/html", kind: "html", size: 2_210 },
            { path: "/attachments/a2/RELEASE.md", name: "RELEASE.md", mime: "text/markdown", kind: "markdown", size: 1_024 },
            {
              path: "/attachments/a3/Roadmap.docx",
              name: "Roadmap.docx",
              mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              kind: "document",
              size: 48_120,
            },
          ],
        }),
      ],
      10: [
        message(1, "user", { text: "The checkout test fails about one run in five." }),
        message(2, "agent", { text: "It was a race with the price fetch. Fixed by awaiting the quote." }),
      ],
      20: [message(1, "user", { text: "Plan the refunds launch." }), message(2, "agent", { text: "Here's the plan: research, API, UI, rollout." })],
      30: [message(1, "user", { text: "Make the colour tokens pass contrast checks." })],
      40: [message(1, "user", { text: "Review the refunds architecture before we build it." })],
    },
    current: { friday: 11, jarvis: 20, karen: 30, vision: 40 },
    reviews: [
      {
        id: "r-command",
        agentId: "veronica",
        title: "Run the database migration on staging",
        body: "The `migrate` script looks like it changes a database.",
        kind: "command",
        choices: ["Allow", "Deny"],
        command: "npm run migrate -- --env staging",
        cwd: API,
        rule: "Run database migrations",
        tier: "approval",
        taskId: "t-ci",
        conversationId: null,
        grant: "`npm run` commands",
        project: API,
        created: ago(14),
      },
      {
        id: "r-plan",
        agentId: "vision",
        title: "Refunds service architecture",
        body: "## Proposal\n\nSplit refunds into a **request** step and a **settle** step.\n\n1. Store an idempotency key per merchant.\n2. Settle asynchronously through the existing queue.\n3. Report failures to the merchant dashboard.\n\n| Option | Latency | Risk |\n| --- | --- | --- |\n| Synchronous | Low | High |\n| Queued | Medium | Low |",
        kind: "plan",
        choices: ["Approve", "Request changes"],
        command: null,
        cwd: API,
        rule: null,
        tier: null,
        taskId: null,
        conversationId: 40,
        grant: null,
        project: null,
        created: ago(6),
      },
      {
        id: "r-question",
        agentId: "friday",
        title: "Which settings should be searchable?",
        body: "Should the search box include **admin-only** settings, or only what every user can see?",
        kind: "questions",
        choices: ["Everything", "Only what the user can see"],
        command: null,
        cwd: APP,
        rule: null,
        tier: null,
        taskId: null,
        conversationId: 11,
        grant: null,
        project: null,
        created: ago(2),
      },
    ],
    bugs: [
      {
        id: 1,
        reporter: "friday",
        title: "File picker misses dotfiles in nested folders",
        detail: "Typing @.env in a subfolder shows nothing.",
        status: "open",
        created: ago(240),
        updated: ago(240),
      },
      { id: 2, reporter: "karen", title: "Saved chat titles cut off emoji", detail: "", status: "fixed", created: ago(60 * 30), updated: ago(60 * 20) },
    ],
    health: {
      host: "app",
      dataStore: true,
      bridge: true,
      bridgeError: null,
      liveSessions: 4,
      node: "v22.11.0",
      nodePath: "/opt/homebrew/bin/node",
      background: true,
      engines: [
        {
          id: "claude-code",
          label: "Claude Code",
          kind: "claude-code",
          enabled: true,
          installed: true,
          path: "/opt/homebrew/bin/claude",
          version: "2.1.3",
          signIn: { signedIn: true, detail: "Claude account" },
        },
        { id: "codex", label: "Codex", kind: "codex", enabled: true, installed: false, path: null, version: null, signIn: null },
        { id: "opencode", label: "OpenCode", kind: "opencode", enabled: false, installed: false, path: null, version: null, signIn: null },
      ],
    },
    power: { enabled: true, holding: true, reason: "Awake while 3 agents are working.", supported: true },
    files: {
      [APP]: [
        { path: "src", dir: true },
        { path: "src/pages", dir: true },
        { path: "src/pages/Settings.tsx", dir: false },
        { path: "src/pages/Checkout.tsx", dir: false },
        { path: "src/components/SearchBox.tsx", dir: false },
        { path: "package.json", dir: false },
      ],
    },
    contextFiles: {
      [`${APP}/CLAUDE.md`]: "# Project instructions\n\nUse the existing SearchBox component and run npm test.",
    },
    memory: {
      friday: "## checkout-web\n\n- Tests run with `npm test`; the settings suite is slow.\n- Prefer the existing `SearchBox` component.",
    },
    taskEvents: {
      "t-settings": [
        taskEvent("t-settings", "friday", "created", "You asked for this", 48),
        taskEvent("t-settings", "friday", "started", "Started", 48),
        taskEvent("t-settings", "friday", "plan", "Plan: 0 of 5 steps done", 46),
        taskEvent("t-settings", "friday", "file", "Edited src/pages/Settings.tsx", 30, { path: "src/pages/Settings.tsx", action: "edited" }),
        taskEvent("t-settings", "friday", "file", "Wrote src/components/SettingsSearch.tsx", 28, {
          path: "src/components/SettingsSearch.tsx",
          action: "wrote",
        }),
        taskEvent("t-settings", "friday", "command", "Ran npx tsc --noEmit", 20, { command: "npx tsc --noEmit" }),
        taskEvent("t-settings", "friday", "verification", "Type check passed", 20, {
          kind: "Type check",
          command: "npx tsc --noEmit",
          passed: true,
          durationMs: 8200,
        }),
        taskEvent("t-settings", "friday", "helper", "Started a helper: Find every settings option", 18, {
          description: "Find every settings option",
          type: "Explore",
        }),
        taskEvent("t-settings", "friday", "command", "Ran npm test -- settings", 6, { command: "npm test -- settings" }),
        taskEvent("t-settings", "friday", "verification", "Tests failed", 5, {
          kind: "Tests",
          command: "npm test -- settings",
          passed: false,
          durationMs: 41000,
        }),
      ],
      "t-refunds": [
        taskEvent("t-refunds", "jarvis", "created", "You asked for this", 95),
        taskEvent("t-refunds", "jarvis", "delegated", 'Delegated "Compare idempotency strategies for refunds" to EDITH', 90, { taskId: "t-idem" }),
        taskEvent("t-refunds", "jarvis", "delegated", 'Delegated "Upgrade the CI runners to Node 22" to VERONICA', 70, { taskId: "t-ci" }),
        taskEvent("t-refunds", "jarvis", "delegated", 'Delegated "Refunds service architecture" to VISION', 30, { taskId: "t-arch" }),
      ],
    },
    plans: {
      "t-settings": [
        { content: "Read the current settings page", status: "completed", active: "Reading the current settings page" },
        { content: "Group the options into sections", status: "completed", active: "Grouping the options" },
        { content: "Add a search box that filters options", status: "in_progress", active: "Adding the search box" },
        { content: "Update the settings tests", status: "pending", active: "Updating the tests" },
        { content: "Run the checks", status: "pending", active: "Running the checks" },
      ],
    },
    checks: {
      "t-settings": [
        { kind: "Type check", command: "npx tsc --noEmit", passed: true, at: ago(20), duration_ms: 8200, agent_id: "friday" },
        { kind: "Tests", command: "npm test -- settings", passed: false, at: ago(5), duration_ms: 41000, agent_id: "friday" },
      ],
    },
    changes: {
      [APP]: [
        { path: "src/pages/Settings.tsx", status: "modified", added: 84, removed: 31 },
        { path: "src/components/SettingsSearch.tsx", status: "untracked", added: null, removed: null },
        { path: "src/styles/settings.css", status: "modified", added: 22, removed: 4 },
      ],
    },
    diffs: {
      "src/pages/Settings.tsx":
        'diff --git a/src/pages/Settings.tsx b/src/pages/Settings.tsx\nindex 1a2b3c4..5d6e7f8 100644\n--- a/src/pages/Settings.tsx\n+++ b/src/pages/Settings.tsx\n@@ -12,7 +12,12 @@ export function Settings() {\n-  return <OptionList options={options} />;\n+  const [query, setQuery] = useState("");\n+  const visible = sections.filter((s) => s.title.toLowerCase().includes(query));\n+  return (\n+    <SettingsSearch value={query} onChange={setQuery} />\n+  );\n }',
    },
    branches: { [APP]: "feature/settings", [API]: "main" },
    notifications: [
      notification(1, "approval", "needs_you", "veronica", "Run database migrations", "The `migrate` script looks like it changes a database.", 14, {
        review_id: "r-command",
        task_id: "t-ci",
        cwd: API,
      }),
      notification(2, "review", "needs_you", "vision", "Refunds service architecture", "Proposal: split refunds into a request step and a settle step.", 6, {
        review_id: "r-plan",
        task_id: "t-arch",
        cwd: API,
      }),
      notification(3, "question", "needs_you", "friday", "Which settings should be searchable?", "Should the search box include admin-only settings?", 2, {
        review_id: "r-question",
        task_id: "t-settings",
        cwd: APP,
      }),
      notification(4, "task_ready", "needs_you", "edith", "Write the release notes for 2.4", "EDITH finished and it's ready for your review.", 22, {
        task_id: "t-notes",
        cwd: APP,
      }),
      notification(5, "check_failed", "update", "friday", "Tests failed", 'npm test -- settings in "Redesign the settings page"', 5, {
        task_id: "t-settings",
        cwd: APP,
      }),
      notification(6, "rule_used", "update", "karen", "Allowed by your rule: `npm install` commands", "npm install @radix-ui/colors", 40, {
        read: true,
        cwd: APP,
      }),
      notification(7, "approval", "needs_you", "friday", "Install or update packages", "`npm install` downloads or changes packages.", 60 * 26, {
        handled: ago(60 * 25),
        outcome: "Allowed once",
        read: true,
        cwd: APP,
      }),
    ],
    rules: [
      {
        id: 1,
        created: ago(60 * 3),
        scope: "project",
        task_id: null,
        project: APP,
        tool: "Bash",
        pattern: "npm install",
        display: "`npm install` commands",
        rule: "Install or update dependencies",
        tier: "approval",
        uses: 3,
        last_used: ago(40),
        revoked: null,
      },
    ],
    ...automations(),
    reminders: reminders(),
    terminals: [],
    browser: { url: "", title: "", loading: false },
    browserPick: null,
    picking: false,
    simulatorExtras: {},
    devservers: { candidates: {}, servers: {}, output: {}, readyAddress: null },
    voices: { model: "missing", downloaded: 0, total: 349906910, agent_id: null, token: null, error: null },
    simulator: {
      available: true,
      problem: null,
      touch: true,
      devices: [
        { udid: "SIM-17PRO", name: "iPhone 17 Pro", runtime: "iOS 26.0", booted: true },
        { udid: "SIM-16E", name: "iPhone 16e", runtime: "iOS 26.0", booted: false },
        { udid: "SIM-IPAD", name: "iPad Air 13-inch (M3)", runtime: "iOS 26.0", booted: false },
      ],
      frame: PHONE_SCREEN,
    },
    policy: POLICY,
    capabilities: CAPABILITIES,
    models: {
      "claude-code": [
        claudeModel("claude-opus-5-5", "Opus 5.5", "The current Opus: deep, careful work", EVERY_EFFORT, "medium"),
        claudeModel("claude-fable-5-1", "Fable 5.1", "The most capable, for the hardest, longest work", EVERY_EFFORT, "high"),
        claudeModel("claude-sonnet-5-5", "Sonnet 5.5", "Fast and capable for everyday work", EVERY_EFFORT, "high"),
        claudeModel("claude-haiku-4-5", "Haiku 4.5", "The quickest, for simple tasks", [], null),
        claudeModel("claude-sonnet-5", "Sonnet 5", "The previous Sonnet", EVERY_EFFORT, "xhigh", true),
        claudeModel("claude-opus-4-6", "Opus 4.6", "An earlier Opus", ["low", "medium", "high", "max"], "high", true),
      ],
    },
  };
}

function notification(
  id: number,
  kind: string,
  urgency: string,
  agentId: string,
  title: string,
  body: string,
  minutesAgo: number,
  over: Partial<Notification> = {},
): Notification {
  return {
    id,
    ts: ago(minutesAgo),
    kind,
    urgency,
    agent_id: agentId,
    task_id: null,
    cwd: "",
    title,
    body,
    review_id: null,
    read: false,
    handled: null,
    outcome: null,
    automation_id: null,
    reminder_id: null,
    ...over,
  };
}

const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A moment relative to NOW (Monday 5 October, 10:30 IST), by days and clock time. */
const on = (daysFromToday: number, hour: number, minute = 0) => NOW - (10 * HOUR + 30 * MINUTE) + daysFromToday * DAY + hour * HOUR + minute * MINUTE;

const automation = (over: Partial<Automation> & Pick<Automation, "id" | "name" | "agent_id" | "cwd" | "instruction" | "schedule">): Automation => ({
  enabled: true,
  missed: "run_once",
  notify: "failure",
  max_minutes: 60,
  wake: false,
  created: on(-30, 9),
  updated: on(-30, 9),
  next_run: null,
  last_run: null,
  last_status: null,
  ...over,
});

let runSeq = 0;
const run = (
  automationId: number,
  scheduledFor: number,
  status: string,
  minutes: number | null,
  summary: string,
  taskId: string | null = null,
  trigger = "schedule",
): AutomationRun => ({
  id: ++runSeq,
  automation_id: automationId,
  scheduled_for: scheduledFor,
  started: status === "missed" || status === "skipped" ? null : scheduledFor,
  finished: status === "running" ? null : minutes === null ? scheduledFor : scheduledFor + minutes * MINUTE,
  status,
  task_id: taskId,
  summary,
  trigger,
});

const reminder = (over: Partial<Reminder> & Pick<Reminder, "id" | "text" | "agent_id" | "due">): Reminder => ({
  task_id: null,
  repeat: null,
  status: "waiting",
  fired: null,
  set_by: "you",
  created: ago(60 * 24),
  updated: ago(60 * 24),
  ...over,
});

function reminders(): Reminder[] {
  return [
    reminder({ id: 1, text: "Review EDITH's release notes", agent_id: "edith", due: on(0, 18), task_id: "t-notes" }),
    reminder({ id: 2, text: "Prepare for stand-up", agent_id: "jarvis", due: on(1, 9, 30), repeat: { kind: "weekdays", time: "09:30" }, set_by: "jarvis" }),
    reminder({ id: 3, text: "Renew the staging certificate", agent_id: "veronica", due: ago(60 * 26), status: "done", fired: ago(60 * 26), updated: ago(60 * 25) }),
  ];
}

/** A reminder that has just gone off, as the scheduler leaves it: due, with its notification open. */
export function withDueReminder(scenario: Scenario): Scenario {
  const due = reminder({ id: 9, text: "Check the staging deploy", agent_id: "veronica", due: ago(2), status: "due", fired: ago(2) });
  return {
    ...scenario,
    reminders: [due, ...scenario.reminders],
    notifications: [
      notification(90, "reminder", "needs_you", "veronica", due.text, "", 2, { reminder_id: due.id }),
      ...scenario.notifications,
    ],
  };
}

function automations(): Pick<Scenario, "automations" | "automationRuns"> {
  runSeq = 0;
  return {
    automations: [
      automation({
        id: 1,
        name: "Nightly code review",
        agent_id: "jarvis",
        cwd: APP,
        instruction: "Pull the latest changes, run the checks, and review what changed since yesterday. Summarise anything that needs attention.",
        schedule: { kind: "weekdays", time: "02:00" },
        next_run: on(1, 2),
        last_run: on(0, 2),
        last_status: "succeeded",
      }),
      automation({
        id: 2,
        name: "Morning project brief",
        agent_id: "edith",
        cwd: APP,
        instruction: "Read yesterday's tasks and notifications and write a short brief of what's in flight, what's blocked and what needs a decision.",
        schedule: { kind: "daily", time: "08:00" },
        notify: "always",
        max_minutes: 30,
        next_run: on(1, 8),
        last_run: on(0, 8),
        last_status: "succeeded",
      }),
      automation({
        id: 3,
        name: "CI health check",
        agent_id: "veronica",
        cwd: API,
        instruction: "Check the last CI runs on main. If a job is flaky or slow, say which one and why.",
        schedule: { kind: "everyHours", hours: 4 },
        max_minutes: 15,
        next_run: on(0, 12),
        last_run: on(0, 8),
        last_status: "succeeded",
      }),
      automation({
        id: 4,
        name: "Architecture drift check",
        agent_id: "vision",
        cwd: API,
        instruction: "Compare the refunds service with its architecture notes and list anything that has drifted.",
        schedule: { kind: "weekly", day: 3, time: "17:00" },
        missed: "ask",
        max_minutes: 120,
        next_run: on(3, 17),
        last_run: on(-4, 17),
        last_status: "failed",
      }),
      automation({
        id: 5,
        name: "Weekly dependency audit",
        agent_id: "veronica",
        cwd: API,
        instruction: "Audit dependencies for known vulnerabilities and outdated majors. Open a task for anything urgent.",
        schedule: { kind: "weekly", day: 0, time: "09:00" },
        enabled: false,
        missed: "skip",
        last_run: on(-7, 9),
        last_status: "succeeded",
      }),
    ],
    automationRuns: [
      run(1, on(0, 2), "succeeded", 42, "Reviewed 14 commits. Two suggestions on the refunds handler, nothing blocking.", "t-review"),
      run(1, on(-3, 2), "succeeded", 38, "Reviewed 9 commits. No problems found."),
      run(1, on(-4, 2), "failed", 60, "It ran past its 60-minute limit, so Starkline stopped it."),
      run(1, on(-5, 2), "succeeded", 31, "Reviewed 6 commits. No problems found.", null, "late"),
      run(1, on(-6, 2), "succeeded", 36, "Reviewed 21 commits. Flagged a missing test for the coupon parser."),
      run(2, on(0, 8), "succeeded", 6, "Brief written: three tasks in flight, one blocked on a migration approval."),
      run(3, on(0, 8), "succeeded", 4, "All green. The e2e job is 20% slower than last week."),
      run(4, on(-4, 17), "failed", 12, "The session ended before the task finished."),
      run(4, on(-11, 17), "missed", null, "The Mac was asleep or Starkline was closed, so you were asked what to do."),
      run(4, on(-18, 17), "succeeded", 22, "No drift found. The settle step matches the notes.", null, "you"),
      run(5, on(-7, 9), "succeeded", 18, "No known vulnerabilities. Two packages are a major version behind."),
    ],
  };
}

function emptyTotal(): SpendTotal {
  return { cost_usd: 0, input_tokens: 0, output_tokens: 0, context_tokens: 0, turns: 0, unpriced_turns: 0 };
}

function emptySpend(): SpendSummary {
  return {
    today: emptyTotal(), week: emptyTotal(), month: emptyTotal(),
    budget: { period: "month", limit_usd: 0, warn_percent: 80 }, budget_spend: 0,
    days: Array.from({ length: 30 }, (_, n) => ({ date: new Date(Date.UTC(2026, 9, 5 - 29 + n)).toISOString().slice(0, 10), total: emptyTotal() })),
    agents: [], projects: [], models: [], first_date: null, has_spend: false,
  };
}

/** A small record of priced Claude work and token-only Codex work. */
export function spendScenario(): Scenario {
  const scenario = defaultScenario();
  const total = (cost_usd: number, turns: number, unpriced_turns = 0): SpendTotal => ({ cost_usd, turns, unpriced_turns, input_tokens: turns * 1200, output_tokens: turns * 200, context_tokens: turns * 1800 });
  scenario.spend = {
    ...emptySpend(), today: total(3.2, 3, 1), week: total(3.2, 3, 1), month: total(8.5, 7, 2),
    budget: { period: "month", limit_usd: 10, warn_percent: 80 }, budget_spend: 8.5, first_date: "2026-10-04", has_spend: true,
    agents: [{ key: "friday", total: total(8.5, 5) }, { key: "vision", total: total(0, 2, 2) }],
    projects: [{ key: APP, total: total(8.5, 7, 2) }],
    models: [{ key: "sonnet", total: total(8.5, 5) }, { key: "gpt-5.4", total: total(0, 2, 2) }],
  };
  scenario.spend.days[28].total = total(5.3, 4, 1);
  scenario.spend.days[29].total = total(3.2, 3, 1);
  scenario.config = { ...scenario.config, budget: scenario.spend.budget };
  scenario.conversationSpend = { 20: { total: total(1.24, 2), context_tokens: 3200 } };
  return scenario;
}

/** A completed task with a worktree and collaborators' file reservations. */
export function workspacesScenario(dirty = false): Scenario {
  const scenario = defaultScenario();
  const owner = scenario.tasks.find((t) => t.id === "t-settings")!;
  const path = "/Users/dev/.starkline/worktrees/checkout-web/settings-abcd";
  const branch = "starkline/settings-abcd";
  owner.project_folder = owner.cwd;
  owner.cwd = path;
  owner.workspace_kind = "worktree";
  owner.branch = branch;
  owner.status = "done";
  owner.finished = NOW;
  scenario.statuses[owner.assignee] = "idle";
  scenario.worktrees = [{ path, project: APP, branch, base: "main", base_commit: "a1b2c3d4567890", task_id: owner.id, created: NOW, removed: null }];
  scenario.branches[path] = branch;
  scenario.changes[path] = dirty ? [{ path: "src/settings/Form.tsx", status: "modified", added: 8, removed: 2 }] : [];
  const chat = scenario.conversations.find((c) => c.id === owner.conversation_id)!;
  chat.cwd = path;
  chat.project_folder = APP;
  chat.branch = branch;
  scenario.taskEvents[owner.id] = [taskEvent(owner.id, owner.assignee, "workspace", "A separate worktree was created because FRIDAY is already working in checkout-web. It starts from main at a1b2c3d; your uncommitted changes aren't in it.", 5), taskEvent(owner.id, owner.assignee, "claim_refused", "VISION has claimed src/types.ts (Shared types). Ask VISION to release it.", 3)];
  scenario.claims = [{ workspace: path, path: "src/settings/Form.tsx", agent_id: owner.assignee, task_id: owner.id, reason: "Settings UI", exclusive: true }];
  return scenario;
}

/** Both hosts use the same delivery flow, with provider-specific names and URLs. */
export function deliveryScenario(kind: "github" | "gitlab" = "github"): Scenario {
  const scenario = defaultScenario();
  const task = scenario.tasks.find((t) => t.id === "t-settings")!;
  const hostname = kind === "github" ? "github.com" : "gitlab.example.com";
  scenario.branches[task.cwd] = "main";
  scenario.delivery[task.cwd] = { branch:"main", default_branch:"main", new_branch:"starkline/redesign-the-settings-page", host: { kind, hostname, repository:"team/sub/app", remote:"origin", connection:null }, pushed:false, request_url:null, request_title:task.title };
  return scenario;
}
export function codeReviewScenario(kind: "github" | "gitlab" = "github"): Scenario {
  const scenario = deliveryScenario(kind);
  const task = scenario.tasks.find((t) => t.id === "t-settings")!;
  const url = kind === "github" ? "https://github.com/team/app/pull/128" : "https://gitlab.example.com/team/sub/app/-/merge_requests/45";
  scenario.codeReviews = { has_host:true, connections:[], items:[{ id:url, cwd:task.cwd, host_kind:kind, number:kind === "github" ? 128 : 45, title:"Fix the login redirect", url, branch:"fix/login", head:"abc123", reason:"failed", updated:"2026-10-06T10:00:00Z", failed_checks:["Tests"], agent_id:"friday", task_id:task.id }] };
  return scenario;
}

/** Dev commands only appear in scenarios that give the project a package file. */
export function withDevCommands(s: Scenario): Scenario {
  s.devservers.candidates[APP] = {
    folder: APP,
    options: [
      { id: "package:dev", label: "dev", command: "npm run dev", cwd: APP, env: {}, port: null },
      { id: "package:start", label: "start", command: "npm run start", cwd: APP, env: {}, port: null },
    ],
    selected: "package:start",
    custom: "",
  };
  s.config.dev_servers = { [APP]: { selected: "package:start", custom: "" } };
  return s;
}

/** A page element waiting for the developer's next pick. */
export function withBrowserPick(s: Scenario): Scenario {
  s.browser = {url:"http://localhost:5173/settings",title:"Settings",loading:false};
  s.browserPick = {
    selector:"#save",tag:"button",id:"save",classes:["primary"],role:"button",accessible_name:"Save changes",text:"Save changes",attributes:{type:"submit"},
    styles:{"background-color":"rgb(20, 120, 110)",color:"rgb(255, 255, 255)","font-size":"14px","line-height":"20px","font-family":"Inter","font-weight":"600",padding:"8px 16px","border-radius":"8px"},
    bounds:{x:840,y:412,width:120,height:32},url:s.browser.url,title:s.browser.title,viewport:{width:1280,height:800},device_pixel_ratio:2,outer_html:'<button id="save" class="primary">Save changes</button>',
  };
  return s;
}

/** A running device whose app was last launched through Starkline. */
export function withSimulatorControls(s: Scenario): Scenario {
  s.simulatorExtras["SIM-17PRO"] = {recording:null,saved:null,appearance:"light",last_bundle:"com.example.app",status_bar:false,logs:""};
  return s;
}
