import { Bot } from "lucide-react";
import { portraitKey, Portrait, SectionHeader, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { Agent, Task, TaskDetail } from "../../lib/types";
import { useActivity } from "../../stores/activity";
import { useAgents } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { filesByAgent, helpersOf } from "./taskPresentation";
import { taskState } from "../work/board";

interface NodeProps {
  agent: Agent | undefined;
  agentId: string;
  role: string;
  line: string;
  files: number;
  current?: boolean;
  onOpen?: () => void;
  tone: string;
  claims?: string[];
  refusal?: string;
}

function Node({ agent, agentId, role, line, files, current, onOpen, tone, claims = [], refusal }: NodeProps) {
  const name = agent?.name ?? agentId;
  const body = (
    <>
      <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={40} status={agent?.status} />
      <span className="execution-text">
        <span className="execution-name">
          {name}
          <Tag tone={current ? "accent" : "neutral"}>{role}</Tag>
        </span>
        <span className={cx("execution-line", `tone-${tone}`)}>{line}</span>
        <span className="execution-files">{files === 1 ? "1 file" : `${files} files`}</span>
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
      {refusal && <p className="execution-claims execution-refusal">{refusal}</p>}
    </li>
  );
}

/** Everyone working on the task: the owner, teammates it delegated to, and temporary helpers. */
export default function ExecutionTree({ detail, waitingOnYou }: { detail: TaskDetail; waitingOnYou: ReadonlySet<string> }) {
  const agents = useAgents((s) => s.agents);
  const latest = useActivity((s) => s.latest);
  const openTask = useNavigation((s) => s.openTask);
  const { task, children, events } = detail;
  const files = filesByAgent(events);
  const helpers = helpersOf(events);
  const claimsFor = (id: string) => detail.claims.filter((c) => c.agent_id === id).map((c) => `${c.path || "Whole workspace"} (${c.reason})`);
  const refusalFor = (id: string) => events.filter((e) => e.agent_id === id && ["claim_refused", "claim_overlap"].includes(e.kind)).slice(-1)[0]?.summary;
  const find = (id: string) => agents.find((a) => a.id === id);
  const owner = find(task.assignee);
  const ownerState = taskState(task, owner, children, waitingOnYou);
  const ownerLine = task.status === "doing" && latest[task.assignee] ? latest[task.assignee].summary : ownerState.label;
  const members = 1 + children.length + helpers.length;

  const childLine = (child: Task) => {
    const state = taskState(child, find(child.assignee), [], waitingOnYou);
    return `${state.label}: ${child.title}`;
  };

  return (
    <nav className="execution" aria-label="Who's working on this task">
      <SectionHeader title="Execution" count={members} />
      <ul className="execution-list">
        <Node agent={owner} agentId={task.assignee} role="Owner" line={ownerLine} files={files[task.assignee] ?? 0} claims={claimsFor(task.assignee)} refusal={refusalFor(task.assignee)} current tone={ownerState.tone} />
        {children.map((child) => {
          const agent = find(child.assignee);
          return (
            <Node
              key={child.id}
              agent={agent}
              agentId={child.assignee}
              role="Delegated"
              line={childLine(child)}
              files={files[child.assignee] ?? 0}
              claims={claimsFor(child.assignee)}
              refusal={refusalFor(child.assignee)}
              tone={taskState(child, agent, [], waitingOnYou).tone}
              onOpen={() => openTask(child.id)}
            />
          );
        })}
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
