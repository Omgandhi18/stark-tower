#!/usr/bin/env node
// MCP stdio server bridging a headless Claude Code agent to the Starkline app
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
    "Show the developer a review and BLOCK until they decide — the human-in-the-loop surface " +
    "(use this instead of any lavish/browser step). Use it to get sign-off on a plan, " +
    "approval of a diff, Fix/Defer/Decline decisions on review findings, an answer to " +
    "questions, a choice between options, or to show a rendered UI mockup. It renders in the " +
    "app as a review card from you and returns their decision (plus any notes). For most kinds " +
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
    "it to coordinate directly with another specialist; use `ask_human` for anything that needs the developer.",
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

const SHARE_TOOL = {
  name: "share",
  description:
    "Show the developer something you made — an image, chart, video, audio clip, PDF, web page " +
    "(HTML), document or any other file — right in the chat, as a preview they can open. Give " +
    "absolute paths or paths relative to your working folder; the files must be in the project or a " +
    "temporary folder. Starkline keeps a copy as it is now. Share finished results, not every file you touch.",
  inputSchema: {
    type: "object",
    properties: {
      paths: { type: "array", items: { type: "string" }, description: "The files to show." },
      caption: { type: "string", description: "A short line about what they are (optional)." },
    },
    required: ["paths"],
  },
};

const REMIND_TOOL = {
  name: "remind",
  description:
    "Set a reminder for the developer when they ask to be reminded of something (\"remind me at 5 to " +
    "check the deploy\"). When it's due, you remind them: a notification from you and a line in your " +
    "chat. Say when with `at`, a local time as \"YYYY-MM-DD HH:MM\" (or \"HH:MM\" for the next time the " +
    "clock shows it), or with `in_minutes`. Run `date` first if you need today's date. Tell them the " +
    "time it was set for.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "What to remind them of, in a few words (\"Check the deploy\")." },
      at: { type: "string", description: "Local time: \"YYYY-MM-DD HH:MM\", or \"HH:MM\"." },
      in_minutes: { type: "integer", description: "Or this many minutes from now." },
      repeat: {
        type: "string",
        enum: ["daily", "weekdays", "weekly"],
        description: "Repeat at the same time of day (needs `at`); leave out for once.",
      },
    },
    required: ["text"],
  },
};

const BROWSER_TOOL = {
  name: "browser",
  description:
    "Use Starkline's built-in browser, which the developer sees beside your chat. Open your app's dev " +
    "server (\"http://localhost:5173\") or any page, `read` it (its text and numbered controls), " +
    "`click` and `type` into it, `run_js`, read the `console`, and take a `screenshot` to check your " +
    "work. Pages on this Mac are yours to use; a page on the internet needs the developer's " +
    "permission, like any network access.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["open", "read", "click", "type", "run_js", "console", "screenshot", "back", "forward", "reload"],
      },
      url: { type: "string", description: "For open: the address." },
      target: {
        type: "string",
        description: "For click and type: a control's number from read (\"3\"), a CSS selector, or its visible words.",
      },
      text: { type: "string", description: "For type: what to type." },
      submit: { type: "boolean", description: "For type: submit afterwards, as Enter would." },
      script: { type: "string", description: "For run_js: an expression, or statements inside (() => { ... })()." },
    },
    required: ["action"],
  },
};

const DEV_SERVER_TOOL = {
  name: "dev_server",
  description: "Run your project's dev server in Starkline and open it in the shared browser. Use list for all servers, status for this project's server, start (optional command, otherwise its remembered choice), stop, restart, or logs (optional text filter). Starts and restarts go through the developer's shell permission rules.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "start", "stop", "restart", "logs", "status"] },
      command: { type: "string", description: "For start: a custom shell command; omit to use the project's choice." },
      filter: { type: "string", description: "For logs: return only lines containing this text." },
    },
    required: ["action"],
  },
};

const SIMULATOR_TOOL = {
  name: "simulator",
  description:
    "Use the iOS Simulator, which the developer sees beside your chat (needs Xcode on this Mac). List " +
    "the `devices`, `boot` one, `install` a built .app and `launch` it by bundle id, `open_url`, take a " +
    "`screenshot` to see the screen, and `tap` (x and y in points from the top left), `swipe` (from x, y " +
    "to to_x, to_y), `type` or go `home` (those four need AXe or idb). Build for a simulator with xcodebuild first. " +
    "Record with record_start/record_stop (stop returns a path to share), read logs, set appearance, location, push a notification or clean the status_bar.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["devices", "boot", "screenshot", "install", "launch", "open_url", "tap", "swipe", "type", "home", "record_start", "record_stop", "logs", "appearance", "location", "push", "status_bar"],
      },
      device: { type: "string", description: "A simulator's name or id; leave out for the running one." },
      path: { type: "string", description: "For install: the built .app bundle." },
      bundle_id: { type: "string", description: "For launch or push: the app's bundle id." },
      url: { type: "string", description: "For open_url: a link or deep link." },
      x: { type: "number", description: "For tap and swipe: points from the left." },
      y: { type: "number", description: "For tap and swipe: points from the top." },
      to_x: { type: "number", description: "For swipe: where it ends, from the left." },
      to_y: { type: "number", description: "For swipe: where it ends, from the top." },
      text: { type: "string", description: "For type: what to type." },
      mode: { type: "string", enum: ["light", "dark"], description: "For appearance." },
      latitude: { type: "number", description: "For location: −90 to 90." },
      longitude: { type: "number", description: "For location: −180 to 180." },
      clear: { type: "boolean", description: "For location: clear the simulated location." },
      enabled: { type: "boolean", description: "For status_bar: true cleans it, false restores it." },
      payload: { type: "string", description: "For push: a JSON object containing aps. Set bundle_id to the app." },
      minutes: { type: "integer", description: "For logs: how many recent minutes, default 5 (up to 60)." },
      predicate: { type: "string", description: "For logs: an optional log predicate." },
      process: { type: "string", description: "For logs: an optional process name." },
    },
    required: ["action"],
  },
};

const CLAIM_FILES_TOOL = {
  name: "claim_files",
  description: "Reserve files or folders exclusively before editing in a shared workspace. Sensitive files must be claimed. Overlaps report who holds them and why.",
  inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } }, reason: { type: "string" } }, required: ["paths", "reason"] },
};
const RELEASE_FILES_TOOL = {
  name: "release_files",
  description: "Release your reservations when done. Omit paths to release all your files.",
  inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } },
};

async function toolsList() {
  const tools = [CLAIM_FILES_TOOL, RELEASE_FILES_TOOL, ASK_HUMAN_TOOL, MESSAGE_TOOL, SHARE_TOOL, REMIND_TOOL, BROWSER_TOOL, DEV_SERVER_TOOL, SIMULATOR_TOOL, REPORT_BUG_TOOL, APPROVE_TOOL];
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
        agentId: AGENT_ID,
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
    } else if (name === "claim_files" || name === "release_files") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : [];
      const res = await bridge({ type: name, agentId: AGENT_ID, paths, reason: args.reason || "" });
      if (res.error) result(id, name + " failed: " + res.error, true);
      else result(id, res.result || "Done.");
    } else if (name === "share") {
      const paths = Array.isArray(args.paths) ? args.paths.filter((p) => typeof p === "string") : [];
      log("share ->", paths.length);
      const res = await bridge({ type: "share", agentId: AGENT_ID, paths, caption: args.caption || "" });
      if (res.error) result(id, "share failed: " + res.error, true);
      else result(id, res.result || "(shared)");
    } else if (name === "remind") {
      log("remind ->", args.at || args.in_minutes);
      const res = await bridge({
        type: "remind",
        agentId: AGENT_ID,
        text: args.text || "",
        at: args.at || "",
        inMinutes: Number.isInteger(args.in_minutes) ? args.in_minutes : null,
        repeat: args.repeat || "",
      });
      if (res.error) result(id, "remind failed: " + res.error, true);
      else result(id, res.result || "(set)");
    } else if (name === "browser" || name === "simulator" || name === "dev_server") {
      log(name, "->", args.action);
      const res = await bridge({
        type: name,
        agentId: AGENT_ID,
        action: args.action || "",
        command: args.command || "",
        filter: args.filter || "",
        url: args.url || "",
        target: args.target ?? "",
        text: args.text ?? "",
        submit: args.submit === true,
        script: args.script || "",
        device: args.device || "",
        path: args.path || "",
        bundle_id: args.bundle_id || "",
        x: args.x ?? null,
        y: args.y ?? null,
        to_x: args.to_x ?? null,
        to_y: args.to_y ?? null,
        ...(name === "simulator" ? {
          mode: args.mode,
          latitude: args.latitude,
          longitude: args.longitude,
          clear: args.clear,
          enabled: args.enabled,
          payload: args.payload,
          minutes: args.minutes,
          predicate: args.predicate,
          process: args.process,
        } : {}),
      });
      if (res.error) result(id, name + ": " + res.error, true);
      else if (res.image) {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              { type: "image", data: res.image, mimeType: res.mimeType || "image/jpeg" },
              { type: "text", text: res.result || "" },
            ],
          },
        });
      } else result(id, res.result || "(done)");
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
      // Every permission request goes to the app, which decides what may run on
      // its own. Nothing is decided here: this script lives where agents can edit it.
      const toolName = args.tool_name || args.toolName || "";
      const input = args.input || args.tool_input || {};
      log("gate ->", toolName);
      const res = await bridge({ type: "approve", agentId: AGENT_ID, tool_name: toolName, input });
      const decision = res.approved
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: res.reason || res.error || "The developer didn't allow this." };
      result(id, JSON.stringify(decision));
    } else {
      result(id, "unknown tool", true);
    }
  } else if (method && id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  }
});
