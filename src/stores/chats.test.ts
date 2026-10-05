import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import { mergeTranscript, messageFor, selectThread, useChats } from "./chats";

describe("messageFor", () => {
  it("turns session events into readable messages", () => {
    expect(messageFor({ agentId: "a", kind: "text", text: "Done.", messageId: 7 })).toEqual({ role: "agent", text: "Done.", storedId: 7 });
    expect(messageFor({ agentId: "a", kind: "tool", tool: "Edit", detail: "src/App.tsx" })).toEqual({
      role: "tool",
      tool: "Edit",
      detail: "src/App.tsx",
      storedId: undefined,
    });
    expect(messageFor({ agentId: "a", kind: "init", cwd: "/w/app" })?.text).toBe("Session started in /w/app");
  });

  it("ignores events that only change state", () => {
    expect(messageFor({ agentId: "a", kind: "result" })).toBeNull();
    expect(messageFor({ agentId: "a", kind: "system" })).toBeNull();
  });
});

describe("chats store", () => {
  beforeEach(() => useChats.setState({ threads: {} }));

  it("appends live events and clears pending when the turn settles", () => {
    const s = useChats.getState();
    s.pushUser("friday", "hi");
    s.setPending("friday", true);
    s.apply({ agentId: "friday", kind: "tool", tool: "Read", detail: "a.ts" });
    expect(selectThread("friday")(useChats.getState()).pending).toBe(true);
    s.apply({ agentId: "friday", kind: "result" });
    const thread = selectThread("friday")(useChats.getState());
    expect(thread.pending).toBe(false);
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "tool"]);
  });

  it("restores the saved transcript before live messages, with the chat's folder", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_chat") return [{ role: "user", text: "earlier", tool: null, detail: null, ts: 1 }];
      if (cmd === "active_conversation") return { id: 1, agent_id: "friday", title: "t", cwd: "/w/app", created: 1, updated: 1 };
      return null;
    });
    const s = useChats.getState();
    const loading = s.hydrate("friday");
    s.apply({ agentId: "friday", kind: "text", text: "live" });
    await loading;
    const thread = selectThread("friday")(useChats.getState());
    expect(thread.messages.map((m) => m.text)).toEqual(["earlier", "live"]);
    expect(thread.folder).toBe("/w/app");
    expect(thread.conversationId).toBe(1);
    expect(thread.loading).toBe(false);
  });

  it("stops loading when the transcript can't be read", async () => {
    mockIPC(() => {
      throw new Error("database locked");
    });
    await expect(useChats.getState().hydrate("edith")).rejects.toThrow("database locked");
    expect(selectThread("edith")(useChats.getState()).loading).toBe(false);
  });

  it("never shows a message twice when the transcript and live stream overlap", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_chat")
        return [
          { id: 1, role: "user", text: "fix it", tool: null, detail: null, ts: 1 },
          { id: 2, role: "tool", text: null, tool: "Read", detail: "a.ts", ts: 2 },
        ];
      return null;
    });
    const s = useChats.getState();
    const key = s.pushUser("vision", "fix it");
    const loading = s.hydrate("vision");
    s.apply({ agentId: "vision", kind: "tool", tool: "Read", detail: "a.ts", messageId: 2 });
    s.confirmStored("vision", key, 1);
    await loading;
    // Arrives after the transcript already had it.
    s.apply({ agentId: "vision", kind: "tool", tool: "Read", detail: "a.ts", messageId: 2 });
    s.apply({ agentId: "vision", kind: "text", text: "done", messageId: 3 });
    expect(selectThread("vision")(useChats.getState()).messages.map((m) => m.storedId)).toEqual([1, 2, 3]);
  });

  it("merges by stored id and keeps unsaved live messages", () => {
    const restored = [{ id: 1, role: "user" as const, text: "a", storedId: 10 }];
    const live = [
      { id: 2, role: "user" as const, text: "a", storedId: 10 },
      { id: 3, role: "error" as const, text: "boom" },
    ];
    expect(mergeTranscript(restored, live, 5).map((m) => m.id)).toEqual([1, 3]);
  });

  it("drops live output from other conversations", () => {
    const restored = [{ id: 1, role: "user" as const, text: "a", storedId: 10 }];
    const live = [
      { id: 2, role: "tool" as const, tool: "Read", storedId: 11, conversationId: 99 },
      { id: 3, role: "agent" as const, text: "mine", storedId: 12, conversationId: 5 },
    ];
    expect(mergeTranscript(restored, live, 5).map((m) => m.id)).toEqual([1, 3]);
    expect(mergeTranscript(restored, live, 5)[1]).not.toHaveProperty("conversationId");
  });

  it("ignores a delegated task's output once the chat is loaded, and starts over on a switch", async () => {
    mockIPC((cmd) => {
      if (cmd === "get_chat") return [];
      if (cmd === "active_conversation") return { id: 5, agent_id: "karen", title: "t", cwd: "/w", created: 1, updated: 1 };
      return null;
    });
    const s = useChats.getState();
    await s.hydrate("karen");
    s.apply({ agentId: "karen", kind: "tool", tool: "Edit", detail: "a.ts", conversationId: 77, messageId: 1 });
    s.apply({ agentId: "karen", kind: "text", text: "hello", conversationId: 5, messageId: 2 });
    expect(selectThread("karen")(useChats.getState()).messages.map((m) => m.text ?? m.tool)).toEqual(["hello"]);
    s.switchTo("karen", 5);
    expect(selectThread("karen")(useChats.getState()).hydrated).toBe(true);
    s.switchTo("karen", 6);
    expect(selectThread("karen")(useChats.getState()).hydrated).toBe(false);
  });

  it("hydrates only once", async () => {
    let calls = 0;
    mockIPC((cmd) => {
      if (cmd === "get_chat") calls++;
      return cmd === "get_chat" ? [] : null;
    });
    await useChats.getState().hydrate("vision");
    await useChats.getState().hydrate("vision");
    expect(calls).toBe(1);
  });

  it("forgets a thread on reset so the next view reloads it", () => {
    const s = useChats.getState();
    s.pushUser("friday", "hi");
    s.reset("friday");
    expect(selectThread("friday")(useChats.getState()).messages).toEqual([]);
  });
});
