import { FolderOpen, Scale } from "lucide-react";
import { InlineCode, Markdown, ICON_SIZE, ICON_STROKE } from "../../design";
import { isPermissionRequest, type ReviewRequest } from "../../lib/types";
import { tierNote } from "../attention/presentation";

/**
 * What a request is about, in full: a command (with its folder, the reason and the rule that
 * stopped it), a mockup to look at, or everything the agent wrote. In Notifications and in the chat.
 */
export default function ReviewBody({ review }: { review: ReviewRequest }) {
  if (isPermissionRequest(review)) {
    return (
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
    );
  }
  if (review.kind === "mockup") return <iframe className="review-mockup" srcDoc={review.body} sandbox="allow-scripts" title={review.title} />;
  return review.body ? <Markdown text={review.body} /> : null;
}
