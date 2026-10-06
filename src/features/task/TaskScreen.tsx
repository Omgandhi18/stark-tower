import { useState } from "react";
import { ClipboardList } from "lucide-react";
import { EmptyState, SkeletonRows, Tabs, type TabItem } from "../../design";
import { requesterName } from "../../lib/requester";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useAutomations } from "../../stores/automations";
import { useNavigation } from "../../stores/navigation";
import TerminalDrawer from "../terminal/TerminalDrawer";
import { taskState } from "../work/board";
import ActivityList from "./ActivityList";
import ChangesList from "./ChangesList";
import ExecutionTree from "./ExecutionTree";
import PlanList from "./PlanList";
import TaskConversation from "./TaskConversation";
import TaskHeader from "./TaskHeader";
import TaskSideRail from "./TaskSideRail";
import { useTaskDetail } from "./useTaskDetail";
import "./task.css";

type CenterTab = "conversation" | "plan" | "files" | "activity";

const CLOCK_MS = 15_000;

/** One task in full: who's on it, the conversation, its plan, changes and history. */
export default function TaskScreen() {
  const route = useNavigation((s) => s.route);
  const taskId = useNavigation((s) => s.taskId);
  const navigate = useNavigation((s) => s.navigate);
  const agents = useAgents((s) => s.agents);
  const pending = useAttention((s) => s.pending);
  const automations = useAutomations((s) => s.items);
  const { state } = useTaskDetail(taskId);
  const [tab, setTab] = useState<CenterTab>("conversation");
  const now = useNow(CLOCK_MS);

  if (!taskId || state.status === "missing") {
    return (
      <div className="task-screen is-empty">
        <EmptyState
          icon={ClipboardList}
          title="That task isn't here"
          body="It may have been removed. Your tasks are listed on Work."
          action={
            <button type="button" className="link-button" onClick={() => navigate("work")}>
              Go to Work
            </button>
          }
        />
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div className="task-screen is-empty">
        <SkeletonRows rows={4} label="Loading the task" className="task-loading" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="task-screen is-empty">
        <EmptyState icon={ClipboardList} title="The task couldn't be loaded" body={state.message} />
      </div>
    );
  }

  const { detail } = state;
  const { task } = detail;
  const owner = agents.find((a) => a.id === task.assignee);
  const waitingOnYou = new Set(pending.map((r) => r.agentId));
  const members = new Set([task.assignee, ...detail.children.map((c) => c.assignee)]);
  const reviews = pending.filter((r) => members.has(r.agentId));
  const requester = requesterName(task.requested_by, agents, automations);

  const tabs: TabItem<CenterTab>[] = [
    { id: "conversation", label: "Conversation" },
    { id: "plan", label: "Plan", count: detail.plan.length },
    { id: "files", label: "Files", count: detail.changes.length },
    { id: "activity", label: "Activity" },
  ];

  return (
    <div className="task-screen">
      <TaskHeader detail={detail} owner={owner} requester={requester} state={taskState(task, owner, detail.children, waitingOnYou)} now={now} />
      <div className="task-body">
        <ExecutionTree detail={detail} waitingOnYou={waitingOnYou} />
        <section className="task-center" aria-label="Task">
          <Tabs tabs={tabs} value={tab} onChange={setTab} label="Task sections" idPrefix="task" className="task-tabs" />
          <div role="tabpanel" id={`task-panel-${tab}`} aria-labelledby={`task-tab-${tab}`} className="task-panel">
            {tab === "conversation" && <TaskConversation task={task} owner={owner} messages={detail.messages} requester={requester} />}
            {tab === "plan" && <PlanList plan={detail.plan} ownerName={owner?.name ?? task.assignee} />}
            {tab === "files" && <ChangesList taskId={task.id} changes={detail.changes} cwd={task.cwd} />}
            {tab === "activity" && <ActivityList events={detail.events} agents={agents} now={now} />}
          </div>
          <TerminalDrawer folder={task.cwd} active={route === "task"} />
        </section>
        <TaskSideRail taskId={task.id} conversationId={task.conversation_id} reviews={reviews} changes={detail.changes} checks={detail.checks} now={now} onShowFiles={() => setTab("files")} />
      </div>
    </div>
  );
}
