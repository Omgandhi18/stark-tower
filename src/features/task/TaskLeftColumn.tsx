import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { IconButton, cx, usePeek } from "../../design";
import { PANEL_SHORTCUT } from "../../app/panelShortcuts";
import type { Agent, TaskDetail } from "../../lib/types";
import { useMediaQuery } from "../../lib/useMediaQuery";
import { usePanels } from "../../stores/panels";
import EarlierChats from "./EarlierChats";
import ExecutionRail from "./ExecutionRail";
import ExecutionTree from "./ExecutionTree";
import { useExecutionPeople } from "./useExecutionPeople";

/** Beside the browser or simulator on a window this narrow, the column keeps to its rail so the chat has room. */
const NARROW_BESIDE_A_TOOL = "(max-width: 1440px)";

interface TaskLeftColumnProps {
  detail: TaskDetail;
  owner: Agent | undefined;
  waitingOnYou: ReadonlySet<string>;
  /** The browser or simulator is open in the side panel. */
  toolBeside: boolean;
}

/**
 * The task's left column: who's working on it, then the owner's other chats. Collapsed, it's a rail
 * of their portraits, and resting on it brings the whole column out over the chat.
 */
export default function TaskLeftColumn({ detail, owner, waitingOnYou, toolBeside }: TaskLeftColumnProps) {
  const chosen = usePanels((s) => s.collapsed.taskLeft);
  const setCollapsed = usePanels((s) => s.setCollapsed);
  const narrow = useMediaQuery(NARROW_BESIDE_A_TOOL);
  const forced = toolBeside && narrow;
  const collapsed = chosen || forced;
  const { ref, panelRef, peeking, open, handlers } = usePeek(collapsed);
  const { people, helpers } = useExecutionPeople(detail, waitingOnYou);
  const { task } = detail;
  const shortcut = PANEL_SHORTCUT.taskLeft;

  const toggle = forced ? null : collapsed ? (
    <IconButton size="sm" icon={PanelLeftOpen} label="Keep this column open" title={`Keep this column open  ${shortcut}`} onClick={() => setCollapsed("taskLeft", false)} />
  ) : (
    <IconButton size="sm" icon={PanelLeftClose} label="Collapse this column" title={`Collapse this column  ${shortcut}`} onClick={() => setCollapsed("taskLeft", true)} />
  );

  return (
    <div ref={ref} className={cx("task-left", collapsed && "is-collapsed")} {...handlers}>
      {collapsed && (
        <ExecutionRail
          people={people}
          helpers={helpers}
          ownerName={owner?.name ?? task.assignee}
          onExpand={forced ? undefined : () => setCollapsed("taskLeft", false)}
          onPeek={open}
        />
      )}
      <div ref={panelRef} className={cx("task-left-inner", peeking && "is-peeking")} tabIndex={collapsed ? -1 : undefined}>
        <ExecutionTree people={people} helpers={helpers} actions={toggle} />
        <EarlierChats agentId={task.assignee} agent={owner} shownChat={task.conversation_id} />
      </div>
    </div>
  );
}
