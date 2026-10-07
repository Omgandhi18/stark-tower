import { useState } from "react";
import { CalendarClock, CheckCheck, CornerDownRight, Hourglass, MessageSquareReply, MessageSquareText, Play, RotateCcw, Square, SquareArrowOutUpRight, X } from "lucide-react";
import { portraitKey, Button, OverflowMenu, Portrait, StatusPill, Tag, ICON_SIZE, ICON_STROKE, type MenuItem } from "../../design";
import { chatStop, closeTask, resumeTask, reviewTask, startTask } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { automationOf } from "../../lib/requester";
import { AGENT_STATUS } from "../../lib/status";
import { formatElapsed, formatRelative } from "../../lib/time";
import type { Agent } from "../../lib/types";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import { folderName } from "../../stores/workspace";
import { providerLabel } from "../agents/display";
import { excerpt } from "../attention/presentation";
import { progressRatio, type ChatRow, type TaskRow } from "./board";

const SHOWN_CONTRIBUTORS = 3;
const PERCENT = 100;

const report = (what: string) => (e: unknown) => console.error(`[work] couldn't ${what}`, e);

/** Teammates a task delegated to, as overlapping portraits. */
export function Contributors({ agents }: { agents: readonly Agent[] }) {
  if (agents.length === 0) return null;
  const shown = agents.slice(0, SHOWN_CONTRIBUTORS);
  const more = agents.length - shown.length;
  const names = agents.map((a) => a.name).join(", ");
  return (
    <span className="contributors" role="img" aria-label={`With ${names}`} title={`With ${names}`}>
      {shown.map((a) => (
        <Portrait key={a.id} name={a.name} figure={portraitKey(a)} accent={a.accent} size={24} className="contributor" />
      ))}
      {more > 0 && <span className="contributors-more">+{more}</span>}
    </span>
  );
}

/** The owner's own plan as a bar: steps done out of steps planned. */
export function PlanProgress({ progress }: { progress: { done: number; total: number } }) {
  const ratio = progressRatio(progress);
  return (
    <div className="plan-progress">
      <div className="plan-bar" role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}>
        <span style={{ width: `${Math.round(ratio * PERCENT)}%` }} />
      </div>
      <span className="plan-count tabular">
        {progress.done} of {progress.total} steps
      </span>
    </div>
  );
}

interface TaskRowViewProps {
  row: TaskRow;
  now: number;
}

/** One task on the board: who owns it, where it runs, how far along it is. */
export function TaskRowView({ row, now }: TaskRowViewProps) {
  const config = useConfig((s) => s.config);
  const openTask = useNavigation((s) => s.openTask);
  const openConversation = useNavigation((s) => s.openConversation);
  const [error, setError] = useState<string | null>(null);
  const { task, owner } = row;
  const name = owner?.name ?? task.assignee;
  const status = task.status;
  const open = () => openTask(task.id);

  const retry = () => {
    setError(null);
    startTask(task.assignee, task.prompt || task.title, task.cwd || undefined).catch((e) => setError(errorMessage(e, "The task couldn't be started again.")));
  };

  // A stopped task you asked for can continue in its own conversation, where it left off.
  const canResume = status === "blocked" && task.conversation_id !== null && !task.parent_id;
  const resume = () => {
    setError(null);
    resumeTask(task.id).catch((e) => setError(errorMessage(e, "The task couldn't continue.")));
  };

  const items: MenuItem[] = [
    { id: "open", label: "Open task", icon: SquareArrowOutUpRight, onSelect: open },
    { id: "chat", label: "Open conversation", icon: MessageSquareText, onSelect: () => openConversation(task.assignee) },
  ];
  // A delegated task runs in a one-shot session that can't be stopped from here yet.
  if (canResume) {
    items.push({ id: "retry", label: "Start over as a new task", icon: RotateCcw, onSelect: retry });
  }
  if (status === "doing" && !task.parent_id) {
    items.push({ id: "stop", label: "Stop", icon: Square, danger: true, onSelect: () => void chatStop(task.assignee).catch(report("stop the task")) });
  }
  if (status === "done") {
    items.push({
      id: "reviewed",
      label: "Mark as reviewed",
      icon: CheckCheck,
      onSelect: () => void reviewTask(task.id).catch((e) => setError(errorMessage(e, "The task couldn't be marked reviewed."))),
    });
  } else {
    items.push({
      id: "close",
      label: status === "todo" ? "Cancel" : "Close task",
      icon: X,
      onSelect: () => void closeTask(task.id).catch(report("close the task")),
    });
  }

  return (
    <li className="work-row">
      <Portrait name={name} figure={portraitKey(owner)} accent={owner?.accent} status={status === "doing" ? owner?.status : undefined} size={48} />
      <div className="work-row-main">
        <span className="work-row-agent">
          {name}
          {task.parent_id && <CornerDownRight aria-label="Delegated" size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} className="work-row-delegated" />}
          {automationOf(task.requested_by) !== null && (
            <CalendarClock aria-label="Scheduled by an automation" size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} className="work-row-delegated" />
          )}
        </span>
        <button type="button" className="work-row-title" onClick={open}>
          {task.title}
        </button>
        {task.cwd && (
          <span className="work-row-project" title={task.cwd}>
            {folderName(task.project_folder || task.cwd)}
            {task.branch && <span className="work-row-branch"> · {task.branch}</span>}
          </span>
        )}
        {status === "doing" && <p className="work-row-activity">{row.activity?.summary ?? "Getting started"}</p>}
        {(status === "blocked" || status === "done" || status === "idle") && task.detail && <p className="work-row-activity">{excerpt(task.detail, 160)}</p>}
        {row.progress && <PlanProgress progress={row.progress} />}
        {error && (
          <p className="work-row-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="work-row-side">
        <div className="work-row-meta">
          {owner && <Tag>{providerLabel(owner.id, owner.engine, config)}</Tag>}
          <span className="work-row-elapsed tabular" title={status === "doing" ? "Running for" : undefined}>
            {status === "doing" || status === "todo" ? formatElapsed(now - row.since) : formatRelative(row.since, now)}
          </span>
          {status === "done" ? (
            <Button variant="review" size="sm" onClick={open}>
              Review
            </Button>
          ) : status === "blocked" ? (
            canResume ? (
              <Button variant="secondary" size="sm" icon={Play} onClick={resume}>
                Continue
              </Button>
            ) : (
              <Button variant="secondary" size="sm" icon={RotateCcw} onClick={retry}>
                Try again
              </Button>
            )
          ) : (
            <StatusPill
              label={row.state.label}
              tone={row.state.tone}
              icon={status === "todo" ? Hourglass : status === "idle" ? MessageSquareReply : owner ? AGENT_STATUS[owner.status].icon : undefined}
              live={status === "doing" && Boolean(owner && AGENT_STATUS[owner.status].busy)}
            />
          )}
          <OverflowMenu label={`More actions for ${task.title}`} items={items} />
        </div>
        <Contributors agents={row.contributors} />
      </div>
    </li>
  );
}

/** An agent busy in a plain chat rather than on a task. */
export function ChatRowView({ row, now }: { row: ChatRow; now: number }) {
  const config = useConfig((s) => s.config);
  const openConversation = useNavigation((s) => s.openConversation);
  const { agent } = row;
  const open = () => openConversation(agent.id);
  return (
    <li className="work-row">
      <Portrait name={agent.name} figure={portraitKey(agent)} accent={agent.accent} status={agent.status} size={48} />
      <div className="work-row-main">
        <span className="work-row-agent">{agent.name}</span>
        <button type="button" className="work-row-title" onClick={open}>
          {row.title}
        </button>
        {row.cwd && (
          <span className="work-row-project" title={row.cwd}>
            {folderName(row.project || row.cwd)}
          </span>
        )}
        <p className="work-row-activity">{row.activity?.summary ?? "Getting started"}</p>
      </div>
      <div className="work-row-side">
        <div className="work-row-meta">
          <Tag>{providerLabel(agent.id, agent.engine, config)}</Tag>
          <span className="work-row-elapsed tabular">{formatElapsed(now - row.since)}</span>
          <StatusPill label={row.state.label} tone={row.state.tone} icon={AGENT_STATUS[agent.status].icon} live={AGENT_STATUS[agent.status].busy} />
          <OverflowMenu
            label={`More actions for ${agent.name}`}
            items={[
              { id: "open", label: "Open conversation", icon: MessageSquareText, onSelect: open },
              {
                id: "stop",
                label: "Stop session",
                icon: Square,
                danger: true,
                onSelect: () => void chatStop(agent.id).catch(report(`stop ${agent.name}`)),
              },
            ]}
          />
        </div>
      </div>
    </li>
  );
}
