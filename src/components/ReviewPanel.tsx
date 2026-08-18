import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import type { Agent, ReviewRequest } from "../lib/types";
import Avatar from "./Avatar";

interface Props {
  review: ReviewRequest;
  agent?: Agent;
  pending: number;
  onDecide: (id: string, decision: string) => void;
}

export default function ReviewPanel({ review, agent, pending, onDecide }: Props) {
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const accent = agent?.accent ?? "#59cfff";
  const name = agent?.name ?? review.agentId.toUpperCase();

  const isQuestions = review.kind === "questions" && review.choices.length === 0;
  const choices = review.choices.length
    ? review.choices
    : ["Approve", "Request changes"];

  const decideChoice = (choice: string) => {
    const d = note.trim() ? `${choice} — ${note.trim()}` : choice;
    onDecide(review.id, d);
  };
  const sendAnswer = () => {
    const a = answer.trim();
    if (a) onDecide(review.id, a);
  };

  return (
    <div className="review-dock" style={{ borderLeftColor: accent }}>
      <div className="review-head">
        {agent && <Avatar agent={agent} size={28} />}
        <div className="review-who">
          <span className="review-who-name" style={{ color: accent }}>
            {name}
          </span>
          <span className="review-who-sub">needs your decision</span>
        </div>
        <span className="review-title">{review.title}</span>
        {pending > 1 && <span className="review-more">+{pending - 1} queued</span>}
      </div>

      {review.kind === "mockup" ? (
        <div className="review-body review-body--mockup">
          <iframe
            className="review-mockup"
            srcDoc={review.body}
            sandbox="allow-scripts"
            title={review.title}
          />
        </div>
      ) : (
        <div className="review-body md">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          >
            {review.body}
          </ReactMarkdown>
        </div>
      )}

      {isQuestions ? (
        <div className="review-actions">
          <textarea
            className="review-answer"
            placeholder="Type your answer…"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                sendAnswer();
              }
            }}
            rows={2}
          />
          <button
            className="review-btn primary"
            style={{ borderColor: accent, color: accent }}
            onClick={sendAnswer}
          >
            Send
          </button>
        </div>
      ) : (
        <div className="review-actions">
          <input
            className="review-note"
            placeholder="Add a note (optional)…"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="review-choices">
            {choices.map((c, i) => (
              <button
                key={c}
                className={`review-btn ${i === 0 ? "primary" : ""}`}
                style={i === 0 ? { borderColor: accent, color: accent } : undefined}
                onClick={() => decideChoice(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
