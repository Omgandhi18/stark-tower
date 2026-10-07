import { useState } from "react";
import { CheckCheck } from "lucide-react";
import { Button, Popover } from "../../design";
import { reviewDelegated, reviewTask } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { Task } from "../../lib/types";
import { useAgents } from "../../stores/agents";
import { finishedLabel } from "./reviewModel";

interface ReviewButtonProps {
  task: Task;
  /** Delegated work that has finished, which can be marked reviewed with it. */
  finished: Task[];
  /** Delegated work still going or stuck, which stays as it is. */
  unfinished: number;
  onError: (message: string | null) => void;
}

/** Mark a task reviewed; when work it delegated has finished, ask whether that goes with it. */
export default function ReviewButton({ task, finished, unfinished, onError }: ReviewButtonProps) {
  const agents = useAgents((s) => s.agents);
  const [withDelegated, setWithDelegated] = useState(true);

  const markReviewed = async (alsoDelegated: boolean) => {
    onError(null);
    try {
      await reviewTask(task.id);
    } catch (e) {
      onError(errorMessage(e, "The task couldn't be marked reviewed."));
      return;
    }
    if (alsoDelegated) await reviewDelegated(task.id).catch((e) => onError(errorMessage(e, "The task was marked reviewed, but its delegated work couldn't be.")));
  };

  if (!finished.length) {
    return (
      <Button variant="review" icon={CheckCheck} onClick={() => void markReviewed(false)}>
        Mark as reviewed
      </Button>
    );
  }
  return (
    <Popover
      label="Mark as reviewed"
      align="end"
      className="review-popover"
      trigger={(p) => (
        <Button {...p} variant="review" icon={CheckCheck} aria-haspopup="dialog">
          Mark as reviewed
        </Button>
      )}
    >
      {(close) => (
        <div className="review-confirm">
          <label className="review-confirm-option">
            <input type="checkbox" checked={withDelegated} onChange={(e) => setWithDelegated(e.target.checked)} data-autofocus />
            Also mark its {finishedLabel(finished.length)} reviewed
          </label>
          <ul className="review-confirm-list" aria-label="Finished delegated tasks">
            {finished.map((t) => (
              <li key={t.id} title={t.title}>
                <strong>{agents.find((a) => a.id === t.assignee)?.name ?? t.assignee}</strong> · {t.title}
              </li>
            ))}
          </ul>
          {unfinished > 0 && <p className="review-confirm-note">{unfinished} still running or blocked {unfinished === 1 ? "stays" : "stay"} as {unfinished === 1 ? "it is" : "they are"}.</p>}
          <div className="review-confirm-actions">
            <Button
              variant="review"
              icon={CheckCheck}
              onClick={() => {
                close();
                void markReviewed(withDelegated);
              }}
            >
              Mark as reviewed
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}
