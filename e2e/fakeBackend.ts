// A stand-in for the Rust backend, installed into the page before the app
// loads. It answers the same commands and emits the same events, so end-to-end
// tests drive the real UI against predictable state. `window.__fake` lets a
// test inspect calls and push events.
import type { Page } from "@playwright/test";
import type { Scenario } from "./scenario";

export interface FakeCall {
  cmd: string;
  args: Record<string, unknown>;
}

/** Runs inside the page: must not reference anything outside its own body. */
function install(scenario: Scenario) {
  type Json = Record<string, unknown>;
  const state = JSON.parse(JSON.stringify(scenario)) as Scenario;
  const original = JSON.parse(JSON.stringify(scenario.config)) as Scenario["config"];
  const callbacks = new Map<number, (payload: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  const calls: Array<{ cmd: string; args: Json }> = [];
  let nextCallback = 1;
  let nextConversation = 100;
  let nextMessage = 1_000;
  const REPLY_DELAY_MS = 60;
  // Tests fix the clock (Date), so the launch race is timed on the page's own monotonic clock.
  const readyAt = performance.now() + (scenario.backendReadyAfterMs ?? 0);

  // Tone dials as the backend starts them, filled in at load as it does.
  const usualTone = (agentId: string) => {
    const dials: Record<string, [number, number, number, number, number]> = {
      jarvis: [2, 3, 4, 1, 1],
      friday: [3, 2, 1, 3, 1],
      vision: [1, 0, 3, 1, 2],
      edith: [1, 1, 2, 3, 1],
      karen: [2, 1, 1, 4, 3],
      veronica: [1, 2, 2, 1, 0],
      "dum-e": [3, 0, 0, 4, 1],
    };
    const [humour, sarcasm, formality, enthusiasm, detail] = dials[agentId] ?? [1, 1, 2, 2, 2];
    return { humour, sarcasm, formality, enthusiasm, detail };
  };
  for (const a of state.config.agents) a.tone ??= usualTone(a.id);

  // Kept copies of attached files. They point at images the dev server really serves, so previews render.
  const SAMPLE_IMAGES = ["/src/assets/portraits/engineer.png", "/src/assets/portraits/commander.png", "/src/assets/portraits/architect.png"];
  let nextKept = 0;
  const kindOf = (name: string): { kind: string; mime: string } => {
    const ext = name.split(".").pop()?.toLowerCase() ?? "";
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return { kind: "image", mime: `image/${ext === "jpg" ? "jpeg" : ext}` };
    if (ext === "md") return { kind: "markdown", mime: "text/markdown" };
    if (ext === "html") return { kind: "html", mime: "text/html" };
    if (ext === "pdf") return { kind: "pdf", mime: "application/pdf" };
    if (["txt", "csv", "json", "ts"].includes(ext)) return { kind: "text", mime: "text/plain" };
    return { kind: "file", mime: "application/octet-stream" };
  };
  const keep = (name: string) => {
    const { kind, mime } = kindOf(name);
    const n = nextKept++;
    const path = kind === "image" ? SAMPLE_IMAGES[n % SAMPLE_IMAGES.length] : `/attachments/${n}/${name}`;
    return { path, name, mime, kind, size: 48_213 + n };
  };
  const SAMPLE_TEXT: Record<string, string> = {
    html: "<html><head><title>Pricing</title></head><body style='font-family:sans-serif'><h1>Pricing</h1><p>Three plans, monthly or yearly.</p></body></html>",
    markdown: "# Release notes 2.4\n\n- Refunds from the dashboard\n- Dark mode\n- Faster checkout",
    text: "id,amount\n1,20\n2,35",
  };

  const emit = (event: string, payload: unknown) => {
    for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
  };

  const roster = () =>
    state.config.agents
      .filter((a) => a.enabled !== false)
      .map((a) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        kind: a.kind,
        engine: a.engine ?? "",
        accent: a.accent ?? "",
        figure: a.figure ?? "",
        home_x: a.home_x,
        home_y: a.home_y,
        status: state.statuses[a.id] ?? "offline",
      }));

  const setStatus = (agentId: string, status: string) => {
    state.statuses[agentId] = status as Scenario["statuses"][string];
    emit("agent://status", { agentId, status });
  };

  const commitConfig = () => {
    emit("config://changed", state.config);
    return state.config;
  };

  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Settle an automation's open notifications, as the backend does. */
  const settleAutomation = (automationId: number, outcome: string) => {
    state.notifications = state.notifications.map((n) =>
      n.automation_id === automationId && n.handled === null ? { ...n, handled: Date.now(), outcome, read: true } : n,
    );
    emit("notifications://changed", null);
  };

  const conversationOf = (agentId: string) => state.conversations.find((c) => c.id === state.current[agentId]) ?? null;

  const persist = (agentId: string, role: string, fields: Json) => {
    let id = state.current[agentId];
    if (id === undefined) {
      id = nextConversation++;
      state.current[agentId] = id;
      state.conversations.unshift({
        id,
        agent_id: agentId,
        title: String(fields.text ?? "New chat").slice(0, 60),
        cwd: state.projects.active,
        created: Date.now(),
        updated: Date.now(),
        delegated: false,
      });
      state.transcripts[id] = [];
      emit("conversations://changed", null);
    }
    const transcript = state.transcripts[id];
    const messageId = nextMessage++;
    transcript.push({ id: messageId, ts: Date.now(), role, text: null, tool: null, detail: null, ...fields });
    return messageId;
  };

  /** A short scripted reply so a sent message visibly gets an answer. */
  const reply = (agentId: string, text: string) => {
    setStatus(agentId, "working");
    const steps: Array<() => void> = [
      () => {
        const detail = "src/pages/Settings.tsx";
        const messageId = persist(agentId, "tool", { tool: "Read", detail });
        emit("chat://event", { agentId, kind: "tool", tool: "Read", detail, messageId });
      },
      () => {
        const answer = `Got it: "${text}". I'll take care of it.`;
        const messageId = persist(agentId, "agent", { text: answer });
        emit("chat://event", { agentId, kind: "text", text: answer, messageId });
      },
      () => {
        emit("chat://event", { agentId, kind: "result" });
        setStatus(agentId, "idle");
      },
    ];
    steps.forEach((step, i) => window.setTimeout(step, REPLY_DELAY_MS * (i + 1)));
  };

  // A reminder dealt with settles its open notification, as the backend does.
  const settleReminder = (id: number, outcome: string) => {
    state.notifications = state.notifications.map((n) => (n.reminder_id === id && n.handled === null ? { ...n, handled: Date.now(), outcome, read: true } : n));
    emit("reminders://changed", null);
    emit("notifications://changed", null);
  };

  let nextTerminal = state.terminals.length;
  const terminalChannels = new Map<string, { callback: number; index: number }>();
  const terminalOutput = (id: string, text: string, exit_code: number | null = null) => {
    const terminal = state.terminals.find((t) => t.id === id);
    if (!terminal) return;
    const data = Array.from(new TextEncoder().encode(text));
    terminal.output = [...terminal.output, ...data].slice(-256 * 1024);
    terminal.offset += data.length;
    const channel = terminalChannels.get(id);
    if (channel) callbacks.get(channel.callback)?.({ index: channel.index++, message: { data, offset: terminal.offset, exit_code } });
  };

  const commands: Record<string, (args: Json) => unknown> = {
    "plugin:event|listen": (args) => {
      const event = String(args.event);
      const set = listeners.get(event) ?? new Set<number>();
      set.add(Number(args.handler));
      listeners.set(event, set);
      return Number(args.handler);
    },
    "plugin:event|unlisten": () => null,
    "plugin:dialog|open": (args) =>
      (args.options as { directory?: boolean } | undefined)?.directory
        ? "/Users/dev/code/design-system"
        : ["/Users/dev/Desktop/mockup.png", "/Users/dev/Desktop/brief.md"],
    "plugin:opener|open_url": () => null,
    "plugin:window|destroy": () => null,
    "plugin:window|close": () => null,
    "plugin:window|set_fullscreen": () => null,
    "plugin:window|is_fullscreen": () => false,
    terminal_list: () => state.terminals.map((t) => ({ id: t.id, folder: t.folder, title: t.title, shell: t.shell, alive: t.alive, exit_code: t.exit_code, program_running: t.program_running, note: t.note })),
    terminal_open: (args) => {
      const id = `terminal-${nextTerminal++}`;
      const info = { id, folder: String(args.folder || "/Users/dev"), title: "zsh", shell: "zsh", alive: true, exit_code: null, program_running: false, note: args.folder ? null : "No project folder was selected. This terminal opened in your home folder." };
      state.terminals.push({ ...info, output: Array.from(new TextEncoder().encode("$ ")), offset: 2, input: "" });
      return info;
    },
    terminal_attach: (args) => {
      const id = String(args.id);
      const channel = args.channel as { id: number };
      terminalChannels.set(id, { callback: channel.id, index: 0 });
      const terminal = state.terminals.find((t) => t.id === id)!;
      return { data: terminal.output, offset: terminal.offset, exit_code: terminal.exit_code };
    },
    terminal_write: (args) => {
      const terminal = state.terminals.find((t) => t.id === args.id)!;
      for (const char of String(args.data)) {
        if (char === "\r" || char === "\n") {
          const command = terminal.input;
          terminal.input = "";
          if (command === "exit") {
            terminal.alive = false; terminal.exit_code = 0;
            terminalOutput(terminal.id, "\r\n", 0);
          } else if (command === "npm run dev") {
            terminal.program_running = true; terminal.title = command;
            terminalOutput(terminal.id, "\r\n\x1b]0;npm run dev\x07Server ready at http://localhost:5173\r\n");
          } else {
            terminalOutput(terminal.id, `\r\n${command.startsWith("echo ") ? command.slice(5) + "\r\n" : ""}$ `);
          }
        } else if (char === "\x7f") {
          terminal.input = terminal.input.slice(0, -1); terminalOutput(terminal.id, "\b \b");
        } else { terminal.input += char; terminalOutput(terminal.id, char); }
      }
      return null;
    },
    terminal_resize: () => null,
    terminal_title: (args) => { const terminal = state.terminals.find((t) => t.id === args.id); if (terminal) terminal.title = String(args.title); return null; },
    terminal_close: (args) => { state.terminals = state.terminals.filter((t) => t.id !== args.id); terminalChannels.delete(String(args.id)); return null; },
    list_agents: () => roster(),
    get_config: () => state.config,
    list_projects: () => state.projects,
    add_project: (args) => {
      const path = String(args.path);
      if (!state.projects.projects.some((p) => p.path === path)) {
        state.projects.projects.push({ path, name: path.split("/").pop() ?? path });
      }
      return state.projects;
    },
    set_project: (args) => {
      state.projects.active = String(args.path);
      return state.projects;
    },
    remove_project: (args) => {
      state.projects.projects = state.projects.projects.filter((p) => p.path !== args.path);
      return state.projects;
    },
    get_tasks: () => state.tasks,
    start_task: (args) => {
      const agentId = String(args.agentId);
      const prompt = String(args.prompt);
      const busy = ["working", "thinking", "blocked"].includes(state.statuses[agentId] ?? "offline");
      const id = `t-new-${state.tasks.length + 1}`;
      const cwd = String(args.dir ?? state.projects.active);
      const now = Date.now();
      const task = {
        id,
        ts: now,
        updated: now,
        title: prompt.split("\n")[0].slice(0, 80),
        assignee: agentId,
        status: busy ? "todo" : "doing",
        detail: null,
        cwd,
        conversation_id: null as number | null,
        parent_id: null,
        requested_by: "you",
        prompt,
        branch: state.branches[cwd] ?? "",
        started: busy ? null : now,
        finished: null,
        plan_done: null,
        plan_total: null,
      };
      state.tasks.unshift(task);
      if (!busy) {
        // Like the app: the request continues the developer's chat with that agent in the project.
        const folder = (path: string) => path.replace(/\/+$/, "");
        const inFolder = (c: (typeof state.conversations)[number]) => c.agent_id === agentId && !c.delegated && folder(c.cwd) === folder(cwd);
        const open = conversationOf(agentId);
        const chat = open && inFolder(open) ? open : [...state.conversations].filter(inFolder).sort((a, b) => b.updated - a.updated)[0];
        const conversationId = chat?.id ?? nextConversation++;
        if (!chat) {
          state.conversations.unshift({ id: conversationId, agent_id: agentId, title: task.title, cwd, created: now, updated: now, delegated: false });
          state.transcripts[conversationId] = [];
        }
        state.current[agentId] = conversationId;
        task.conversation_id = conversationId;
        emit("chat://switched", { agentId, conversationId });
        persist(agentId, "user", { text: prompt });
        reply(agentId, prompt);
      }
      emit("tasks://changed", null);
      return task;
    },
    get_task_detail: (args) => {
      const id = String(args.id);
      const task = state.tasks.find((t) => t.id === id);
      if (!task) return null;
      return {
        task,
        children: state.tasks.filter((t) => t.parent_id === id),
        events: state.taskEvents[id] ?? [],
        plan: state.plans[id] ?? [],
        checks: state.checks[id] ?? [],
        changes: state.changes[task.cwd] ?? [],
        branch: state.branches[task.cwd] ?? null,
        messages: task.conversation_id !== null ? (state.transcripts[task.conversation_id] ?? []) : [],
      };
    },
    get_task_file_diff: (args) => {
      const diff = state.diffs[String(args.path)];
      if (diff === undefined) throw "There is no change to show for that file.";
      return diff;
    },
    review_task: (args) => {
      const task = state.tasks.find((t) => t.id === args.id);
      if (task?.status !== "done") throw "Only a task that's ready for review can be marked reviewed.";
      state.tasks = state.tasks.map((t) => (t.id === args.id ? { ...t, status: "reviewed" } : t));
      state.notifications = state.notifications.map((n) =>
        n.task_id === args.id && n.handled === null && n.kind === "task_ready" ? { ...n, handled: Date.now(), outcome: "Reviewed", read: true } : n,
      );
      emit("tasks://changed", null);
      emit("notifications://changed", null);
      return null;
    },
    close_task: (args) => {
      state.tasks = state.tasks.map((t) => (t.id === args.id ? { ...t, status: "closed" } : t));
      state.notifications = state.notifications.map((n) =>
        n.task_id === args.id && n.handled === null && ["task_ready", "task_blocked"].includes(n.kind)
          ? { ...n, handled: Date.now(), outcome: "Closed", read: true }
          : n,
      );
      emit("tasks://changed", null);
      emit("notifications://changed", null);
      return null;
    },
    list_notifications: () => [...state.notifications].sort((a, b) => b.ts - a.ts),
    mark_notifications_read: (args) => {
      const ids = args.ids as number[];
      state.notifications = state.notifications.map((n) => (ids.includes(n.id) ? { ...n, read: true } : n));
      return null;
    },
    mark_all_notifications_read: () => {
      state.notifications = state.notifications.map((n) => ({ ...n, read: true }));
      return null;
    },
    permission_policy: () => state.policy,
    provider_capabilities: () => state.capabilities,
    provider_models: (args) => {
      const models = state.models[String(args.engineId)];
      if (!models) throw "That provider isn't installed on this Mac.";
      return models;
    },
    list_permission_rules: (args) => (args.includeRevoked ? state.rules : state.rules.filter((r) => r.revoked === null)),
    revoke_permission_rule: (args) => {
      state.rules = state.rules.map((r) => (r.id === args.id ? { ...r, revoked: Date.now() } : r));
      emit("rules://changed", null);
      return true;
    },
    browser_page: () => state.browser,
    browser_show: () => null,
    browser_hide: () => null,
    browser_go: () => null,
    browser_navigate: (args) => {
      const typed = String(args.url).trim();
      if (!typed) throw "Type an address.";
      const url = /^https?:\/\//.test(typed) ? typed : typed.startsWith("localhost") ? `http://${typed}` : `https://${typed}`;
      state.browser = { url, title: "", loading: true };
      emit("browser://changed", state.browser);
      setTimeout(() => {
        state.browser = { url, title: "Checkout settings", loading: false };
        emit("browser://changed", state.browser);
      }, 30);
      return state.browser;
    },
    simulator_status: () => {
      const { frame: _frame, ...status } = state.simulator;
      return status;
    },
    simulator_boot: (args) => {
      state.simulator.devices = state.simulator.devices.map((d) => (d.udid === args.udid ? { ...d, booted: true } : d));
      return null;
    },
    simulator_shutdown: (args) => {
      state.simulator.devices = state.simulator.devices.map((d) => (d.udid === args.udid ? { ...d, booted: false } : d));
      return null;
    },
    simulator_frame: () => state.simulator.frame,
    simulator_tap: () => null,
    simulator_swipe: () => null,
    simulator_type: () => null,
    simulator_home: () => null,
    simulator_open_app: () => null,
    list_reminders: () => [...state.reminders].sort((a, b) => a.due - b.due || a.id - b.id),
    save_reminder: (args) => {
      const input = args.input as Scenario["reminders"][number] & { id: number | null };
      if (!input.text.trim()) throw "Say what to remind you of.";
      if (!input.repeat && input.due <= Date.now()) throw "Pick a time that hasn't passed.";
      const existing = state.reminders.find((r) => r.id === input.id);
      const now = Date.now();
      const saved = {
        ...(existing ?? { created: now, fired: null, set_by: "you" }),
        ...input,
        id: existing?.id ?? Math.max(0, ...state.reminders.map((r) => r.id)) + 1,
        text: input.text.trim(),
        status: "waiting",
        updated: now,
      } as Scenario["reminders"][number];
      state.reminders = existing ? state.reminders.map((r) => (r.id === saved.id ? saved : r)) : [...state.reminders, saved];
      emit("reminders://changed", null);
      return saved;
    },
    complete_reminder: (args) => {
      state.reminders = state.reminders.map((r) => (r.id === args.id && !r.repeat ? { ...r, status: "done", updated: Date.now() } : r));
      settleReminder(Number(args.id), "Done");
      return null;
    },
    snooze_reminder: (args) => {
      if (Number(args.until) <= Date.now()) throw "Pick a time that hasn't passed.";
      state.reminders = state.reminders.map((r) => (r.id === args.id ? { ...r, due: Number(args.until), status: "waiting", updated: Date.now() } : r));
      settleReminder(Number(args.id), "Snoozed");
      return state.reminders.find((r) => r.id === args.id);
    },
    delete_reminder: (args) => {
      state.reminders = state.reminders.filter((r) => r.id !== args.id);
      settleReminder(Number(args.id), "Deleted");
      return null;
    },
    list_automations: () => [...state.automations].sort((a, b) => a.name.localeCompare(b.name)),
    list_automation_runs: (args) => state.automationRuns.filter((r) => r.automation_id === args.id),
    save_automation: (args) => {
      const input = args.input as Scenario["automations"][number] & { id: number | null };
      if (!input.name.trim()) throw "Give the automation a name.";
      if (!input.instruction.trim()) throw "Say what the agent should do each run.";
      const existing = state.automations.find((a) => a.id === input.id);
      const now = Date.now();
      const saved = {
        ...(existing ?? { created: now, last_run: null, last_status: null }),
        ...input,
        id: existing?.id ?? Math.max(0, ...state.automations.map((a) => a.id)) + 1,
        updated: now,
        next_run: input.enabled ? (existing?.next_run ?? now + DAY_MS) : null,
      } as Scenario["automations"][number];
      state.automations = existing ? state.automations.map((a) => (a.id === saved.id ? saved : a)) : [...state.automations, saved];
      emit("automations://changed", null);
      return saved;
    },
    set_automation_enabled: (args) => {
      const a = state.automations.find((x) => x.id === args.id);
      if (!a) throw "That automation doesn't exist.";
      a.enabled = Boolean(args.enabled);
      a.next_run = a.enabled ? Date.now() + DAY_MS : null;
      if (!a.enabled) settleAutomation(a.id, "Paused");
      emit("automations://changed", null);
      return a;
    },
    delete_automation: (args) => {
      state.automations = state.automations.filter((a) => a.id !== args.id);
      state.automationRuns = state.automationRuns.filter((r) => r.automation_id !== args.id);
      settleAutomation(Number(args.id), "Deleted");
      emit("automations://changed", null);
      return null;
    },
    run_automation_now: (args) => {
      const a = state.automations.find((x) => x.id === args.id);
      if (!a) throw "That automation doesn't exist.";
      const now = Date.now();
      const taskId = `t-auto-${a.id}-${state.automationRuns.length + 1}`;
      state.tasks.unshift({
        id: taskId,
        ts: now,
        updated: now,
        title: a.name,
        assignee: a.agent_id,
        status: "doing",
        detail: null,
        cwd: a.cwd,
        conversation_id: null,
        parent_id: null,
        requested_by: `automation:${a.id}`,
        prompt: a.instruction,
        branch: state.branches[a.cwd] ?? "",
        started: now,
        finished: null,
        plan_done: null,
        plan_total: null,
      });
      const run = {
        id: state.automationRuns.length + 100,
        automation_id: a.id,
        scheduled_for: now,
        started: now,
        finished: null,
        status: "running",
        task_id: taskId,
        summary: "",
        trigger: "you",
      };
      state.automationRuns.unshift(run);
      a.last_run = now;
      a.last_status = "running";
      settleAutomation(a.id, "Ran it now");
      emit("tasks://changed", null);
      emit("automations://changed", null);
      return run;
    },
    skip_missed_run: (args) => {
      settleAutomation(Number(args.id), "Skipped");
      return null;
    },
    list_conversations: () => [...state.conversations].sort((a, b) => b.updated - a.updated),
    active_conversation: (args) => conversationOf(String(args.agentId)),
    get_chat: (args) => {
      const id = state.current[String(args.agentId)];
      return id === undefined ? [] : (state.transcripts[id] ?? []);
    },
    new_chat: (args) => {
      const agentId = String(args.agentId);
      const id = nextConversation++;
      const cwd = typeof args.cwd === "string" && args.cwd ? args.cwd : (conversationOf(agentId)?.cwd ?? state.projects.active);
      state.conversations.unshift({ id, agent_id: agentId, title: "", cwd, created: Date.now(), updated: Date.now(), delegated: false });
      state.transcripts[id] = [];
      state.current[agentId] = id;
      setStatus(agentId, "offline");
      emit("conversations://changed", null);
      return id;
    },
    delete_conversation: (args) => {
      const id = Number(args.conversationId);
      const chat = state.conversations.find((c) => c.id === id);
      if (!chat) throw "That chat doesn't exist any more.";
      const agentId = chat.agent_id;
      const wasOpen = state.current[agentId] === id;
      if (wasOpen && ["working", "thinking", "blocked"].includes(state.statuses[agentId] ?? "offline")) {
        const name = state.config.agents.find((a) => a.id === agentId)?.name ?? agentId;
        throw `${name} is working in this chat. Delete it once they've finished.`;
      }
      state.conversations = state.conversations.filter((c) => c.id !== id);
      delete state.transcripts[id];
      state.tasks = state.tasks.map((t) => (t.conversation_id === id ? { ...t, conversation_id: null } : t));
      if (wasOpen) {
        const fresh = nextConversation++;
        state.conversations.unshift({ id: fresh, agent_id: agentId, title: "", cwd: chat.cwd, created: Date.now(), updated: Date.now(), delegated: false });
        state.transcripts[fresh] = [];
        state.current[agentId] = fresh;
        emit("chat://switched", { agentId, conversationId: fresh });
      }
      emit("conversations://changed", null);
      emit("tasks://changed", null);
      return null;
    },
    open_conversation: (args) => {
      const conversation = state.conversations.find((c) => c.id === args.conversationId);
      if (conversation) state.current[conversation.agent_id] = conversation.id;
      emit("conversations://changed", null);
      return null;
    },
    attach_files: (args) => (args.paths as string[]).map((p) => keep(p.split("/").pop() ?? p)),
    attach_data: (args) => keep(String(args.name)),
    discard_attachments: () => null,
    read_attachment_text: (args) => {
      const path = String(args.path);
      const kind = kindOf(path).kind;
      if (!SAMPLE_TEXT[kind]) throw "Only a chat's own files can be previewed.";
      return SAMPLE_TEXT[kind];
    },
    "plugin:opener|open_path": () => null,
    "plugin:opener|reveal_item_in_dir": () => null,
    chat_send: (args) => {
      const agentId = String(args.agentId);
      const text = String(args.text);
      const files = (args.attachments as unknown[] | undefined) ?? [];
      const messageId = persist(agentId, "user", { text, ...(files.length ? { attachments: files } : {}) });
      reply(agentId, text);
      return messageId;
    },
    chat_stop: (args) => {
      setStatus(String(args.agentId), "offline");
      return null;
    },
    list_files: (args) => state.files[String(args.dir)] ?? [],
    get_memory: (args) => state.memory[String(args.agentId)] ?? "",
    pending_reviews: () => state.reviews,
    review_respond: (args) => {
      const decision = String(args.decision);
      const review = state.reviews.find((r) => r.id === args.id);
      if (review?.kind === "questions") {
        persist(review.agentId, "agent", { text: review.body || review.title });
        persist(review.agentId, "user", { text: decision });
      }
      const scopes: Record<string, string> = { "Allow for task": "task", "Allow in project": "project", "Allow everywhere": "everywhere" };
      if (review && scopes[decision] && review.grant) {
        state.rules.unshift({
          id: state.rules.length + 100,
          created: Date.now(),
          scope: scopes[decision],
          task_id: scopes[decision] === "task" ? review.taskId : null,
          project: scopes[decision] === "project" ? review.project : null,
          tool: review.kind === "command" ? "Bash" : "Write",
          pattern: review.grant,
          display: review.grant,
          rule: review.rule ?? "",
          tier: review.tier ?? "approval",
          uses: 0,
          last_used: null,
          revoked: null,
        });
        emit("rules://changed", null);
      }
      const outcomes: Record<string, string> = {
        Allow: "Allowed once",
        Deny: "Denied",
        "Allow for task": "Allowed for this task",
        "Allow in project": "Always allowed in this project",
        "Allow everywhere": "Always allowed everywhere",
      };
      state.notifications = state.notifications.map((n) =>
        n.review_id === args.id && n.handled === null ? { ...n, handled: Date.now(), outcome: outcomes[decision] ?? decision.slice(0, 80), read: true } : n,
      );
      emit("notifications://changed", null);
      state.reviews = state.reviews.filter((r) => r.id !== args.id);
      emit("review://resolved", args.id);
      return null;
    },
    runtime_health: () => state.health,
    power_state: () => state.power,
    set_keep_awake: (args) => {
      const enabled = Boolean(args.enabled);
      state.power = { ...state.power, enabled, holding: enabled && state.power.holding, reason: enabled ? state.power.reason : "Keep Awake is off." };
      return state.power;
    },
    default_tone: (args) => usualTone(String(args.agentId)),
    update_agent: (args) => {
      const next = args.agent as Scenario["config"]["agents"][number];
      next.tone ??= usualTone(next.id);
      const index = state.config.agents.findIndex((a) => a.id === next.id);
      if (index >= 0) state.config.agents[index] = next;
      else state.config.agents.push(next);
      return commitConfig();
    },
    remove_agent: (args) => {
      state.config.agents = state.config.agents.filter((a) => a.id !== args.id);
      return commitConfig();
    },
    update_engine: (args) => {
      const next = args.engine as Scenario["config"]["engines"][number];
      state.config.engines = state.config.engines.map((e) => (e.id === next.id ? next : e));
      return commitConfig();
    },
    remove_engine: (args) => {
      state.config.engines = state.config.engines.filter((e) => e.id !== args.id);
      return commitConfig();
    },
    set_onboarded: (args) => {
      state.config.onboarded = Boolean(args.value);
      return commitConfig();
    },
    set_theme: (args) => {
      const themes = ["rnd", "office", "mori"];
      const theme = String(args.theme);
      const outfits = String(args.outfits);
      if (!themes.includes(theme)) throw "That theme isn't one Starkline has.";
      if (![...themes, "theme", "own"].includes(outfits)) throw "Those outfits aren't ones Starkline has.";
      state.config.theme = theme;
      state.config.outfits = outfits;
      return commitConfig();
    },
    set_standup_minutes: (args) => {
      state.config.standup_minutes = Number(args.minutes);
      return commitConfig();
    },
    reset_config: () => {
      state.config = JSON.parse(JSON.stringify(original)) as Scenario["config"];
      return commitConfig();
    },
    get_bugs: () => state.bugs,
    set_bug_status: (args) => {
      state.bugs = state.bugs.map((b) => (b.id === args.id ? { ...b, status: String(args.status) } : b));
      emit("bugs://changed", null);
      return null;
    },
    run_maintenance: () => {
      state.bugs = state.bugs.map((b) => (b.status === "open" ? { ...b, status: "doing" } : b));
      emit("bugs://changed", null);
      setStatus("dum-e", "working");
      return null;
    },
    check_update: () => {
      emit("update://status", { available: false, latest: "0.1.0", current: "0.1.0", error: null });
      return null;
    },
  };

  Object.assign(window, {
    __fake: { state, calls, emit },
    __TAURI_EVENT_PLUGIN_INTERNALS__: {
      unregisterListener: (event: string, id: number) => listeners.get(event)?.delete(id),
    },
    __TAURI_INTERNALS__: {
      metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
      transformCallback: (callback: (payload: unknown) => void, once = false) => {
        const id = nextCallback++;
        callbacks.set(id, (payload) => {
          if (once) callbacks.delete(id);
          callback(payload);
        });
        return id;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (path: string) => path,
      invoke: async (cmd: string, args: Json = {}) => {
        calls.push({ cmd, args });
        // Until the backend is ready, app commands fail the way Tauri's do before setup has run.
        if (!cmd.startsWith("plugin:") && performance.now() < readyAt) {
          throw `state not managed for field \`state\` on command \`${cmd}\`. You must call \`.manage()\` before using this command`;
        }
        const handler = commands[cmd];
        if (!handler) {
          console.warn(`[fake backend] unhandled command ${cmd}`);
          return null;
        }
        // Real IPC serialises every answer, so callers never share objects with the backend.
        const answer = handler(args);
        return answer === undefined ? null : JSON.parse(JSON.stringify(answer));
      },
    },
  });
}

export async function installFakeBackend(page: Page, scenario: Scenario) {
  await page.addInitScript(install, scenario);
}

/** Every command the app sent, in order. */
export const fakeCalls = (page: Page) => page.evaluate(() => (window as unknown as { __fake: { calls: FakeCall[] } }).__fake.calls);

/** Emit a backend event into the app. */
export const fakeEmit = (page: Page, event: string, payload: unknown) =>
  page.evaluate(([e, p]) => (window as unknown as { __fake: { emit: (e: string, p: unknown) => void } }).__fake.emit(e, p), [event, payload] as const);
