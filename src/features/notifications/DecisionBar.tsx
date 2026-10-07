import { useState } from "react";
import { MessageSquareText, SendHorizontal, ShieldCheck, ShieldX } from "lucide-react";
import { Button, InlineCode, TextArea } from "../../design";
import { isPermissionRequest, type ReviewRequest } from "../../lib/types";
import { choicesFor, decisionText } from "../attention/presentation";
import GrantDialog from "./GrantDialog";
import { grantDecision } from "./grantScope";

interface DecisionBarProps {
  review: ReviewRequest;
  agentName: string;
  busy: boolean;
  onDecide: (decision: string) => void;
  /** Go to the chat to answer there; left out in the chat itself, where the message box answers. */
  onOpenConversation?: () => void;
}

/** How you answer: approve or deny a command, pick an option, or write a reply. */
export default function DecisionBar({ review, agentName, busy, onDecide, onOpenConversation }: DecisionBarProps) {
  const [note, setNote] = useState("");
  const [granting, setGranting] = useState(false);

  if (isPermissionRequest(review)) {
    const what = review.kind === "command" ? "this exact command once, in this folder" : "this one action";
    const forTask = Boolean(review.taskId && review.grant);
    return (
      <div className="decision-bar">
        <p className="decision-hint">
          Allowing once permits {what}. Denying tells {agentName} to find another way.
          {review.grant && <InlineCode text={` A rule can allow ${review.grant} from now on.`} />}
        </p>
        <div className="decision-actions">
          <Button icon={ShieldX} disabled={busy} onClick={() => onDecide("Deny")}>
            Deny
          </Button>
          <Button variant={forTask ? "secondary" : "attention"} icon={forTask ? undefined : ShieldCheck} disabled={busy} onClick={() => onDecide("Allow")}>
            Allow once
          </Button>
          {forTask && (
            <Button variant="attention" icon={ShieldCheck} disabled={busy} onClick={() => onDecide("Allow for task")}>
              Allow for this task
            </Button>
          )}
          {review.grant && (
            <Button variant="secondary" disabled={busy} onClick={() => setGranting(true)}>
              Always allow…
            </Button>
          )}
        </div>
        {review.grant && (
          <GrantDialog
            open={granting}
            review={review}
            agentName={agentName}
            onCancel={() => setGranting(false)}
            onConfirm={(scope) => {
              setGranting(false);
              onDecide(grantDecision(scope));
            }}
          />
        )}
      </div>
    );
  }

  const freeAnswer = review.kind === "questions" && review.choices.length === 0;
  // In the chat, the message box below answers it.
  if (freeAnswer && !onOpenConversation) {
    return (
      <div className="decision-bar">
        <p className="decision-hint">Reply below to answer {agentName}.</p>
      </div>
    );
  }
  if (freeAnswer) {
    const send = () => note.trim() && onDecide(note.trim());
    return (
      <div className="decision-bar">
        <TextArea
          label={`Your answer to ${agentName}`}
          value={note}
          placeholder="Type your answer"
          helper="⌘Enter sends"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && e.metaKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="decision-actions">
          <Button variant="ghost" icon={MessageSquareText} onClick={onOpenConversation}>
            Answer in the conversation
          </Button>
          <Button variant="review" icon={SendHorizontal} disabled={busy || !note.trim()} onClick={send}>
            Send answer
          </Button>
        </div>
      </div>
    );
  }

  const choices = choicesFor(review);
  return (
    <div className="decision-bar">
      <TextArea
        label={`Note for ${agentName} (optional)`}
        value={note}
        placeholder="Anything they should know with your decision"
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="decision-actions">
        {choices.map((choice, i) => (
          <Button
            key={choice}
            variant={i === 0 ? "review" : "secondary"}
            disabled={busy}
            onClick={() => onDecide(decisionText(choice, note))}
          >
            {choice}
          </Button>
        ))}
      </div>
    </div>
  );
}
