import { useState } from "react";
import { ChevronDown, ChevronRight, GitCompareArrows } from "lucide-react";
import { EmptyState, SkeletonRows, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { getTaskFileDiff } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import type { FileChange } from "../../lib/types";
import { folderName } from "../../stores/workspace";
import DiffView from "./DiffView";
import { changeLetter } from "./taskPresentation";

type DiffState = { status: "loading" } | { status: "ready"; diff: string } | { status: "error"; message: string };

function ChangeRow({ taskId, change }: { taskId: string; change: FileChange }) {
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<DiffState>({ status: "loading" });
  const Chevron = open ? ChevronDown : ChevronRight;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) {
      setDiff({ status: "loading" });
      getTaskFileDiff(taskId, change.path)
        .then((text) => setDiff({ status: "ready", diff: text }))
        .catch((e) => setDiff({ status: "error", message: errorMessage(e, "The change couldn't be shown.") }));
    }
  };

  return (
    <li className={cx("change-row", open && "is-open")}>
      <button type="button" className="change-head" aria-expanded={open} onClick={toggle}>
        <Chevron aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        <span className={cx("change-letter", `is-${change.status}`)} title={change.status}>
          {changeLetter(change)}
        </span>
        <span className="change-path mono">{change.path}</span>
        <span className="change-lines tabular">
          {change.added !== null && <span className="is-add">+{change.added}</span>}
          {change.removed !== null && <span className="is-remove">−{change.removed}</span>}
        </span>
      </button>
      {open && (
        <div className="change-body">
          {diff.status === "loading" && <SkeletonRows rows={2} label="Loading the change" />}
          {diff.status === "error" && (
            <p className="task-error" role="alert">
              {diff.message}
            </p>
          )}
          {diff.status === "ready" && <DiffView diff={diff.diff} />}
        </div>
      )}
    </li>
  );
}

/** Uncommitted changes in the task's folder, each with its readable diff. */
export default function ChangesList({ taskId, changes, cwd }: { taskId: string; changes: readonly FileChange[]; cwd: string }) {
  if (changes.length === 0) {
    return <EmptyState icon={GitCompareArrows} title="No uncommitted changes" body={cwd ? `Nothing in ${folderName(cwd)} differs from its last commit.` : "This task has no folder."} />;
  }
  return (
    <div className="changes">
      <p className="changes-note">Everything uncommitted in {folderName(cwd)}, including changes made outside this task.</p>
      <ul className="changes-list">
        {changes.map((change) => (
          <ChangeRow key={change.path} taskId={taskId} change={change} />
        ))}
      </ul>
    </div>
  );
}
