import { useState } from "react";
import { cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import type { ReviewRequest } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { isQuestion, useAttention } from "../../stores/attention";
import type { ChatRef } from "../../stores/chats";
import { presentReview } from "../attention/presentation";
import DecisionBar from "../notifications/DecisionBar";
import ReviewBody from "../notifications/ReviewBody";
import { answerQuestion } from "./chatActions";

const CLOCK_MS = 30_000;

interface ChatRequestCardProps {
  review: ReviewRequest;
  chat: ChatRef;
  agentName: string;
}

/**
 * Something the agent is waiting on in this chat, in full where you're talking to it: a decision
 * with its options and a note, an approval, a plan or a question. It's in Notifications too, and
 * deciding in either place settles both.
 */
export default function ChatRequestCard({ review, chat, agentName }: ChatRequestCardProps) {
  const respond = useAttention((s) => s.respond);
  const now = useNow(CLOCK_MS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = presentReview(review);
  const Icon = p.icon;
  const showTitle = review.title && review.title !== review.body;

  const decide = async (decision: string) => {
    setBusy(true);
    setError(null);
    // A question and its answer stay in the thread, so the chat reads as it happened.
    if (isQuestion(review)) {
      await answerQuestion(chat, review, decision);
      return;
    }
    try {
      await respond(review.id, decision);
    } catch (e) {
      setError(errorMessage(e, "Your decision didn't reach the agent."));
      setBusy(false);
    }
  };

  return (
    <section className={cx("chat-request", `tone-${p.tone}`)} aria-label={`${p.label} from ${agentName}`}>
      <header className="chat-request-head">
        <span className="chat-request-kind">
          <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          {p.label}
        </span>
        <span className="chat-request-who">
          {agentName} {p.verb}
        </span>
        <time dateTime={new Date(review.created).toISOString()}>{formatRelative(review.created, now)}</time>
      </header>
      {showTitle && (
        <h3 className="chat-request-title">
          {review.title}
        </h3>
      )}
      <div className="chat-request-body">
        <ReviewBody review={review} />
      </div>
      {error && (
        <p className="chat-request-error" role="alert">
          {error}
        </p>
      )}
      <DecisionBar review={review} agentName={agentName} busy={busy} onDecide={(decision) => void decide(decision)} />
    </section>
  );
}
