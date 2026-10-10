import { describe, expect, it } from "vitest";
import { blockedNotice, isNewChatEntry, newChatEntry, sessionCommandOf } from "./sessionCommands";
import { startsWithCommand } from "./slashLogic";

describe("sessionCommandOf", () => {
  it("answers /clear and its aliases with a new chat, whatever follows", () => {
    for (const text of ["/clear", "  /clear", "/Clear", "/reset", "/new", "/clear before the demo", "/new\nmore"]) {
      expect(sessionCommandOf(text), text).toEqual({ kind: "new-chat" });
    }
  });

  it("turns away the commands that swap, rewind or end the session", () => {
    for (const text of ["/resume", "/continue abc", "/sessions", "/branch x", "/rewind", "/checkpoint", "/undo", "/redo", "/exit", "/quit", "/background", "/bg"]) {
      expect(sessionCommandOf(text), text).toEqual({ kind: "blocked", name: text.slice(1).split(/\s/)[0] });
    }
  });

  it("leaves everything else alone, /compact included", () => {
    for (const text of ["/compact", "/compact keep the plan", "/clearly", "/new/file", "/review", "/mcp", "clear it", "please /clear", "/", ""]) {
      expect(sessionCommandOf(text), text).toBeNull();
    }
  });

  it("only fires on text that starts with a command, as startsWithCommand reads it", () => {
    for (const text of ["/clear", "/reset now", "/resume", "/exit\tnow"]) {
      expect(startsWithCommand(text), text).toBe(true);
    }
    for (const text of ["/clearly", "/new/file", "/ clear"]) {
      expect(sessionCommandOf(text), text).toBeNull();
    }
  });
});

describe("the menu entry", () => {
  it("is a built-in described with the agent's name", () => {
    const entry = newChatEntry("JARVIS");
    expect([entry.name, entry.description, entry.kind, entry.source]).toEqual(["clear", "Start a new chat with JARVIS", "builtin", "provider"]);
    expect(isNewChatEntry(entry)).toBe(true);
    expect(isNewChatEntry({ ...entry, name: "compact" })).toBe(false);
  });

  it("explains a blocked command", () => {
    expect(blockedNotice("resume")).toBe("/resume would change or end this chat's session behind Starkline's back, so it isn't sent.");
  });
});
