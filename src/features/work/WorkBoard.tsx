import { useMemo, useState, type ReactNode } from "react";
import { ArrowUpDown, CircleCheckBig, CirclePause, Hourglass, MessageSquareReply, MessagesSquare, OctagonAlert, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { portraitKey, CountBadge, EmptyState, Portrait, SelectField, SkeletonRows, Tabs, ICON_SIZE, ICON_STROKE } from "../../design";
import { AGENT_STATUS } from "../../lib/status";
import { useNow } from "../../lib/useNow";
import { useActivity } from "../../stores/activity";
import { useAgents, selectOrchestrator } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useNavigation } from "../../stores/navigation";
import { useWorkspace } from "../../stores/workspace";
import { buildBoard, type WorkSort, type WorkTab } from "./board";
import { ChatRowView, TaskRowView } from "./TaskRows";

const CLOCK_MS = 15_000;

const TABS = [
  { id: "all" as const, label: "All work" },
  { id: "mine" as const, label: "Asked by you" },
];

const SORTS = [
  { value: "recent", label: "Most recent" },
  { value: "longest", label: "Longest running" },
];

/** Tasks by state, agents busy in plain chats, and the team. */
export default function WorkBoard({ project }: { project: string | null }) {
  const agents = useAgents((s) => s.agents);
  const since = useAgents((s) => s.since);
  const agentsLoaded = useAgents((s) => s.loaded);
  const tasks = useWorkspace((s) => s.tasks);
  const tasksLoaded = useWorkspace((s) => s.loaded.tasks);
  const conversations = useWorkspace((s) => s.conversations);
  const latest = useActivity((s) => s.latest);
  const pending = useAttention((s) => s.pending);
  const orchestrator = useAgents(selectOrchestrator);
  const [tab, setTab] = useState<WorkTab>("all");
  const [sort, setSort] = useState<WorkSort>("recent");
  const now = useNow(CLOCK_MS);

  const board = useMemo(
    () => buildBoard({ agents, since, tasks, conversations, latest, pending, project, tab, sort, now }),
    [agents, since, tasks, conversations, latest, pending, project, tab, sort, now],
  );

  if (!agentsLoaded || !tasksLoaded) {
    return (
      <div className="work-board">
        <SkeletonRows rows={4} label="Loading work" />
      </div>
    );
  }

  const runningCount = board.running.length + board.chats.length;

  return (
    <div className="work-board">
      <div className="work-toolbar">
        <Tabs tabs={TABS} value={tab} onChange={setTab} label="Which work" idPrefix="work" className="work-tabs" />
        <SelectField
          label="Sort"
          hideLabel
          icon={ArrowUpDown}
          value={sort}
          options={SORTS}
          onChange={(value) => setSort(value as WorkSort)}
          className="work-sort"
        />
      </div>

      <div role="tabpanel" id={`work-panel-${tab}`} aria-labelledby={`work-tab-${tab}`} className="work-sections">
        <BoardSection title="Running" icon={Play} tone="running" count={runningCount}>
          {runningCount === 0 ? (
            <EmptyState
              compact
              icon={CirclePause}
              title="Nothing is running"
              body={orchestrator ? `Ask ${orchestrator.name} above to start something.` : "Mention an agent above to start something."}
            />
          ) : (
            <ul className="work-rows">
              {board.running.map((row) => (
                <TaskRowView key={row.task.id} row={row} now={now} />
              ))}
              {board.chats.map((row) => (
                <ChatRowView key={row.agent.id} row={row} now={now} />
              ))}
            </ul>
          )}
        </BoardSection>

        {board.queued.length > 0 && (
          <BoardSection title="Waiting their turn" icon={Hourglass} tone="idle" count={board.queued.length}>
            <ul className="work-rows">
              {board.queued.map((row) => (
                <TaskRowView key={row.task.id} row={row} now={now} />
              ))}
            </ul>
          </BoardSection>
        )}

        <BoardSection title="Ready for review" icon={CircleCheckBig} tone="review" count={board.ready.length}>
          {board.ready.length === 0 ? (
            <EmptyState compact icon={CircleCheckBig} title="Nothing to review" body="Finished tasks wait here until you close them." />
          ) : (
            <ul className="work-rows">
              {board.ready.map((row) => (
                <TaskRowView key={row.task.id} row={row} now={now} />
              ))}
            </ul>
          )}
        </BoardSection>

        {board.blocked.length > 0 && (
          <BoardSection title="Blocked" icon={OctagonAlert} tone="danger" count={board.blocked.length}>
            <ul className="work-rows">
              {board.blocked.map((row) => (
                <TaskRowView key={row.task.id} row={row} now={now} />
              ))}
            </ul>
          </BoardSection>
        )}

        {board.answered.length > 0 && (
          <BoardSection title="Answered" icon={MessageSquareReply} tone="idle" count={board.answered.length}>
            <p className="work-section-note">Finished with nothing to review. Each stays here for a day, and with its chat after that.</p>
            <ul className="work-rows">
              {board.answered.map((row) => (
                <TaskRowView key={row.task.id} row={row} now={now} />
              ))}
            </ul>
          </BoardSection>
        )}

        {tab === "all" && <TeamSection />}
      </div>
    </div>
  );
}

interface BoardSectionProps {
  title: string;
  icon: LucideIcon;
  tone: string;
  count?: number;
  children: ReactNode;
}

function BoardSection({ title, icon: Icon, tone, count, children }: BoardSectionProps) {
  const id = `work-section-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <section className="work-section" aria-labelledby={id}>
      <header className="work-section-head">
        <span className={`work-section-icon tone-${tone}`} aria-hidden>
          <Icon size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        </span>
        <h2 id={id} className="work-section-title">
          {title}
        </h2>
        {count !== undefined && <CountBadge count={count} label={title} tone="neutral" showZero />}
      </header>
      {children}
    </section>
  );
}

function TeamSection() {
  const agents = useAgents((s) => s.agents);
  const openConversation = useNavigation((s) => s.openConversation);
  const team = agents.filter((a) => a.kind !== "maintenance");
  if (team.length === 0) return null;
  return (
    <section className="work-section" aria-labelledby="work-section-team">
      <header className="work-section-head">
        <span className="work-section-icon tone-idle" aria-hidden>
          <MessagesSquare size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} />
        </span>
        <h2 id="work-section-team" className="work-section-title">
          Team
        </h2>
      </header>
      <ul className="team-grid">
        {team.map((a) => {
          const status = AGENT_STATUS[a.status];
          return (
            <li key={a.id}>
              <button type="button" className="team-card" onClick={() => openConversation(a.id)}>
                <Portrait name={a.name} figure={portraitKey(a)} accent={a.accent} status={a.status} size={40} />
                <span className="team-text">
                  <span className="team-name">{a.name}</span>
                  <span className="team-role">{a.role}</span>
                </span>
                <span className={`team-state tone-${status.tone}`}>{status.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
