// The PreToolUse hook against a stand-in app socket.
// Run with `node --test src-tauri/mcp/gate-hook.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";

const SCRIPT = new URL("./gate-hook.mjs", import.meta.url).pathname;

/** The environment without Starkline's own variables, so a run inside an agent's session tests only what each case sets. */
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("STARK_")));

async function fakeApp(answer) {
  const sock = join(mkdtempSync(join(tmpdir(), "starkline-hook-")), "bridge.sock");
  const requests = [];
  const server = net.createServer((conn) => {
    conn.on("data", (d) => {
      const request = JSON.parse(d.toString().split("\n")[0]);
      requests.push(request);
      conn.write(JSON.stringify(answer(request)) + "\n");
    });
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  return { sock, requests, close: () => server.close() };
}

function runHook(sock, event) {
  const child = spawn(process.execPath, [SCRIPT], {
    env: { ...BASE_ENV, STARK_DELEGATE_SOCK: sock, STARK_AGENT_ID: "friday", STARK_DELEGATE_TOKEN: "t" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify(event));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

test("stays silent when Starkline says the call is automatic", async () => {
  const app = await fakeApp(() => ({ tier: "automatic", rule: "Work inside the project", reason: "" }));
  try {
    const { code, out } = await runHook(app.sock, { tool_name: "Bash", tool_input: { command: "npm test" } });
    assert.equal(code, 0);
    assert.equal(out, "");
    assert.deepEqual(app.requests[0], { type: "classify", agentId: "friday", tool_name: "Bash", input: { command: "npm test" }, token: "t" });
  } finally {
    app.close();
  }
});

test("forces a prompt, with the rule and reason, for anything else", async () => {
  const app = await fakeApp(() => ({ tier: "never", rule: "Commit, push, deploy or publish", reason: "It sends commits to another repository." }));
  try {
    const { out } = await runHook(app.sock, { tool_name: "Bash", tool_input: { command: "git push" } });
    const output = JSON.parse(out).hookSpecificOutput;
    assert.equal(output.permissionDecision, "ask");
    assert.equal(output.permissionDecisionReason, "Commit, push, deploy or publish: It sends commits to another repository.");
  } finally {
    app.close();
  }
});

test("fails closed when Starkline can't be reached", async () => {
  const { out } = await runHook(join(tmpdir(), "missing-starkline.sock"), { tool_name: "Read", tool_input: { file_path: "/etc/hosts" } });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "ask");
});

test("refuses a claim conflict immediately without asking the developer", async () => {
  const app = await fakeApp(() => ({ tier: "refused", rule: "File ownership", reason: "KAREN has claimed Form.tsx (Settings UI). Ask KAREN to release it." }));
  try {
    const { out } = await runHook(app.sock, { tool_name: "Edit", tool_input: { file_path: "Form.tsx" } });
    const output = JSON.parse(out).hookSpecificOutput;
    assert.equal(output.permissionDecision, "deny");
    assert.match(output.permissionDecisionReason, /KAREN has claimed/);
  } finally { app.close(); }
});
