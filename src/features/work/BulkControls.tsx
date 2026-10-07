import { useEffect, useRef, type ReactNode } from "react";
import { Check, CheckCheck, ListChecks, Minus, X } from "lucide-react";
import { Button, Dialog, ICON_SIZE } from "../../design";
import type { Task } from "../../lib/types";
import { bulkTargets, closeVerb, selectionState, taskCount, type BulkAction, type SelectionState } from "./bulk";
import type { TaskRow } from "./board";

const CHECK_STROKE = 3;

interface SelectBoxProps {
  state: SelectionState;
  /** Spoken name; a visible label must be how it starts. */
  label: string;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}

/** A checkbox that can show part of a group picked. */
export function SelectBox({ state, label, onChange, disabled, children }: SelectBoxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  const Mark = state === "all" ? Check : state === "some" ? Minus : null;
  return (
    <label className="work-check">
      <input ref={ref} type="checkbox" checked={state === "all"} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />
      <span className="work-check-box" aria-hidden>
        {Mark && <Mark size={ICON_SIZE.xs} strokeWidth={CHECK_STROKE} />}
      </span>
      {children}
    </label>
  );
}

/** Starts selecting tasks; shown only while there's something to select. */
export function SelectButton({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" icon={ListChecks} onClick={onClick}>
      Select
    </Button>
  );
}

interface BulkBarProps {
  tasks: readonly Task[];
  busy: boolean;
  onAction: (action: BulkAction, tasks: readonly Task[]) => void;
  onDone: () => void;
}

/** What to do with the selected tasks. Marking reviewed skips any that aren't finished. */
export function BulkBar({ tasks, busy, onAction, onDone }: BulkBarProps) {
  const reviewable = bulkTargets("review", tasks).length;
  const reviewHint =
    reviewable === 0 ? "Select tasks that are ready for review" : reviewable < tasks.length ? `Marks the ${reviewable} ready for review; the rest stay as they are` : undefined;
  return (
    <div className="work-bulk-bar" role="toolbar" aria-label="Selected tasks">
      <span className="work-bulk-count tabular" aria-live="polite">
        {tasks.length === 0 ? "None selected" : `${tasks.length} selected`}
      </span>
      <Button variant="review" size="sm" icon={CheckCheck} disabled={busy || reviewable === 0} title={reviewHint} onClick={() => onAction("review", tasks)}>
        Mark reviewed
      </Button>
      <Button variant="secondary" size="sm" icon={X} disabled={busy || tasks.length === 0} onClick={() => onAction("close", tasks)}>
        {closeVerb(tasks)}
      </Button>
      <Button variant="ghost" size="sm" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

interface SectionBulkProps {
  section: string;
  rows: readonly TaskRow[];
  selecting: boolean;
  selected: ReadonlySet<string>;
  busy: boolean;
  onPick: (ids: readonly string[], on: boolean) => void;
  onAction: (action: BulkAction, tasks: readonly Task[]) => void;
}

/** A section's own controls: act on all of it at once, or, while selecting, select all of it. */
export function SectionBulk({ section, rows, selecting, selected, busy, onPick, onAction }: SectionBulkProps) {
  const ids = rows.map((r) => r.task.id);
  const tasks = rows.map((r) => r.task);
  if (selecting) {
    return (
      <SelectBox state={selectionState(ids, selected)} label={`Select all in ${section}`} onChange={(on) => onPick(ids, on)}>
        Select all
      </SelectBox>
    );
  }
  return (
    <>
      {bulkTargets("review", tasks).length > 0 && (
        <Button variant="ghost" size="sm" icon={CheckCheck} disabled={busy} onClick={() => onAction("review", tasks)}>
          Mark all reviewed
        </Button>
      )}
      <Button variant="ghost" size="sm" icon={X} disabled={busy} onClick={() => onAction("close", tasks)}>
        {closeVerb(tasks)} all
      </Button>
    </>
  );
}

interface CloseConfirmProps {
  tasks: readonly Task[] | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Closing takes tasks off Work for good, so it asks first. */
export function CloseConfirm({ tasks, onConfirm, onCancel }: CloseConfirmProps) {
  const verb = closeVerb(tasks ?? []);
  const what = taskCount(tasks?.length ?? 0);
  return (
    <Dialog
      open={tasks !== null}
      onClose={onCancel}
      icon={X}
      tone="danger"
      title={`${verb} ${what}?`}
      description="They leave Work and stay in history."
      actions={
        <>
          <Button variant="secondary" onClick={onCancel}>
            Keep them
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {verb} {what}
          </Button>
        </>
      }
    />
  );
}
