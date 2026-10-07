import { useEffect, useState } from "react";
import { ClipboardList, MessagesSquare } from "lucide-react";
import { EmptyState, SkeletonRows, Tabs, cx, type TabItem } from "../../design";
import { requesterName } from "../../lib/requester";
import type { TaskDetail } from "../../lib/types";
import { useNow } from "../../lib/useNow";
import { useAgents } from "../../stores/agents";
import { useAttention } from "../../stores/attention";
import { useAutomations } from "../../stores/automations";
import { useNavigation } from "../../stores/navigation";
import { usePreview } from "../../stores/preview";
import { useWorkspace } from "../../stores/workspace";
import TerminalDrawer from "../terminal/TerminalDrawer";
import { taskState } from "../work/board";
import ActivityList from "./ActivityList";
import ChangesList from "./ChangesList";
import PlanList from "./PlanList";
import TaskConversation from "./TaskConversation";
import TaskHeader from "./TaskHeader";
import TaskLeftColumn from "./TaskLeftColumn";
import TaskSideRail from "./TaskSideRail";
import { taskChat } from "./liveChat";
import { useChatOpening } from "./useChatOpening";
import { useTaskDetail } from "./useTaskDetail";
import "./task.css";

type CenterTab = "conversation" | "plan" | "files" | "activity";

const CLOCK_MS = 15_000;

/**
 * Every chat, as the task it runs: who's on it, the conversation, its plan, changes and
 * history, with the browser, simulator and terminal beside it.
 */
export default function TaskScreen() {
  const route = useNavigation((s) => s.route);
  const taskId = useNavigation((s) => s.taskId);
  const chatAgent = useNavigation((s) => s.chatAgent);
  const navigate = useNavigation((s) => s.navigate);
  const openTask = useNavigation((s) => s.openTask);
  const agents = useAgents((s) => s.agents);
  const opening = useChatOpening(chatAgent);
  const { state } = useTaskDetail(taskId);
  const now = useNow(CLOCK_MS);
  // A chat carries on into newer work (more asked after a review, a new request from Work): once
  // this task has nothing left running or waiting for review, the page follows the chat there.
  const newer = useWorkspace((s) => {
    const shown = s.tasks.find((t) => t.id === taskId);
    if (!shown || shown.conversation_id === null || !["idle", "reviewed", "closed"].includes(shown.status)) return null;
    const later = s.tasks.filter((t) => t.conversation_id === shown.conversation_id && !t.parent_id && t.ts > shown.ts);
    return later.sort((a, b) => b.ts - a.ts)[0]?.id ?? null;
  });
  useEffect(() => {
    if (newer && route === "task") openTask(newer);
  }, [newer, route, openTask]);

  if (chatAgent) {
    const name = agents.find((a) => a.id === chatAgent)?.name ?? chatAgent;
    return (
      <div className="task-screen is-empty">
        {opening.error ? (
          <EmptyState
            icon={MessagesSquare}
            title={`Your chat with ${name} couldn't be opened`}
            body={opening.error}
            action={
              <button type="button" className="link-button" onClick={opening.retry}>
                Try again
              </button>
            }
          />
        ) : (
          <SkeletonRows rows={4} label={`Opening your chat with ${name}`} className="task-loading" />
        )}
      </div>
    );
  }
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
  return <TaskWorkspace detail={state.detail} active={route === "task"} now={now} />;
}

/** One task in full, with its chat live in the middle. */
function TaskWorkspace({ detail, active, now }: { detail: TaskDetail; active: boolean; now: number }) {
  const agents = useAgents((s) => s.agents);
  const pending = useAttention((s) => s.pending);
  const automations = useAutomations((s) => s.items);
  const previewing = usePreview((s) => s.open);
  const [tab, setTab] = useState<CenterTab>("conversation");
  const { task } = detail;
  const owner = agents.find((a) => a.id === task.assignee);
  const chat = taskChat(task, owner);
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
    <div className={cx("task-screen", previewing && "has-preview")}>
      <TaskHeader detail={detail} owner={owner} chat={chat} requester={requester} state={taskState(task, owner, detail.children, waitingOnYou)} now={now} />
      <div className="task-body">
        <TaskLeftColumn detail={detail} owner={owner} waitingOnYou={waitingOnYou} toolBeside={previewing} />
        <section className="task-center" aria-label="Task">
          <Tabs tabs={tabs} value={tab} onChange={setTab} label="Task sections" idPrefix="task" className="task-tabs" />
          <div role="tabpanel" id={`task-panel-${tab}`} aria-labelledby={`task-tab-${tab}`} className="task-panel">
            {tab === "conversation" && <TaskConversation task={task} owner={owner} messages={detail.messages} requester={requester} />}
            {tab === "plan" && <PlanList plan={detail.plan} ownerName={owner?.name ?? task.assignee} />}
            {tab === "files" && <ChangesList taskId={task.id} changes={detail.changes} cwd={task.cwd} />}
            {tab === "activity" && <ActivityList events={detail.events} agents={agents} now={now} />}
          </div>
          <TerminalDrawer folder={task.cwd} active={active} movable />
        </section>
        <TaskSideRail
          taskId={task.id}
          folder={task.cwd}
          active={active}
          conversationId={task.conversation_id}
          pointChat={chat}
          reviews={reviews}
          changes={detail.changes}
          checks={detail.checks}
          now={now}
          onShowFiles={() => setTab("files")}
        />
      </div>
    </div>
  );
}
