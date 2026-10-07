#!/usr/bin/env node
// Claude Code PreToolUse hook. Asks Starkline whether a tool call may run on its
// own; anything that needs the developer becomes a permission prompt, which
// Claude Code hands to Starkline's `approve` tool. A hook's "ask" holds even
// when the developer's own Claude settings would allow the call, so the
// app's policy can't be skipped. Starkline decides; nothing is decided here.
import net from "node:net";

const SOCK = process.env.STARK_DELEGATE_SOCK;
const TOKEN = process.env.STARK_DELEGATE_TOKEN || "";
const AGENT_ID = process.env.STARK_AGENT_ID || "";
// The chat the tool call is from, so the gate judges it in that chat's folder.
const CHAT = /^\d+$/.test(process.env.STARK_CONVERSATION_ID || "") ? { conversationId: Number(process.env.STARK_CONVERSATION_ID) } : {};
const CHECK_TIMEOUT_MS = 10_000;

function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason },
    }),
  );
}

function classify(toolName, input) {
  return new Promise((resolve) => {
    if (!SOCK) return resolve({ error: "Starkline's bridge isn't configured." });
    const conn = net.createConnection(SOCK);
    const timer = setTimeout(() => {
      conn.destroy();
      resolve({ error: "Starkline didn't answer in time." });
    }, CHECK_TIMEOUT_MS);
    let buf = "";
    conn.on("connect", () =>
      conn.write(JSON.stringify({ type: "classify", agentId: AGENT_ID, ...CHAT, tool_name: toolName, input, token: TOKEN }) + "\n"),
    );
    conn.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      conn.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch {
        resolve({ error: "Starkline sent an unreadable answer." });
      }
    });
    conn.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: String((e && e.message) || e) });
    });
  });
}

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", async () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    ask("Starkline couldn't read this tool call.");
    return;
  }
  const verdict = await classify(event.tool_name || "", event.tool_input || {});
  if (verdict.error) {
    // Fail closed: the prompt goes to Starkline's approve tool, which asks the developer.
    ask(`Starkline couldn't check this call (${verdict.error}).`);
  } else if (verdict.tier === "refused") {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.reason } }));
  } else if (verdict.tier !== "automatic") {
    ask(`${verdict.rule}: ${verdict.reason}`);
  }
});
