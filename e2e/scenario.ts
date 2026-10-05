// What the fake backend starts with in end-to-end tests: the default roster,
// two projects, work in every state, and one of each kind of request.
// Test fixture only; the app itself never shows this data.
import type {
  AgentConfig,
  AgentStatus,
  AppConfig,
  Automation,
  AutomationRun,
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
  ReviewRequest,
  RuntimeHealth,
  StoredMessage,
  Task,
  TaskEvent,
} from "../src/lib/types";

/** Every test runs at this moment, so relative times and screenshots are stable. */
export const NOW = Date.parse("2026-10-05T10:30:00+05:30");
const MINUTE = 60_000;
const ago = (minutes: number) => NOW - minutes * MINUTE;

export interface Scenario {
  /** How long after the page loads the backend starts answering (the launch race); by default at once. */
  backendReadyAfterMs?: number;
  config: AppConfig;
  statuses: Record<string, AgentStatus>;
  projects: ProjectsState;
  tasks: Task[];
  conversations: Conversation[];
  /** Saved transcript per conversation id. */
  transcripts: Record<number, StoredMessage[]>;
  /** The open conversation per agent. */
  current: Record<string, number>;
  reviews: ReviewRequest[];
  bugs: Bug[];
  health: RuntimeHealth;
  power: PowerState;
  files: Record<string, PathEntry[]>;
  memory: Record<string, string>;
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

const APP = "/Users/dev/code/checkout-web";
const API = "/Users/dev/code/payments-api";

const agent = (a: Omit<AgentConfig, "engine" | "model" | "enabled">): AgentConfig => ({
  engine: "claude-code",
  model: "",
  enabled: true,
  ...a,
});

const config: AppConfig = {
  version: 4,
  onboarded: true,
  standup_minutes: 0,
  keep_awake: true,
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
      figure: "operative",
      personality: "",
      home_x: 1,
      home_y: 13,
    }),
  ],
};

const task = (
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
  ...over,
});

let eventSeq = 0;
const taskEvent = (taskId: string, agentId: string, kind: string, summary: string, minutesAgo: number, data: unknown = ""): TaskEvent => ({
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
    config,
    statuses: { jarvis: "idle", vision: "thinking", friday: "working", edith: "idle", karen: "working", veronica: "blocked", "dum-e": "offline" },
    projects: {
      active: APP,
      projects: [
        { path: APP, name: "checkout-web" },
        { path: API, name: "payments-api" },
      ],
    },
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
    policy: POLICY,
    capabilities: CAPABILITIES,
    models: {
      "claude-code": [
        { id: "opus", name: "Opus, the most capable", default: false },
        { id: "sonnet", name: "Sonnet, fast and capable", default: false },
        { id: "haiku", name: "Haiku, the quickest", default: false },
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
