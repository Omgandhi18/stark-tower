import { Bot, History, PanelLeftOpen } from "lucide-react";
import { portraitKey, Portrait, Rail, RailButton, RailDivider } from "../../design";
import { PANEL_SHORTCUT } from "../../app/panelShortcuts";
import { useNavigation } from "../../stores/navigation";
import type { Helper } from "./taskPresentation";
import type { ExecutionPerson } from "./useExecutionPeople";

/** A portrait on the rail, inside its 40px button. */
const AVATAR = 32;

interface ExecutionRailProps {
  people: readonly ExecutionPerson[];
  helpers: readonly Helper[];
  ownerName: string;
  /** Left out while the column can't open (beside the browser on a small window). */
  onExpand?: () => void;
  /** Bring the whole column out over the chat. */
  onPeek: (fromKeyboard: boolean) => void;
}

/**
 * The left column collapsed: everyone on the task as a portrait (one with a task of their own opens
 * it; the rest bring the column out), then the owner's earlier chats.
 */
export default function ExecutionRail({ people, helpers, ownerName, onExpand, onPeek }: ExecutionRailProps) {
  const openTask = useNavigation((s) => s.openTask);
  return (
    <Rail label="Who's working on this task, collapsed">
      {onExpand && <RailButton home icon={PanelLeftOpen} label="Expand this column" title={`Expand this column  ${PANEL_SHORTCUT.taskLeft}`} onClick={onExpand} />}
      <ul className="rail-list">
        {people.map(({ agent, agentId, role, line, current, opens }) => {
          const name = agent?.name ?? agentId;
          return (
            <li key={`${role}-${agentId}`}>
              <RailButton
                label={`${name}, ${role.toLowerCase()}: ${line}`}
                title={`${name} · ${role}\n${line}`}
                current={current}
                home={!onExpand && current}
                onClick={(fromKeyboard) => (opens ? openTask(opens) : onPeek(fromKeyboard))}
              >
                <Portrait name={name} figure={portraitKey(agent)} accent={agent?.accent} size={AVATAR} status={agent?.status} />
              </RailButton>
            </li>
          );
        })}
        {helpers.map((helper, i) => (
          <li key={`${helper.at}-${i}`}>
            <RailButton icon={Bot} label={`Helper: ${helper.description}`} onClick={onPeek} />
          </li>
        ))}
      </ul>
      <RailDivider />
      <RailButton icon={History} label={`Earlier with ${ownerName}`} onClick={onPeek} />
    </Rail>
  );
}
