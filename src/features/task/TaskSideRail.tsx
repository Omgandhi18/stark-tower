import { useState } from "react";
import { CircleCheck, CircleX, ShieldCheck } from "lucide-react";
import { Button, EmptyState, Tabs, cx, ICON_SIZE, ICON_STROKE, type TabItem } from "../../design";
import { formatElapsed, formatRelative } from "../../lib/time";
import type { CheckRun, FileChange, ReviewRequest } from "../../lib/types";
import DeliveryActions from "./DeliveryActions";
import DiscardFile from "./DiscardFile";
import AttentionCard from "../attention/AttentionCard";
import AutoModeSwitch from "../automode/AutoModeSwitch";
import { changeLetter, changeSummary } from "./taskPresentation";

type RailTab = "attention" | "changes" | "checks";

const TOP_CHANGES = 5;

interface TaskSideRailProps {
  taskId: string;
  /** The conversation the task works in: its auto mode is switched here. */
  conversationId: number | null;
  reviews: readonly ReviewRequest[];
  changes: readonly FileChange[];
  checks: readonly CheckRun[];
  now: number;
  onShowFiles: () => void;
}

/** What the task needs from you, what it changed, and how its checks went. */
export default function TaskSideRail({ taskId, conversationId, reviews, changes, checks, now, onShowFiles }: TaskSideRailProps) {
  const [tab, setTab] = useState<RailTab>(reviews.length ? "attention" : "checks");
  const tabs: TabItem<RailTab>[] = [
    { id: "attention", label: "Attention", count: reviews.length },
    { id: "changes", label: "Changes", count: changes.length },
    { id: "checks", label: "Checks", count: checks.length },
  ];
  const summary = changeSummary(changes);

  return (
    <aside className="task-rail" aria-label="Task status">
      <Tabs tabs={tabs} value={tab} onChange={setTab} label="Task status" idPrefix="task-rail" />
      <div role="tabpanel" id={`task-rail-panel-${tab}`} aria-labelledby={`task-rail-tab-${tab}`} className="task-rail-body">
        {tab === "attention" && conversationId !== null && <AutoModeSwitch conversationId={conversationId} className="task-rail-auto-mode" />}
        {tab === "attention" &&
          (reviews.length === 0 ? (
            <EmptyState compact icon={ShieldCheck} title="Nothing needs you" body="Approvals and questions from this task's agents show up here." />
          ) : (
            <div className="attention-list">
              {reviews.map((review) => (
                <AttentionCard key={review.id} review={review} now={now} />
              ))}
            </div>
          ))}

        {tab === "changes" && <DeliveryActions taskId={taskId} changes={changes} />}
        {tab === "changes" &&
          (changes.length === 0 ? (
            <EmptyState compact icon={CircleCheck} title="No uncommitted changes" body="The folder matches its last commit." />
          ) : (
            <div className="rail-changes">
              <p className="delivery-note">Everything uncommitted in the task’s folder, including changes made outside this task.</p>
              <p className="rail-changes-summary">
                {summary.added} added, {summary.modified} modified, {summary.deleted} deleted
                <span className="tabular">
                  <span className="is-add"> +{summary.linesAdded}</span>
                  <span className="is-remove"> −{summary.linesRemoved}</span>
                </span>
              </p>
              <ul className="rail-change-list">
                {changes.slice(0, TOP_CHANGES).map((c) => (
                  <li key={c.path} aria-label={`Changes to ${c.path}`}>
                    <span className={cx("change-letter", `is-${c.status}`)}>{changeLetter(c)}</span>
                    <span className="mono rail-change-path" title={c.path}>
                      {c.path}
                    </span>
                    <DiscardFile taskId={taskId} change={c} />
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="ghost" onClick={onShowFiles}>
                {changes.length > TOP_CHANGES ? `See all ${changes.length} files` : "See the changes"}
              </Button>
            </div>
          ))}

        {tab === "checks" &&
          (checks.length === 0 ? (
            <EmptyState
              compact
              icon={CircleCheck}
              title="No checks run yet"
              body="When the owner runs tests, a type check, lint or a build, whether it passed shows up here."
            />
          ) : (
            <ul className="check-runs">
              {[...checks].reverse().map((run) => {
                const Icon = run.passed ? CircleCheck : CircleX;
                return (
                  <li key={run.command} className={cx("check-run", run.passed ? "tone-success" : "tone-danger")}>
                    <Icon aria-hidden size={ICON_SIZE.md} strokeWidth={ICON_STROKE} className="check-run-icon" />
                    <span className="check-run-text">
                      <span className="check-run-kind">
                        {run.kind} {run.passed ? "passed" : "failed"}
                      </span>
                      <span className="check-run-command mono" title={run.command}>
                        {run.command}
                      </span>
                    </span>
                    <span className="check-run-time">
                      {formatRelative(run.at, now)}
                      {run.duration_ms !== null && <span className="tabular">, took {formatElapsed(run.duration_ms)}</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          ))}
      </div>
    </aside>
  );
}
