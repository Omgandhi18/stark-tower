import { useState } from "react";
import { FolderOpen } from "lucide-react";
import { Button, InlineCode, Portrait, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatRelative } from "../../lib/time";
import { isPermissionRequest, type ReviewRequest } from "../../lib/types";
import { useAgents, selectAgent } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import { folderName } from "../../stores/workspace";
import { excerpt, presentReview } from "./presentation";

interface AttentionCardProps {
  review: ReviewRequest;
  now: number;
}

/**
 * One thing an agent is waiting on, compact enough for a side rail. Quick
 * decisions (a command) are made in place; anything that needs reading first
 * opens in the Notification Centre.
 */
export default function AttentionCard({ review, now }: AttentionCardProps) {
  const agent = useAgents(selectAgent(review.agentId));
  const respond = useAttention((s) => s.respond);
  const focusReview = useNavigation((s) => s.focusReview);
  const openConversation = useNavigation((s) => s.openConversation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const p = presentReview(review);
  const Icon = p.icon;
  const name = agent?.name ?? review.agentId;
  const titleId = `attention-${review.id}`;

  const decide = async (decision: string) => {
    setBusy(true);
    setError(null);
    try {
      await respond(review.id, decision);
    } catch (e) {
      setError(errorMessage(e, "That decision didn't reach the agent."));
      setBusy(false);
    }
  };

  return (
    <article className={cx("attention-card", `tone-${p.tone}`)} aria-labelledby={titleId}>
      <header className="attention-card-head">
        <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="attention-icon" />
        <span className="attention-kind">{p.label}</span>
        <time className="attention-time" dateTime={new Date(review.created).toISOString()}>
          {formatRelative(review.created, now)}
        </time>
      </header>

      <div className="attention-who">
        <Portrait name={name} figure={agent?.figure} accent={agent?.accent} size={24} />
        <span className="attention-agent">{name}</span>
        <span className="attention-verb">{p.verb}</span>
      </div>

      <p id={titleId} className="attention-title">
        {review.title}
      </p>

      {review.command && <code className="attention-command selectable">{review.command}</code>}
      {review.body && (
        <p className="attention-excerpt">{isPermissionRequest(review) ? <InlineCode text={review.body} /> : excerpt(review.body)}</p>
      )}

      {review.cwd && (
        <p className="attention-meta" title={review.cwd}>
          <FolderOpen aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          {folderName(review.project || review.cwd)}
        </p>
      )}

      {error && (
        <p className="attention-error" role="alert">
          {error}
        </p>
      )}

      <div className="attention-actions">
        {isPermissionRequest(review) ? (
          <>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => decide("Deny")}>
              Deny
            </Button>
            <Button variant="attention" size="sm" disabled={busy} onClick={() => decide("Allow")}>
              Allow once
            </Button>
          </>
        ) : review.kind === "questions" ? (
          <Button variant="review" size="sm" onClick={() => openConversation(review.agentId)}>
            Answer
          </Button>
        ) : (
          <Button variant="review" size="sm" onClick={() => focusReview(review.id)}>
            Review
          </Button>
        )}
      </div>
    </article>
  );
}
