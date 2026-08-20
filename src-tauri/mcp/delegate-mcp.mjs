#!/usr/bin/env node
// MCP stdio server bridging a headless Claude Code agent to the Stark Tower app
// over a Unix socket. Two tools:
//   • delegate   — hand a task to a worker agent (JARVIS only)
//   • ask_human  — the lavish alternative: render a review in-app and block for
//                  the human's decision (any agent)
// Line-delimited JSON-RPC 2.0 over stdio. No external deps.
import net from "node:net";
import readline from "node:readline";

const SOCK = process.env.STARK_DELEGATE_SOCK;
const AGENT_ID = process.env.STARK_AGENT_ID || "jarvis";
// Per-launch secret the app expects on every bridge request; without it the app
// rejects the connection as unauthorized.
const TOKEN = process.env.STARK_DELEGATE_TOKEN || "";
// Only the orchestrator gets the delegate tool. STARK_ROLE is set by the app;
// fall back to the legacy id check if it's somehow missing.
const IS_ORCH =
  process.env.STARK_ROLE === "orchestrator" ||
  (!process.env.STARK_ROLE && AGENT_ID === "jarvis");

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function log(...a) {
  process.stderr.write("[stark-mcp] " + a.join(" ") + "\n");
}

/** Build the delegate tool from the live roster, so renamed and newly-added
 *  specialists are delegatable and the tool lists the current agents. */
function buildDelegateTool(workers) {
  const ids = workers.map((w) => w.id);
  const listing = workers
    .map((w) => `${w.id} (${w.name}, ${w.role})`)
    .join("; ");
  return {
    name: "delegate",
    description:
      "Dispatch a task to a worker agent by its id. NON-BLOCKING: this returns immediately with " +
      "an acknowledgement, NOT the worker's output; the result is delivered later as a " +
      "[DELEGATION RESULTS] message. To run agents in parallel, emit multiple delegate tool calls " +
      "in the SAME turn. Provide a complete, self-contained task (the worker does not see this " +
      "conversation)." +
      (listing ? " Available agents: " + listing + "." : ""),
    inputSchema: {
      type: "object",
      properties: {
        agent: ids.length
          ? { type: "string", enum: ids, description: "The worker's id." }
          : { type: "string", description: "The worker's id." },
        task: { type: "string", description: "Full self-contained instructions." },
        directory: { type: "string", description: "Absolute project dir (optional)." },
      },
      required: ["agent", "task"],
    },
  };
}

const ASK_HUMAN_TOOL = {
  name: "ask_human",
  description:
    "Show Om a review and BLOCK until he decides — the human-in-the-loop surface " +
    "(use this instead of any lavish/browser step). Use it to get sign-off on a plan, " +
    "approval of a diff, Fix/Defer/Decline decisions on review findings, an answer to " +
    "questions, a choice between options, or to show a rendered UI mockup. It renders in the " +
    "app as a review card from you and returns Om's decision (plus any notes). For most kinds " +
    "put the content in `body` as markdown (code fences and tables render). For kind 'mockup' " +
    "put a COMPLETE self-contained HTML document in `body` (inline CSS, no external network/CDN) " +
    "and the app renders it as a live screen preview. Keep `title` short.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short header for the review card." },
      body: {
        type: "string",
        description:
          "Markdown for plan/diff/findings/questions/choice, or a complete self-contained " +
          "HTML document when kind is 'mockup'.",
      },
      kind: {
        type: "string",
        enum: ["plan", "diff", "findings", "questions", "choice", "mockup"],
        description:
          "Shapes how it's shown. 'mockup' renders body as a live HTML UI preview; the rest " +
          "render body as markdown. Default 'choice'.",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        description:
          "Decision buttons (e.g. ['Approve','Request changes'] or ['Fix','Defer','Decline']). " +
          "Omit for a free-text answer (kind 'questions').",
      },
    },
    required: ["title", "body"],
  },
};

// ---- command permission gate (auto-run safe, route risky) ----
const SAFE_CMDS = new Set([
  "npm", "pnpm", "yarn", "bun", "npx", "node", "deno", "tsc", "tsx", "ts-node",
  "vite", "next", "expo", "jest", "vitest", "mocha", "cypress", "playwright",
  "eslint", "prettier", "biome", "cargo", "rustc", "rustup", "go", "python",
  "python3", "pip", "pip3", "poetry", "uv", "pytest", "ruff", "black", "mypy",
  "ruby", "bundle", "rails", "rake", "mvn", "gradle", "make", "cmake", "git",
  "gh", "ls", "cat", "head", "tail", "grep", "rg", "ag", "find", "fd", "mkdir",
  "touch", "echo", "pwd", "wc", "sed", "awk", "sort", "uniq", "cut", "tr",
  "diff", "cp", "mv", "which", "type", "env", "date", "whoami", "du", "df",
  "tree", "jq", "yq", "stat", "basename", "dirname", "readlink", "realpath",
  "xargs", "true", "test", "printf", "cd", "export", "source", "nvm", "fnm",
]);
const RISKY = [
  /\brm\s+-\w*[rf]/, /\bsudo\b/, /(^|\s)su\s/,
  /\|\s*(sudo\s+)?(sh|bash|zsh|fish)\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(sh|bash)/,
  /\bdd\b/, /\bmkfs\w*/, /\bfdisk\b/, /\bdiskutil\b/, /\bchmod\b/, /\bchown\b/,
  /git\s+push\b.*(--force|-f\b)/, /git\s+reset\s+--hard/, /git\s+clean\s+-\w*f/,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish)\b/,
  /\b(kill|pkill|killall)\b/, /\b(shutdown|reboot|halt)\b/,
  /\blaunchctl\b/, /\bsystemctl\b/, /\bcrontab\b/, /:\(\)\s*\{/,
  />\s*\/(etc|dev|sys|System|usr|bin|sbin|boot|Library)\b/,
];
function classifyBash(cmd) {
  const c = String(cmd || "");
  for (const r of RISKY) if (r.test(c)) return "route";
  const tokens = c.trim().split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  const first = (tokens[i] || "").replace(/^.*\//, "");
  return SAFE_CMDS.has(first) ? "allow" : "route";
}

const APPROVE_TOOL = {
  name: "approve",
  description:
    "Runtime permission gate — called automatically by Claude Code, not by you. Do not invoke directly.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
      tool_use_id: { type: "string" },
    },
  },
};

function bridge(payload) {
  return new Promise((resolve) => {
    if (!SOCK) return resolve({ error: "bridge socket not configured" });
    const conn = net.createConnection(SOCK);
    let buf = "";
    conn.on("connect", () =>
      conn.write(JSON.stringify({ ...payload, token: TOKEN }) + "\n"),
    );
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const line = buf.slice(0, nl);
        conn.end();
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve({ error: "bad response from app" });
        }
      }
    });
    conn.on("error", (e) => resolve({ error: String(e && e.message ? e.message : e) }));
  });
}

/** Fetch the current delegatable roster from the app over the socket. */
async function getRoster() {
  const res = await bridge({ type: "roster", agentId: AGENT_ID });
  return Array.isArray(res && res.workers) ? res.workers : [];
}

const MESSAGE_TOOL = {
  name: "message",
  description:
    "Send a short message to a teammate by their agent id — a question, a heads-up, or a hand-off " +
    "note. It's delivered to them when they're next free (you don't get a reply on this call). Use " +
    "it to coordinate directly with another specialist; use `ask_human` for anything that needs Om.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "The teammate's agent id." },
      body: { type: "string", description: "The message text." },
    },
    required: ["to", "body"],
  },
};

const REPORT_BUG_TOOL = {
  name: "report_bug",
  description:
    "Report a bug or error you hit in the Stark Tower APP ITSELF (the harness — not the project " +
    "you're working on): a broken tool, a wrong behavior, a crash, a confusing failure. It's filed " +
    "for the maintenance agent to fix later; you don't stop your work. Give a clear title and enough " +
    "detail (what you did, what happened, any error text) to reproduce it.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "One-line summary of the bug." },
      detail: { type: "string", description: "What happened, steps, error text." },
    },
    required: ["title"],
  },
};

async function toolsList() {
  const tools = [ASK_HUMAN_TOOL, MESSAGE_TOOL, REPORT_BUG_TOOL, APPROVE_TOOL];
  if (IS_ORCH) {
    const workers = await getRoster();
    tools.unshift(buildDelegateTool(workers));
  }
  return tools;
}

function result(id, text, isError) {
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
  });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (raw) => {
  const line = raw.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "stark-bridge", version: "0.2.0" },
      },
    });
  } else if (method === "notifications/initialized") {
    // no reply
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: await toolsList() } });
  } else if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (name === "delegate") {
      log("delegate ->", args.agent);
      const res = await bridge({
        type: "delegate",
        agent: args.agent,
        task: args.task,
        directory: args.directory || "",
      });
      if (res.error) result(id, "Delegation failed: " + res.error, true);
      else result(id, res.result || "(no result)");
    } else if (name === "ask_human") {
      log("ask_human ->", args.title);
      const res = await bridge({
        type: "review",
        agentId: AGENT_ID,
        title: args.title || "Review",
        body: args.body || "",
        kind: args.kind || "choice",
        choices: Array.isArray(args.choices) ? args.choices : [],
      });
      if (res.error) result(id, "ask_human failed: " + res.error, true);
      else result(id, res.result || "(no decision)");
    } else if (name === "message") {
      log("message ->", args.to);
      const res = await bridge({
        type: "message",
        agentId: AGENT_ID,
        to: args.to || "",
        body: args.body || "",
      });
      if (res.error) result(id, "message failed: " + res.error, true);
      else result(id, res.result || "(queued)");
    } else if (name === "report_bug") {
      log("report_bug ->", args.title);
      const res = await bridge({
        type: "report_bug",
        agentId: AGENT_ID,
        title: args.title || "",
        detail: args.detail || "",
      });
      if (res.error) result(id, "report_bug failed: " + res.error, true);
      else result(id, res.result || "(filed)");
    } else if (name === "approve") {
      const toolName = args.tool_name || args.toolName || "";
      const input = args.input || args.tool_input || {};
      let decision;
      if (toolName === "Bash") {
        const cmd = String((input && input.command) || "");
        if (classifyBash(cmd) === "allow") {
          decision = { behavior: "allow", updatedInput: input };
        } else {
          log("gate ->", cmd.slice(0, 60));
          const res = await bridge({ type: "approve", agentId: AGENT_ID, command: cmd });
          decision = res.approved
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: res.reason || "Om denied this command." };
        }
      } else {
        decision = { behavior: "allow", updatedInput: input };
      }
      result(id, JSON.stringify(decision));
    } else {
      result(id, "unknown tool", true);
    }
  } else if (method && id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
