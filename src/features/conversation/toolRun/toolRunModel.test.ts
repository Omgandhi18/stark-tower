import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../../stores/chats";
import { callInput, callLabel, callState, displayCommand, droppedImages, droppedImagesNote, groupTools, hasDetails, outputText, summarizeCalls } from "./toolRunModel";

let n = 0;
const tool = (name: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: ++n, role: "tool", tool: name, ...extra });
const text = (role: ChatMessage["role"]): ChatMessage => ({ id: ++n, role, text: "hi" });
const result = (over: Partial<NonNullable<ChatMessage["result"]>>): NonNullable<ChatMessage["result"]> => ({ text: "", isError: false, truncated: false, imagesDropped: 0, noResult: false, ...over });
const failed = { result: result({ text: "boom", isError: true }) };
const done = { result: result({ text: "ok" }) };

describe("groupTools", () => {
  it("makes one run of consecutive tool calls and leaves other messages alone", () => {
    const a = text("agent");
    const items = groupTools([text("user"), tool("Bash"), tool("Read"), a, tool("Edit")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "tools", "message", "tools"]);
    expect(items[1].kind === "tools" && items[1].calls).toHaveLength(2);
  });
});

describe("summarizeCalls", () => {
  it("counts by what the calls did, and says which failed", () => {
    const calls = [tool("Bash", done), tool("Bash", failed), tool("Read", done), tool("Read", done), tool("Edit", failed), tool("Edit", done)];
    expect(summarizeCalls(calls, false)).toBe("Ran 2 commands (1 failed), read 2 files, edited 2 files (1 failed)");
  });
  it("words one call and unknown tools", () => {
    expect(summarizeCalls([tool("Edit"), tool("mystery")], false)).toBe("Edited a file, used a tool");
    expect(summarizeCalls([tool("mystery"), tool("other")], false)).toBe("Used 2 tools");
  });
});

describe("callState", () => {
  it("is running only while the agent works and no result is in", () => {
    expect(callState(tool("Bash"), true)).toBe("running");
    expect(callState(tool("Bash"), false)).toBe("unknown");
    expect(callState(tool("Bash", failed), true)).toBe("failed");
    expect(callState(tool("Bash", done), false)).toBe("done");
  });
});

describe("callInput", () => {
  it("splits a command, a path and the other arguments", () => {
    expect(callInput(tool("Bash", { input: '{"command":"npm test","timeout":5}' }))).toEqual({ command: "npm test", args: '{\n  "timeout": 5\n}' });
    expect(callInput(tool("Read", { input: '{"file_path":"/a.ts"}' }))).toEqual({ path: "/a.ts" });
  });
  it("falls back to the row's detail for calls saved without input", () => {
    expect(callInput(tool("Bash", { detail: "ls" }))).toEqual({ command: "ls" });
    expect(callInput(tool("Edit", { detail: "/a.ts" }))).toEqual({ path: "/a.ts" });
    expect(callInput(tool("Grep", { detail: "foo" }))).toEqual({});
    expect(callInput(tool("Bash", { input: "not json", detail: "ls" }))).toEqual({ command: "ls" });
  });
});

describe("rows", () => {
  it("words a call in the present while it runs and the past once it's over", () => {
    expect(callLabel(tool("Bash", { detail: "npm test" }), "running")).toMatchObject({ lead: "Running", code: "npm test" });
    expect(callLabel(tool("Bash", { detail: "npm test" }), "done")).toMatchObject({ lead: "Ran", code: "npm test" });
    expect(callLabel(tool("Bash"), "unknown")).toEqual({ lead: "Ran", full: "Ran" });
  });
  it("uses a command's own description, and drops it from the arguments", () => {
    const call = tool("Bash", { input: '{"command":"git status --short","description":"Show the working tree"}', ...done });
    expect(callLabel(call, "done")).toEqual({ lead: "Show the working tree", full: "Show the working tree\ngit status --short" });
    expect(callInput(call)).toEqual({ command: "git status --short" });
  });
  it("names a file by itself, keeping the full path for the tooltip", () => {
    expect(callLabel(tool("Edit", { input: '{"file_path":"/Users/me/app/src/App.tsx"}' }), "done")).toEqual({
      lead: "Edited",
      code: "App.tsx",
      full: "Edited /Users/me/app/src/App.tsx",
    });
  });
  it("shows only a command's first line, and other tools' details as words", () => {
    expect(callLabel(tool("Bash", { detail: "cd app\nnpm test" }), "done").code).toBe("cd app …");
    expect(callLabel(tool("Task", { detail: "Find every settings option" }), "done")).toMatchObject({ lead: "Delegated Find every settings option" });
  });
  it("reads Codex's shell wrapper as the command inside it", () => {
    expect(displayCommand(`/bin/zsh -lc "npm run build"`)).toBe("npm run build");
    expect(displayCommand(`bash -c 'ls -la'`)).toBe("ls -la");
    expect(displayCommand("npm test")).toBe("npm test");
  });
  it("names MCP tools by server and tool", () => {
    expect(callLabel(tool("mcp__stark__claim_files"), "done").lead).toBe("Used Starkline: claim files");
    expect(callLabel(tool("mcp__vercel__get_project"), "running").lead).toBe("Using Vercel: get project");
  });
  it("opens only when there is something to show", () => {
    expect(hasDetails(tool("Grep"))).toBe(false);
    expect(hasDetails(tool("Bash", { detail: "ls" }))).toBe(true);
    expect(hasDetails(tool("Grep", done))).toBe(true);
  });
  it("shows streamed output until the result replaces it", () => {
    expect(outputText(tool("Bash", { liveOutput: "a" }))).toBe("a");
    expect(outputText(tool("Bash", { liveOutput: "a", ...done }))).toBe("ok");
  });
});

describe("calls that ended without a result", () => {
  it("settle as no result, whether or not the agent is still working", () => {
    const none = tool("Bash", { result: result({ noResult: true }) });
    expect(callState(none, true)).toBe("noresult");
    expect(callState(none, false)).toBe("noresult");
    expect(hasDetails(none)).toBe(false);
  });
});

describe("images too large to keep", () => {
  it("are counted, worded and open the row", () => {
    const big = tool("Read", { result: result({ imagesDropped: 1 }) });
    expect(droppedImages(big)).toBe(1);
    expect(droppedImages(tool("Read"))).toBe(0);
    expect(hasDetails(big)).toBe(true);
    expect(droppedImagesNote(1)).toBe("Image too large to keep");
    expect(droppedImagesNote(3)).toBe("3 images too large to keep");
  });
});
