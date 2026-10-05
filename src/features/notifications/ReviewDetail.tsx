import { useState } from "react";
import { FolderOpen, Scale } from "lucide-react";
import { InlineCode, Markdown, Portrait, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import { isPermissionRequest, type Agent, type ReviewRequest } from "../../lib/types";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import { presentReview, tierNote } from "../attention/presentation";
import DecisionBar from "./DecisionBar";

interface ReviewDetailProps {
  review: ReviewRequest;
  agent: Agent | undefined;
  now: number;
}

/** One request in full: what the agent wants, everything it sent, and your decision. */
export default function ReviewDetail({ review, agent, now }: ReviewDetailProps) {
  const respond = useAttention((s) => s.respond);
  const openConversation = useNavigation((s) => s.openConversation);
  const openTask = useNavigation((s) => s.openTask);
  const taskTitle = useWorkspace((s) => s.tasks.find((t) => t.id === review.taskId)?.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = presentReview(review);
  const Icon = p.icon;
  const name = agent?.name ?? review.agentId;

  const decide = async (decision: string) => {
    setBusy(true);
    setError(null);
    try {
      await respond(review.id, decision);
    } catch (e) {
      setError(errorMessage(e, "Your decision didn't reach the agent."));
      setBusy(false);
    }
  };

  return (
    <article className={cx("review-detail", `tone-${p.tone}`)} aria-labelledby={`review-${review.id}`}>
      <header className="review-detail-head">
        <span className="review-detail-kind">
          <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
          {p.label}
        </span>
        <span className="review-detail-who">
          <Portrait name={name} figure={agent?.figure} accent={agent?.accent} size={24} status={agent?.status} />
          {name} {p.verb}
        </span>
        <time dateTime={new Date(review.created).toISOString()}>{formatRelative(review.created, now)}</time>
      </header>

      <h1 id={`review-${review.id}`} className="review-detail-title">
        {review.title}
      </h1>
      {review.taskId && (
        <p className="review-detail-task">
          For the task{" "}
          <button type="button" className="link-button" onClick={() => openTask(review.taskId as string)}>
            {taskTitle ?? "this belongs to"}
          </button>
        </p>
      )}

      <div className="review-detail-body">
        {isPermissionRequest(review) ? (
          <div className="review-command">
            {review.command && <code className="selectable">{review.command}</code>}
            {review.cwd && (
              <p className="review-command-cwd">
                <FolderOpen aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                <span className="mono selectable">{review.cwd}</span>
              </p>
            )}
            {review.body && (
              <p className="review-reason">
                <InlineCode text={review.body} />
              </p>
            )}
            {review.rule && (
              <p className="review-rule">
                <Scale aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
                <span>
                  Rule: {review.rule}
                  {tierNote(review.tier) && <span className="review-tier"> · {tierNote(review.tier)}</span>}
                </span>
              </p>
            )}
          </div>
        ) : review.kind === "mockup" ? (
          <iframe className="review-mockup" srcDoc={review.body} sandbox="allow-scripts" title={review.title} />
        ) : (
          review.body && <Markdown text={review.body} />
        )}
      </div>

      {error && (
        <p className="review-detail-error" role="alert">
          {error}
        </p>
      )}
      <DecisionBar
        key={review.id}
        review={review}
        agentName={name}
        busy={busy}
        onDecide={decide}
        onOpenConversation={() => openConversation(review.agentId)}
      />
    </article>
  );
}
