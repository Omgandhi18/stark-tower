// Everything that needs the developer: approvals, questions and other reviews
// agents are blocked on. Mirrors the backend's pending list.
import { create } from "zustand";
import { pendingReviews, reviewRespond } from "../lib/api";
import type { ReviewRequest } from "../lib/types";

interface AttentionState {
  pending: ReviewRequest[];
  /** Merge a newly announced review (idempotent by id). */
  add: (review: ReviewRequest) => void;
  remove: (id: string) => void;
  /** Re-read the backend's pending list (startup, reconnect). */
  refresh: () => Promise<void>;
  /** Answer a review; the agent resumes with this decision or text. */
  respond: (id: string, decision: string) => Promise<void>;
}

const byCreated = (a: ReviewRequest, b: ReviewRequest) => a.created - b.created;

export const useAttention = create<AttentionState>((set) => ({
  pending: [],
  add: (review) =>
    set((state) =>
      state.pending.some((r) => r.id === review.id) ? state : { pending: [...state.pending, review].sort(byCreated) },
    ),
  remove: (id) => set((state) => ({ pending: state.pending.filter((r) => r.id !== id) })),
  refresh: async () => {
    const list = await pendingReviews();
    set({ pending: [...list].sort(byCreated) });
  },
  respond: async (id, decision) => {
    await reviewRespond(id, decision);
    set((state) => ({ pending: state.pending.filter((r) => r.id !== id) }));
  },
}));

/** Questions an agent asked in conversation (answered from its chat). */
export const isQuestion = (r: ReviewRequest) => r.kind === "questions";

/** Whether a review came from this chat (or, for one that didn't say, from this agent at all). */
export const fromChat = (r: ReviewRequest, agentId: string, conversationId: number | null) =>
  r.agentId === agentId && (conversationId === null || r.conversationId === null || r.conversationId === conversationId);

/** The question an agent is waiting on in this chat (any of its chats, when the chat isn't known). */
export const selectQuestionFor = (agentId: string, conversationId: number | null = null) => (state: AttentionState) =>
  state.pending.find((r) => isQuestion(r) && fromChat(r, agentId, conversationId));
