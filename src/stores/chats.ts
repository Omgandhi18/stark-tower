// Every open conversation's messages, keyed by agent. One store so the
// conversation screen and the Environment's side panel show the same thread,
// and drafts survive switching screens.
import { create } from "zustand";
import { activeConversation, getChat } from "../lib/api";
import type { Attachment, ChatEvent } from "../lib/types";

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
  /** The transcript row, once known; how a live message and its saved copy are matched. */
  storedId?: number;
}

export interface ChatThread {
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
  /** The folder this chat runs in ("" until known). */
  folder: string;
}

interface ChatsState {
  threads: Record<string, ChatThread>;
  /** Load the agent's saved transcript and folder once. */
  hydrate: (agentId: string) => Promise<void>;
  /** Apply a live event from the agent's session. */
  apply: (event: ChatEvent) => void;
  /** Add a message the app produced locally (what you sent, a question you answered, an error). Returns its key. */
  push: (agentId: string, message: Omit<ChatMessage, "id">) => number;
  /** Returns the message's key, to confirm once the backend has stored it. */
  pushUser: (agentId: string, text: string, attachments?: Attachment[]) => number;
  /** A local message was stored as `storedId`; drop it if the saved copy is already shown. */
  confirmStored: (agentId: string, messageId: number, storedId: number) => void;
  pushError: (agentId: string, text: string) => void;
  setPending: (agentId: string, pending: boolean) => void;
  setDraft: (agentId: string, draft: string) => void;
  /** Change the files attached to the message being written. */
  updateFiles: (agentId: string, update: (current: readonly Attachment[]) => Attachment[]) => void;
  setFolder: (agentId: string, folder: string) => void;
  /** Forget the thread (a new or reopened conversation); it re-hydrates on next view. */
  reset: (agentId: string) => void;
  /** The agent now talks in `conversationId`: a thread showing another conversation starts over. */
  switchTo: (agentId: string, conversationId: number) => void;
}

const EMPTY: ChatThread = {
  messages: [],
  pending: false,
  hydrated: false,
  loading: false,
  conversationId: null,
  draft: "",
  files: [],
  folder: "",
};

let nextId = 0;
const id = () => ++nextId;

/** How a live event becomes a message (null: it only changes state). */
export function messageFor(event: ChatEvent): Omit<ChatMessage, "id"> | null {
  const storedId = event.messageId;
  switch (event.kind) {
    case "text":
      return { role: "agent", text: event.text, storedId };
    case "tool":
      return { role: "tool", tool: event.tool, detail: event.detail, storedId };
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

export const useChats = create<ChatsState>((set, get) => {
  const update = (agentId: string, change: (t: ChatThread) => Partial<ChatThread>) =>
    set((s) => {
      const thread = s.threads[agentId] ?? EMPTY;
      return { threads: { ...s.threads, [agentId]: { ...thread, ...change(thread) } } };
    });

  return {
    threads: {},
    hydrate: async (agentId) => {
      if (get().threads[agentId]?.hydrated) return;
      update(agentId, () => ({ hydrated: true, loading: true }));
      let rows: Awaited<ReturnType<typeof getChat>>;
      let conversation: Awaited<ReturnType<typeof activeConversation>>;
      try {
        [rows, conversation] = await Promise.all([getChat(agentId), activeConversation(agentId)]);
      } catch (error) {
        update(agentId, () => ({ loading: false }));
        throw error;
      }
      const restored: ChatMessage[] = rows.map((r) => ({
        id: id(),
        role: r.role as MessageRole,
        text: r.text ?? undefined,
        tool: r.tool ?? undefined,
        detail: r.detail ?? undefined,
        attachments: r.attachments?.length ? r.attachments : undefined,
        storedId: r.id,
      }));
      // Live events that landed while loading must not be lost, or shown twice.
      update(agentId, (t) => ({
        messages: mergeTranscript(restored, t.messages, conversation?.id ?? null),
        folder: t.folder || conversation?.cwd || "",
        conversationId: conversation?.id ?? null,
        loading: false,
      }));
    },
    apply: (event) => {
      const message = messageFor(event);
      const settles = event.kind === "text" || event.kind === "error" || event.kind === "result" || event.kind === "exit";
      if (!message && !settles) return;
      const thread = get().threads[event.agentId] ?? EMPTY;
      // Output from another conversation (a delegated task's own thread) isn't this chat's.
      if (thread.hydrated && !thread.loading && !belongsTo(event, thread)) return;
      update(event.agentId, (t) => ({
        messages:
          message && !holds(t, message.storedId)
            ? [...t.messages, { id: id(), ...message, ...(t.loading || !t.hydrated ? { conversationId: event.conversationId } : {}) }]
            : t.messages,
        pending: settles ? false : t.pending,
      }));
    },
    push: (agentId, message) => {
      const key = id();
      update(agentId, (t) => ({ messages: [...t.messages, { id: key, ...message }] }));
      return key;
    },
    pushUser: (agentId, text, attachments) => get().push(agentId, { role: "user", text, ...(attachments?.length ? { attachments } : {}) }),
    confirmStored: (agentId, messageId, storedId) =>
      update(agentId, (t) => ({
        messages: holds(t, storedId)
          ? t.messages.filter((m) => m.id !== messageId)
          : t.messages.map((m) => (m.id === messageId ? { ...m, storedId } : m)),
      })),
    pushError: (agentId, text) => {
      get().push(agentId, { role: "error", text });
      get().setPending(agentId, false);
    },
    setPending: (agentId, pending) => update(agentId, () => ({ pending })),
    setDraft: (agentId, draft) => update(agentId, () => ({ draft })),
    updateFiles: (agentId, change) => update(agentId, (t) => ({ files: change(t.files) })),
    setFolder: (agentId, folder) => update(agentId, () => ({ folder })),
    reset: (agentId) =>
      set((s) => {
        const threads = { ...s.threads };
        delete threads[agentId];
        return { threads };
      }),
    switchTo: (agentId, conversationId) => {
      const thread = get().threads[agentId];
      if (thread && thread.conversationId !== conversationId) get().reset(agentId);
    },
  };
});

export const selectThread = (agentId: string) => (s: ChatsState) => s.threads[agentId] ?? EMPTY;
