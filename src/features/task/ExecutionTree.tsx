import type { ReactNode } from "react";
import { Bot, ChevronRight, FileText, TriangleAlert } from "lucide-react";
import { portraitKey, Portrait, SectionHeader, Tag, cx, ICON_SIZE, ICON_STROKE, type PortraitSize } from "../../design";
import { useNavigation } from "../../stores/navigation";
import type { Helper } from "./taskPresentation";
import type { ExecutionPerson } from "./useExecutionPeople";

/** Portraits on the trunk (who asked, the owner) and on its branches; task.css's --execution-avatar and --execution-branch-avatar hold the same sizes. */
const TRUNK_AVATAR: PortraitSize = 40;
const BRANCH_AVATAR: PortraitSize = 32;
/** Claimed files listed open; more start folded. */
const CLAIMS_SHOWN = 3;

interface CardProps {
  person: Omit<ExecutionPerson, "opens">;
  onOpen?: () => void;
  onOpenTask: (id: string) => void;
  avatar: PortraitSize;
  /** The line down to whoever is below them (the owner, or the owner's teammates). */
  tail?: boolean;
  /** On a branch, being one says they were delegated to, and their name needs the room. */
  showRole?: boolean;
}

/** One person: who they are, what they're doing, what they changed, and their tasks when they have several. */
function Card({ person, onOpen, onOpenTask, avatar, tail, showRole = true }: CardProps) {
  const { agent, agentId, role, line, tone, files, claims, conflict, current, tasks } = person;
  const name = agent?.name ?? agentId;
  const fileCount = files ? `${files} ${files === 1 ? "file" : "files"}` : null;
  return (
    <div className={cx("execution-card", `tone-${tone}`, current && "is-current", tail && "has-tail", onOpen && "is-openable")}>
      <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={avatar} status={agent?.status} className="execution-portrait" />
      <div className="execution-text">
        <span className="execution-name">
          <span className="execution-name-text">{name}</span>
          {showRole && <Tag tone={current ? "accent" : "neutral"}>{role}</Tag>}
        </span>
        <span className="execution-line" title={line}>
          {line}
        </span>
        {fileCount && (
          <span className="execution-files">
            <FileText aria-hidden size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} />
            {fileCount}
          </span>
        )}
      </div>
      {/* Laid over the portrait and text, so that whole row opens their task; what's listed under them stays its own. */}
      {onOpen && <button type="button" className="execution-open" aria-label={`${name}, ${role}: ${line}`} title={line} onClick={onOpen} />}
      {tasks.length > 1 && (
        <ul className="execution-tasks" aria-label={`${name}'s tasks`}>
          {tasks.map((t) => {
            const label = `${t.state}: ${t.title}`;
            return (
              <li key={t.id}>
                {t.current ? (
                  <span className={cx("execution-task", `tone-${t.tone}`)} aria-current="page" aria-label={label} title={label}>
                    <span className="execution-task-title">{t.title}</span>
                  </span>
                ) : (
                  <button type="button" className={cx("execution-task", `tone-${t.tone}`)} aria-label={label} title={label} onClick={() => onOpenTask(t.id)}>
                    <span className="execution-task-title">{t.title}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {claims.length > 0 && (
        <details className="execution-claims" open={claims.length <= CLAIMS_SHOWN}>
          <summary>
            <ChevronRight aria-hidden size={ICON_SIZE.xs} strokeWidth={ICON_STROKE} className="execution-claims-chevron" />
            {claims.length} claimed {claims.length === 1 ? "file" : "files"}
          </summary>
          <ul>
            {claims.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </details>
      )}
      {conflict && (
        <p className="execution-conflict">
          <TriangleAlert aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
          <span>{conflict}</span>
        </p>
      )}
    </div>
  );
}

/** A temporary helper the owner started, on a branch like a teammate. */
function HelperCard({ helper }: { helper: Helper }) {
  return (
    <div className="execution-card tone-idle">
      <span className="execution-helper-icon" aria-hidden>
        <Bot size={ICON_SIZE.md} strokeWidth={ICON_STROKE} />
      </span>
      <div className="execution-text">
        <span className="execution-name">
          <span className="execution-name-text">Helper</span>
          {helper.kind && <Tag>{helper.kind}</Tag>}
        </span>
        <span className="execution-line" title={helper.description}>
          {helper.description}
        </span>
      </div>
    </div>
  );
}

/**
 * Everyone working on the task, as a tree: who asked for it (on a delegated task), the owner, and on
 * branches from the owner the teammates it delegated to and its temporary helpers. Each person shows
 * once, with their tasks listed under them when they have more than one.
 */
export default function ExecutionTree({ people, helpers, actions }: { people: readonly ExecutionPerson[]; helpers: readonly Helper[]; actions?: ReactNode }) {
  const openTask = useNavigation((s) => s.openTask);
  const trunk = people.filter((p) => p.role !== "Delegated");
  const branches = people.filter((p) => p.role === "Delegated");
  const hasBranches = branches.length + helpers.length > 0;
  const opener = (opens: string | null) => (opens ? () => openTask(opens) : undefined);

  return (
    <nav className="execution" aria-label="Who's working on this task">
      <SectionHeader title="Execution" count={people.length + helpers.length} actions={actions} />
      <ul className="execution-list">
        {trunk.map(({ opens, ...person }) => (
          <li key={`${person.role}-${person.agentId}`} className="execution-node">
            <Card
              person={person}
              onOpen={opener(opens)}
              onOpenTask={openTask}
              avatar={TRUNK_AVATAR}
              tail={person.role === "Asked by" || (person.role === "Owner" && hasBranches)}
            />
            {person.role === "Owner" && hasBranches && (
              <ul className="execution-branches" aria-label={`Working with ${person.agent?.name ?? person.agentId}`}>
                {branches.map(({ opens: theirs, ...teammate }) => (
                  <li key={teammate.agentId} className="execution-node">
                    <Card person={teammate} onOpen={opener(theirs)} onOpenTask={openTask} avatar={BRANCH_AVATAR} showRole={false} />
                  </li>
                ))}
                {helpers.map((helper, i) => (
                  <li key={`${helper.at}-${i}`} className="execution-node is-helper">
                    <HelperCard helper={helper} />
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </nav>
  );
}
