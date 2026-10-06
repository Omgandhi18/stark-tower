import { useState } from "react";
import { ArrowLeft, CheckCheck, Clock, Folder, FolderOpen, GitBranch, MessageSquareText, Play, ShieldCheck, Square, X } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button, OverflowMenu, Portrait, StatusPill, ICON_SIZE, ICON_STROKE, type MenuItem } from "../../design";
import { chatStop, closeTask, resumeTask, reviewTask } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatElapsed } from "../../lib/time";
import type { Agent, TaskDetail } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import { folderName } from "../../stores/workspace";
import { providerLabel } from "../agents/display";
import RemindMeButton from "../reminders/RemindMeButton";
import type { StateTone } from "../../lib/status";

const report = (what: string) => (e: unknown) => console.error(`[task] couldn't ${what}`, e);

interface TaskHeaderProps {
  detail: TaskDetail;
  owner: Agent | undefined;
  requester: string;
  state: { label: string; tone: StateTone };
  now: number;
}

/** What the task is, who owns it, and where and how long it has been running. */
export default function TaskHeader({ detail, owner, requester, state, now }: TaskHeaderProps) {
  const config = useConfig((s) => s.config);
  const navigate = useNavigation((s) => s.navigate);
  const openConversation = useNavigation((s) => s.openConversation);
  const { task } = detail;
  const branch = detail.branch ?? (task.branch || null);
  const started = task.started ?? task.ts;
  const elapsed = formatElapsed((task.finished ?? now) - started);
  const name = owner?.name ?? task.assignee;
  const [error, setError] = useState<string | null>(null);
  const markReviewed = () => {
    setError(null);
    reviewTask(task.id).catch((e) => setError(errorMessage(e, "The task couldn't be marked reviewed.")));
  };

  const items: MenuItem[] = [];
  if (task.cwd) {
    items.push({
      id: "reveal",
      label: "Show folder in Finder",
      icon: FolderOpen,
      onSelect: () => void revealItemInDir(task.cwd).catch(report("show the folder")),
    });
  }
  if (task.status === "blocked" && task.conversation_id !== null && !task.parent_id) {
    items.push({ id: "resume", label: "Continue where it left off", icon: Play, onSelect: () => void resumeTask(task.id).catch(report("continue the task")) });
  }
  if (task.status === "doing" && !task.parent_id) {
    items.push({ id: "stop", label: "Stop", icon: Square, danger: true, onSelect: () => void chatStop(task.assignee).catch(report("stop the task")) });
  }
  // A finished task is marked reviewed (below); anything else still open can be closed.
  if (!["closed", "reviewed", "done"].includes(task.status)) {
    items.push({
      id: "close",
      label: task.status === "todo" ? "Cancel task" : "Close task",
      icon: X,
      onSelect: () => void closeTask(task.id).catch(report("close the task")),
    });
  }

  return (
    <header className="task-header">
      <div className="task-header-bar">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate("work")}>
          All work
        </Button>
        <div className="task-header-actions">
          <Button icon={MessageSquareText} onClick={() => openConversation(task.assignee)}>
            Talk to {name}
          </Button>
          <RemindMeButton task={task} ownerName={name} />
          {task.status === "done" && (
            <Button variant="review" icon={CheckCheck} onClick={markReviewed}>
              Mark as reviewed
            </Button>
          )}
          {items.length > 0 && <OverflowMenu label={`More actions for ${task.title}`} items={items} />}
        </div>
      </div>
      {error && (
        <p className="task-header-error" role="alert">
          {error}
        </p>
      )}
      <h1 className="task-title">{task.title}</h1>
      <dl className="task-facts">
        <div className="task-fact">
          <dt>Status</dt>
          <dd>
            <StatusPill label={state.label} tone={state.tone} />
          </dd>
        </div>
        <div className="task-fact">
          <dt>Owner</dt>
          <dd>
            <Portrait name={name} figure={owner?.figure} accent={owner?.accent} size={24} status={owner?.status} />
            {name}
          </dd>
        </div>
        {owner && (
          <div className="task-fact">
            <dt>Provider</dt>
            <dd>{providerLabel(owner.id, owner.engine, config)}</dd>
          </div>
        )}
        {task.cwd && (
          <div className="task-fact">
            <dt>Project</dt>
            <dd title={task.cwd}>
              <Folder aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
              {folderName(task.cwd)}
            </dd>
          </div>
        )}
        {branch && (
          <div className="task-fact">
            <dt>Branch</dt>
            <dd>
              <GitBranch aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
              <span className="mono">{branch}</span>
            </dd>
          </div>
        )}
        <div className="task-fact">
          <dt>{task.finished ? "Took" : "Elapsed"}</dt>
          <dd>
            <Clock aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            <span className="tabular">{elapsed}</span>
          </dd>
        </div>
        <div className="task-fact">
          <dt>Asked by</dt>
          <dd>{requester}</dd>
        </div>
        <div
          className="task-fact"
          title="Project work runs on its own; installs, branches and files outside the project need you; publishing never runs on its own."
        >
          <dt>Permissions</dt>
          <dd>
            <ShieldCheck aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
            Default
          </dd>
        </div>
      </dl>
    </header>
  );
}
