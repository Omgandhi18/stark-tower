import { useState } from "react";
import { FolderOpen, Maximize2, Scale } from "lucide-react";
import { Button, InlineCode, Markdown, ICON_SIZE, ICON_STROKE } from "../../design";
import { isPermissionRequest, type ReviewRequest } from "../../lib/types";
import { tierNote } from "../attention/presentation";
import FullscreenViewer from "../viewer/FullscreenViewer";

/** A mockup the agent made, in place and a click from filling the window. Its scripts run sandboxed. */
function Mockup({ review }: { review: ReviewRequest }) {
  const [viewing, setViewing] = useState(false);
  return (
    <div className="review-mockup-wrap">
      <div className="review-mockup-bar">
        <Button size="sm" variant="ghost" icon={Maximize2} onClick={() => setViewing(true)}>
          Full screen
        </Button>
      </div>
      <iframe className="review-mockup" srcDoc={review.body} sandbox="allow-scripts" title={review.title} />
      {viewing && (
        <FullscreenViewer open title={review.title} subtitle="Mockup" onClose={() => setViewing(false)}>
          <iframe className="viewer-frame" srcDoc={review.body} sandbox="allow-scripts" title={review.title} />
        </FullscreenViewer>
      )}
    </div>
  );
}

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
  if (review.kind === "mockup") return <Mockup review={review} />;
  return review.body ? <Markdown text={review.body} /> : null;
}
