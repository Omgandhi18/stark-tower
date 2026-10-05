import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Button, Dialog, InlineCode, cx } from "../../design";
import type { ReviewRequest } from "../../lib/types";
import { folderName } from "../../stores/workspace";

export type GrantScope = "project" | "everywhere";

interface GrantDialogProps {
  open: boolean;
  review: ReviewRequest;
  agentName: string;
  onCancel: () => void;
  onConfirm: (scope: GrantScope) => void;
}

/**
 * Confirms an "always allow" rule: shows exactly what it allows and asks where.
 * Actions that normally never run on their own need an explicit acknowledgement.
 */
export default function GrantDialog({ open, review, agentName, onCancel, onConfirm }: GrantDialogProps) {
  const [scope, setScope] = useState<GrantScope>("project");
  const [understood, setUnderstood] = useState(false);
  const high = review.tier === "never";
  const project = review.project ? folderName(review.project) : "this project";
  const where = scope === "project" ? `in ${project}` : "in every project";

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      size="md"
      tone={high ? "danger" : "attention"}
      icon={high ? ShieldAlert : ShieldCheck}
      title={<InlineCode text={`Always allow ${review.grant ?? "this"}?`} />}
      description={`${agentName} and every other agent will be able to do this without asking you. You can take it back in Settings.`}
      actions={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={high ? "danger" : "attention"} disabled={high && !understood} onClick={() => onConfirm(scope)}>
            Always allow
          </Button>
        </>
      }
    >
      <div className="grant">
        <div className="grant-rule">
          <span className="grant-rule-label">The rule</span>
          <span className="grant-rule-text">
            <InlineCode text={`Allow ${review.grant} ${where}`} />
          </span>
          {review.rule && <span className="grant-rule-source">Instead of the default: {review.rule}</span>}
        </div>
        <fieldset className="grant-scope">
          <legend className="visually-hidden">Where it applies</legend>
          {(["project", "everywhere"] as const).map((option) => (
            <label key={option} className={cx("grant-option", scope === option && "is-selected")}>
              <input type="radio" name="grant-scope" value={option} checked={scope === option} onChange={() => setScope(option)} />
              <span>
                <span className="grant-option-title">{option === "project" ? `Only in ${project}` : "In every project"}</span>
                <span className="grant-option-detail">
                  {option === "project" ? "Other projects keep asking." : "Every project, including ones you add later."}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {high && (
          <label className="grant-ack">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
            <span>
              I understand this normally never happens without me, and agents will do it on their own {where}.
            </span>
          </label>
        )}
      </div>
    </Dialog>
  );
}
