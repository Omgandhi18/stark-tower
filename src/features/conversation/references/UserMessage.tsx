import { MousePointerClick, Quote } from "lucide-react";
import { ICON_SIZE, ICON_STROKE } from "../../../design";
import type { Attachment } from "../../../lib/types";
import { AttachmentGallery } from "../../attachments/AttachmentView";
import type { PointSummary } from "../../preview/pointModel";
import { hasReferences, parseMessage, type MessagePart } from "./referenceModel";
import "./references.css";

/** A quoted excerpt, as it sits above the reply to it. */
function QuoteBlock({ text }: { text: string }) {
  return (
    <blockquote className="msg-quote selectable">
      <Quote aria-hidden className="msg-quote-icon" size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
      <p>{text}</p>
    </blockquote>
  );
}

/** A point in the browser or simulator: one line to read, and the rest a click away. */
function PointCard({ point }: { point: PointSummary }) {
  return (
    <div className="msg-point">
      <div className="msg-point-head">
        <MousePointerClick aria-hidden className="msg-point-icon" size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
        <span className="msg-point-title selectable">{point.title}</span>
        <span className="msg-point-meta">{[point.place, point.size].filter(Boolean).join(" · ")}</span>
      </div>
      <details className="msg-point-details">
        <summary>Details</summary>
        <dl className="msg-point-facts selectable">
          {point.facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {point.html && (
          <details className="msg-point-html">
            <summary>Element HTML</summary>
            <pre className="selectable">
              <code>{point.html}</code>
            </pre>
          </details>
        )}
      </details>
    </div>
  );
}

function Part({ part }: { part: MessagePart }) {
  switch (part.type) {
    case "quote":
      return <QuoteBlock text={part.text} />;
    case "point":
      return <PointCard point={part.point} />;
    default:
      return <p className="msg-bubble selectable">{part.text}</p>;
  }
}

/** A message you sent: your words in a bubble, with any quotes and points it carries shown as cards, not raw text. */
export default function UserMessage({ text, attachments }: { text?: string; attachments?: Attachment[] }) {
  const parts = text ? parseMessage(text) : [];
  // A plain message keeps its plain bubble, word for word.
  const plain = !hasReferences(parts);
  return (
    <div className="msg msg-user">
      {text && plain && <p className="msg-bubble selectable">{text}</p>}
      {!plain && parts.map((part, i) => <Part key={i} part={part} />)}
      {attachments && <AttachmentGallery files={attachments} compact />}
    </div>
  );
}
