// Every open chat's messages. An agent can talk in several chats at once, so a thread is kept
// per chat: `c:<id>` for one conversation (a task's page), or the agent's id for whichever chat
// it's open in (the Environment's side panel). One store, so drafts survive switching screens.
import { create } from "zustand";
import { activeConversation, conversationChat, getChat } from "../lib/api";
import type { AgentStatus, Attachment, ChatEvent, StoredMessage, ToolResult } from "../lib/types";

/** "artifact": files an agent made or shared (`detail` says which). */
export type MessageRole = "user" | "agent" | "tool" | "thinking" | "error" | "system" | "artifact";

export interface ChatMessage {
  /** Local key, unique for the app session. */
  id: number;
  role: MessageRole;
  text?: string;
  tool?: string;
  detail?: string;
  /** Files with the message: attached by the developer, or made or shared by the agent. */
  attachments?: Attachment[];
  /** A tool call's full input, as JSON. */
  input?: string;
  /** What a tool call put out, once it came back (its images are `attachments`). Absent while it runs, and on calls saved before outputs were kept. */
  result?: ToolResult;
  /** Output streamed while a tool call runs; replaced by `result` when it ends. */
  liveOutput?: string;
  /** The transcript row, once known; how a live message and its saved copy are matched. */
  storedId?: number;
}

/** Where a chat's thread is kept: `c:<id>` for one conversation, or an agent's id for the chat it's open in. */
export type ChatKey = string;

export const chatKey = (conversationId: number): ChatKey => `c:${conversationId}`;

/** A chat a view talks in: whose it is, and where its thread is kept. */
export interface ChatRef {
  agentId: string;
  key: ChatKey;
}

/** The conversation a key names, if it names one. */
export const conversationOfKey = (key: ChatKey): number | null => (key.startsWith("c:") ? Number(key.slice(2)) : null);

/** Something attached to the message being written, shown as a chip above the input: a quoted excerpt, or a point in the preview. */
export type ComposerReference =
  | { id: number; kind: "quote"; text: string }
  /** `text` is the point exactly as the agent receives it; `image` is the marked screenshot that goes with it. */
  | { id: number; kind: "point"; text: string; image?: Attachment };

export type NewReference = { kind: "quote"; text: string } | { kind: "point"; text: string; image?: Attachment };

export interface ChatThread {
  /** Whose chat it is ("" until known). */
  agentId: string;
  messages: ChatMessage[];
  /** Waiting for the agent's reply. */
  pending: boolean;
  /** Loading of the saved transcript has started (it happens once per thread). */
  hydrated: boolean;
  /** The saved transcript is still loading. */
  loading: boolean;
  /** The saved chat this thread is (null until known, or for a chat never sent). */
  conversationId: number | null;
  draft: string;
  /** Files attached to the message being written (kept copies). */
  files: Attachment[];
  /** Quotes and points attached to the message being written. */
  references: ComposerReference[];
  /** The folder this chat runs in ("" until known). */
  folder: string;
}

interface ChatsState {
  threads: Record<ChatKey, ChatThread>;
  /** Load the chat's saved transcript and folder once. */
  hydrate: (key: ChatKey, agentId: string) => Promise<void>;
  /** Apply a live event from one of an agent's sessions to every thread showing that chat. */
  apply: (event: ChatEvent) => void;
  /** A chat's session started or finished working. */
  applyStatus: (conversationId: number, status: AgentStatus) => void;
  /** Add a message the app produced locally (what you sent, a question you answered, an error). Returns its key. */
  push: (key: ChatKey, message: Omit<ChatMessage, "id">) => number;
  /** Returns the message's key, to confirm once the backend has stored it. */
  pushUser: (key: ChatKey, text: string, attachments?: Attachment[]) => number;
  /** A local message was stored as `storedId`; drop it if the saved copy is already shown. */
  confirmStored: (key: ChatKey, messageId: number, storedId: number) => void;
  pushError: (key: ChatKey, text: string) => void;
  setPending: (key: ChatKey, pending: boolean) => void;
  setDraft: (key: ChatKey, draft: string) => void;
  /** Change the files attached to the message being written. */
  updateFiles: (key: ChatKey, update: (current: readonly Attachment[]) => Attachment[]) => void;
  /** Attach a quote or point to the message being written (the same quote twice is kept once). */
  addReference: (key: ChatKey, reference: NewReference) => void;
  removeReference: (key: ChatKey, id: number) => void;
  clearReferences: (key: ChatKey) => void;
  setFolder: (key: ChatKey, folder: string) => void;
  /** Forget the thread (a new or reopened conversation); it re-hydrates on next view. */
  reset: (key: ChatKey) => void;
  /** The agent is now open in `conversationId`: its open-chat thread showing another conversation starts over. */
  switchTo: (agentId: string, conversationId: number) => void;
}

const EMPTY: ChatThread = {
  agentId: "",
  messages: [],
  pending: false,
  hydrated: false,
  loading: false,
  conversationId: null,
  draft: "",
  files: [],
  references: [],
  folder: "",
};

let nextId = 0;
const id = () => ++nextId;

/** A chat waits for the agent's reply in these states; waiting on you ("blocked") is your turn. */
const BUSY: readonly AgentStatus[] = ["thinking", "working"];

/** How a live event becomes a message (null: it only changes state). */
export function messageFor(event: ChatEvent): Omit<ChatMessage, "id"> | null {
  const storedId = event.messageId;
  switch (event.kind) {
    case "text":
      return { role: "agent", text: event.text, storedId };
    case "tool":
      return { role: "tool", tool: event.tool, detail: event.detail, input: event.input, storedId };
    case "thinking":
      return { role: "thinking", text: event.text, storedId };
    case "error":
      return { role: "error", text: event.text };
    case "init":
      return { role: "system", text: `Session started in ${event.cwd ?? "the project folder"}` };
    case "exit":
      return { role: "system", text: "Session ended" };
    case "system":
      return event.text ? { role: "system", text: event.text } : null;
    case "artifact":
      return event.attachments?.length ? { role: "artifact", text: event.text, detail: event.detail, attachments: event.attachments, storedId } : null;
    default:
      return null;
  }
}

/**
 * The saved transcript followed by whatever arrived live while it loaded,
 * minus live messages the transcript already contains.
 */
export function mergeTranscript(
  restored: readonly ChatMessage[],
  live: readonly LiveMessage[],
  conversationId: number | null,
): ChatMessage[] {
  const saved = new Set(restored.map((m) => m.storedId));
  return [
    ...restored,
    ...live
      .filter((m) => m.storedId === undefined || !saved.has(m.storedId))
      .filter((m) => m.conversationId === undefined || conversationId === null || m.conversationId === conversationId)
      .map(({ conversationId: _conversation, ...message }) => message),
  ];
}

/** A message as it arrives live, tagged with the conversation it belongs to. */
export type LiveMessage = ChatMessage & { conversationId?: number };

/** Whether a live event belongs in a thread showing `conversationId` (unknown either way: keep it). */
export const belongsTo = (event: ChatEvent, thread: ChatThread) =>
  event.conversationId === undefined || thread.conversationId === null || event.conversationId === thread.conversationId;

const holds = (thread: ChatThread, storedId: number | undefined) =>
  storedId !== undefined && thread.messages.some((m) => m.storedId === storedId);

const restore = (rows: readonly StoredMessage[]): ChatMessage[] =>
  rows.map((r) => ({
    id: id(),
    role: r.role as MessageRole,
    text: r.text ?? undefined,
    tool: r.tool ?? undefined,
    detail: r.detail ?? undefined,
    attachments: r.attachments?.length ? r.attachments : undefined,
    input: r.input ?? undefined,
    result: r.result ?? undefined,
    storedId: r.id,
  }));

/** The most output kept on screen for a call still running. */
const LIVE_OUTPUT_LIMIT = 64 * 1024;

/** A tool call's row after a live event about it: its result arrived, or more of its output did. */
export function withToolEvent(message: ChatMessage, event: ChatEvent): ChatMessage {
  if (event.kind === "tool_result") {
    const { liveOutput: _streamed, ...rest } = message;
    return { ...rest, result: event.result, ...(event.attachments?.length ? { attachments: event.attachments } : {}) };
  }
  return { ...message, liveOutput: ((message.liveOutput ?? "") + (event.text ?? "")).slice(-LIVE_OUTPUT_LIMIT) };
}

/** A chat's transcript, folder and state from the backend: one conversation, or the one the agent is open in. */
async function load(key: ChatKey, agentId: string) {
  const conversation = conversationOfKey(key);
  if (conversation !== null) {
    const chat = await conversationChat(conversation);
    if (!chat) throw new Error("That chat isn't here any more.");
    return { rows: chat.messages, id: chat.conversation.id, cwd: chat.conversation.cwd, busy: chat.status !== null && BUSY.includes(chat.status) };
  }
  const [rows, open] = await Promise.all([getChat(agentId), activeConversation(agentId)]);
  return { rows, id: open?.id ?? null, cwd: open?.cwd ?? "", busy: null };
}

export const useChats = create<ChatsState>((set, get) => {
  const update = (key: ChatKey, change: (t: ChatThread) => Partial<ChatThread>) =>
    set((s) => {
      const thread = s.threads[key] ?? EMPTY;
      return { threads: { ...s.threads, [key]: { ...thread, ...change(thread) } } };
    });

  return {
    threads: {},
    hydrate: async (key, agentId) => {
      if (get().threads[key]?.hydrated) return;
      update(key, () => ({ agentId, hydrated: true, loading: true }));
      let loaded: Awaited<ReturnType<typeof load>>;
      try {
        loaded = await load(key, agentId);
      } catch (error) {
        update(key, () => ({ loading: false }));
        throw error;
      }
      // Live events that landed while loading must not be lost, or shown twice.
      update(key, (t) => ({
        messages: mergeTranscript(restore(loaded.rows), t.messages, loaded.id),
        folder: t.folder || loaded.cwd || "",
        conversationId: loaded.id,
        pending: loaded.busy ?? t.pending,
        loading: false,
      }));
    },
    apply: (event) => {
      if (event.kind === "tool_result" || event.kind === "tool_output") {
        // Fills in the row of the call it's about, in every thread showing it.
        if (event.messageId === undefined) return;
        for (const [key, thread] of Object.entries(get().threads)) {
          if (!thread.messages.some((m) => m.storedId === event.messageId)) continue;
          if (thread.agentId !== event.agentId || !belongsTo(event, thread)) continue;
          update(key, (t) => ({ messages: t.messages.map((m) => (m.storedId === event.messageId ? withToolEvent(m, event) : m)) }));
        }
        return;
      }
      const message = messageFor(event);
      const settles = event.kind === "text" || event.kind === "error" || event.kind === "result" || event.kind === "exit";
      if (!message && !settles) return;
      const own = (key: ChatKey, thread: ChatThread) => {
        // The agent's open-chat thread collects its events until it knows which chat it shows.
        if (key === event.agentId) return !thread.hydrated || thread.loading || belongsTo(event, thread);
        return thread.agentId === event.agentId && thread.conversationId !== null && thread.conversationId === event.conversationId;
      };
      const keys = Object.keys(get().threads).filter((key) => own(key, get().threads[key]));
      if (!keys.includes(event.agentId) && !get().threads[event.agentId]) keys.push(event.agentId);
      for (const key of keys) {
        update(key, (t) => ({
          agentId: event.agentId,
          messages:
            message && !holds(t, message.storedId)
              ? [...t.messages, { id: id(), ...message, ...(t.loading || !t.hydrated ? { conversationId: event.conversationId } : {}) }]
              : t.messages,
          pending: settles ? false : t.pending,
        }));
      }
    },
    applyStatus: (conversationId, status) => {
      const busy = BUSY.includes(status);
      for (const [key, thread] of Object.entries(get().threads)) {
        if (thread.conversationId === conversationId && thread.pending !== busy) update(key, () => ({ pending: busy }));
      }
    },
    push: (key, message) => {
      const messageId = id();
      update(key, (t) => ({ messages: [...t.messages, { id: messageId, ...message }] }));
      return messageId;
    },
    pushUser: (key, text, attachments) => get().push(key, { role: "user", text, ...(attachments?.length ? { attachments } : {}) }),
    confirmStored: (key, messageId, storedId) =>
      update(key, (t) => ({
        messages: holds(t, storedId)
          ? t.messages.filter((m) => m.id !== messageId)
          : t.messages.map((m) => (m.id === messageId ? { ...m, storedId } : m)),
      })),
    pushError: (key, text) => {
      get().push(key, { role: "error", text });
      get().setPending(key, false);
    },
    setPending: (key, pending) => update(key, () => ({ pending })),
    setDraft: (key, draft) => update(key, () => ({ draft })),
    updateFiles: (key, change) => update(key, (t) => ({ files: change(t.files) })),
    addReference: (key, reference) =>
      update(key, (t) =>
        reference.kind === "quote" && t.references.some((r) => r.kind === "quote" && r.text === reference.text)
          ? {}
          : { references: [...t.references, { id: id(), ...reference }] },
      ),
    removeReference: (key, referenceId) => update(key, (t) => ({ references: t.references.filter((r) => r.id !== referenceId) })),
    clearReferences: (key) => update(key, () => ({ references: [] })),
    setFolder: (key, folder) => update(key, () => ({ folder })),
    reset: (key) =>
      set((s) => {
        const threads = { ...s.threads };
        delete threads[key];
        return { threads };
      }),
    switchTo: (agentId, conversationId) => {
      const thread = get().threads[agentId];
      if (thread && thread.conversationId !== conversationId) get().reset(agentId);
    },
  };
});

export const selectThread = (key: ChatKey) => (s: ChatsState) => s.threads[key] ?? EMPTY;
