import { Bot, TriangleAlert } from "lucide-react";
import { portraitKey, Portrait, SectionHeader, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { Agent, Task, TaskDetail } from "../../lib/types";
import { useActivity } from "../../stores/activity";
import { useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { filesByAgent, helpersOf, openConflict } from "./taskPresentation";
import { taskState } from "../work/board";

/** Each person's portrait in the tree (task.css's --execution-avatar holds the same size). */
const AVATAR = 40;

interface NodeProps {
  agent: Agent | undefined;
  agentId: string;
  role: string;
  line: string;
  /** Files they changed in this task; left out for someone who isn't working on it. */
  files?: number;
  current?: boolean;
  onOpen?: () => void;
  tone: string;
  claims?: string[];
  /** A clash with another agent over a file, while it still matters. */
  conflict?: string;
}

function Node({ agent, agentId, role, line, files, current, onOpen, tone, claims = [], conflict }: NodeProps) {
  const name = agent?.name ?? agentId;
  const body = (
    <>
      <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={AVATAR} status={agent?.status} />
      <span className="execution-text">
        <span className="execution-name">
          {name}
          <Tag tone={current ? "accent" : "neutral"}>{role}</Tag>
        </span>
        <span className={cx("execution-line", `tone-${tone}`)}>{line}</span>
        {files !== undefined && <span className="execution-files">{files === 1 ? "1 file" : `${files} files`}</span>}
      </span>
    </>
  );
  return (
    <li className={cx("execution-node", current && "is-current")}>
      {onOpen ? (
        <button type="button" className="execution-button" onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className="execution-button">{body}</div>
      )}
      {claims.length > 0 && <details className="execution-claims" open={claims.length <= 3}><summary>{claims.length} claimed {claims.length === 1 ? "file" : "files"}</summary><ul>{claims.map((path) => <li key={path}>{path}</li>)}</ul></details>}
      {conflict && (
        <p className="execution-conflict">
          <TriangleAlert aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          <span>{conflict}</span>
        </p>
      )}
    </li>
  );
}

/**
 * Everyone working on the task: the owner, teammates it delegated to, and temporary helpers.
 * A delegated task starts with the task it came from, which opens from here.
 */
export default function ExecutionTree({ detail, waitingOnYou }: { detail: TaskDetail; waitingOnYou: ReadonlySet<string> }) {
  const agents = useAgents((s) => s.agents);
  const latest = useActivity((s) => s.latest);
  const openTask = useNavigation((s) => s.openTask);
  const { task, parent, children, events } = detail;
  const files = filesByAgent(events);
  const helpers = helpersOf(events);
  const claimsFor = (id: string) => detail.claims.filter((c) => c.agent_id === id).map((c) => `${c.path || "Whole workspace"} (${c.reason})`);
  const find = (id: string) => agents.find((a) => a.id === id);
  const owner = find(task.assignee);
  const ownerState = taskState(task, owner, children, waitingOnYou);
  const ownerLine = task.status === "doing" && latest[task.assignee] ? latest[task.assignee].summary : ownerState.label;
  const members = 1 + children.length + helpers.length + (parent ? 1 : 0);

  const summaryOf = (other: Task) => {
    const state = taskState(other, find(other.assignee), [], waitingOnYou);
    return { line: `${state.label}: ${other.title}`, tone: state.tone };
  };

  return (
    <nav className="execution" aria-label="Who's working on this task">
      <SectionHeader title="Execution" count={members} />
      <ul className="execution-list">
        {parent && (
          <Node agent={find(parent.assignee)} agentId={parent.assignee} role="Asked by" {...summaryOf(parent)} onOpen={() => openTask(parent.id)} />
        )}
        <Node
          agent={owner}
          agentId={task.assignee}
          role="Owner"
          line={ownerLine}
          files={files[task.assignee] ?? 0}
          claims={claimsFor(task.assignee)}
          conflict={openConflict(events, task.assignee, task.status)}
          current
          tone={ownerState.tone}
        />
        {children.map((child) => (
          <Node
            key={child.id}
            agent={find(child.assignee)}
            agentId={child.assignee}
            role="Delegated"
            {...summaryOf(child)}
            files={files[child.assignee] ?? 0}
            claims={claimsFor(child.assignee)}
            conflict={openConflict(events, child.assignee, child.status)}
            onOpen={() => openTask(child.id)}
          />
        ))}
        {helpers.map((helper, i) => (
          <li key={`${helper.at}-${i}`} className="execution-node is-helper">
            <div className="execution-button">
              <span className="execution-helper-icon" aria-hidden>
                <Bot size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
              </span>
              <span className="execution-text">
                <span className="execution-name">
                  Helper
                  {helper.kind && <Tag>{helper.kind}</Tag>}
                </span>
                <span className="execution-line">{helper.description}</span>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </nav>
  );
}
