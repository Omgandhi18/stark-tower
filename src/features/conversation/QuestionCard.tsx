import { MessageCircleQuestion } from "lucide-react";
import { Button, Markdown, ICON_SIZE, ICON_STROKE } from "../../design";
import { formatRelative } from "../../lib/time";
import type { ReviewRequest } from "../../lib/types";
import { useNow } from "../../lib/useNow";

const CLOCK_MS = 30_000;

interface QuestionCardProps {
  question: ReviewRequest;
  agentName: string;
  /** Answer with one of the agent's suggested replies. */
  onChoose: (choice: string) => void;
  busy: boolean;
}

/** A question the agent is blocked on, pinned above the composer until answered. */
export default function QuestionCard({ question, agentName, onChoose, busy }: QuestionCardProps) {
  const now = useNow(CLOCK_MS);
  const showTitle = question.title && question.title !== question.body;
  return (
    <section className="question-card tone-review" aria-label={`Question from ${agentName}`}>
      <header className="question-head">
        <MessageCircleQuestion aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
        <span className="question-label">{agentName} is waiting for your answer</span>
        <time dateTime={new Date(question.created).toISOString()}>{formatRelative(question.created, now)}</time>
      </header>
      {showTitle && <p className="question-title">{question.title}</p>}
      {question.body && <Markdown text={question.body} className="question-body" />}
      {question.choices.length > 0 && (
        <div className="question-choices">
          {question.choices.map((choice) => (
            <Button key={choice} size="sm" variant="secondary" disabled={busy} onClick={() => onChoose(choice)}>
              {choice}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}
