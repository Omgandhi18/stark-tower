import { beforeEach, describe, expect, it } from "vitest";
import { mockIPC } from "@tauri-apps/api/mocks";
import type { ReviewRequest } from "../../lib/types";
import { useAttention } from "../../stores/attention";
import { chatKey, selectThread, useChats } from "../../stores/chats";
import { answerQuestion, sendMessage, startNewChat, stopChat } from "./chatActions";

const thread = (key: string) => selectThread(key)(useChats.getState());
/** FRIDAY's chat she's open in, and one particular chat of hers. */
const open = { agentId: "friday", key: "friday" };
const chat7 = { agentId: "friday", key: chatKey(7) };

const question: ReviewRequest = {
  id: "q1",
  agentId: "friday",
  title: "Which database?",
  body: "Postgres or SQLite?",
  kind: "questions",
  choices: [],
  command: null,
  cwd: null,
  rule: null,
  tier: null,
  taskId: null,
  conversationId: null,
  grant: null,
  project: null,
  created: 1,
};

describe("chat actions", () => {
  beforeEach(() => {
    useChats.setState({ threads: {} });
    useAttention.setState({ pending: [question] });
  });

  it("sends in the chat's folder and waits for the reply", async () => {
    let sent: unknown;
    mockIPC((cmd, args) => {
      if (cmd === "chat_send") sent = args;
      return null;
    });
    await sendMessage(open, "Fix the build", "/w/app");
    expect(sent).toMatchObject({ agentId: "friday", text: "Fix the build", dir: "/w/app" });
    expect(thread("friday").pending).toBe(true);
    expect(thread("friday").messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("says why a message failed and stops waiting", async () => {
    mockIPC(() => {
      throw new Error("Claude Code isn't installed");
    });
    await sendMessage(open, "hi", "");
    expect(thread("friday").pending).toBe(false);
    const messages = thread("friday").messages;
    expect(messages[messages.length - 1]).toMatchObject({ role: "error", text: "Claude Code isn't installed" });
  });

  it("answers a question and keeps it in the thread", async () => {
    let decision: unknown;
    mockIPC((cmd, args) => {
      if (cmd === "review_respond") decision = args;
      return null;
    });
    await answerQuestion(open, question, "SQLite");
    expect(decision).toMatchObject({ id: "q1", decision: "SQLite" });
    expect(thread("friday").messages.map((m) => m.text)).toEqual(["Postgres or SQLite?", "SQLite"]);
    expect(useAttention.getState().pending).toEqual([]);
  });

  it("stops without clearing the transcript", async () => {
    mockIPC(() => null);
    useChats.getState().pushUser("friday", "long task");
    useChats.getState().setPending("friday", true);
    await stopChat(open);
    expect(thread("friday").pending).toBe(false);
    expect(thread("friday").messages.map((m) => m.role)).toEqual(["user", "system"]);
  });

  it("sends into the chat it was written in, whichever chat the agent is open in", async () => {
    let sent: unknown;
    mockIPC((cmd, args) => {
      if (cmd === "chat_send") sent = args;
      return 41;
    });
    await sendMessage(chat7, "And the other screen", "/w/sfa");
    expect(sent).toMatchObject({ agentId: "friday", conversationId: 7 });
    expect(thread(chatKey(7)).pending).toBe(true);
    expect(thread("friday").messages).toEqual([]);
  });

  it("stops only that chat's session", async () => {
    let stopped: unknown;
    mockIPC((cmd, args) => {
      if (cmd === "chat_stop") stopped = args;
      return null;
    });
    await stopChat(chat7);
    expect(stopped).toMatchObject({ agentId: "friday", conversationId: 7 });
  });

  it("starts a new chat in the same folder", async () => {
    mockIPC((cmd) => {
      if (cmd === "new_chat") return 2;
      if (cmd === "get_chat") return [];
      if (cmd === "active_conversation") return { id: 2, agent_id: "friday", title: "", cwd: "/w/app", created: 1, updated: 1 };
      return null;
    });
    useChats.getState().pushUser("friday", "old");
    useChats.getState().setFolder("friday", "/w/app");
    await startNewChat("friday");
    expect(thread("friday").messages).toEqual([]);
    expect(thread("friday").folder).toBe("/w/app");
    expect(thread("friday").conversationId).toBe(2);
  });
});
