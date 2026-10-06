import type { CSSProperties } from "react";
import { portraitKey, Portrait, cx } from "../../design";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent } from "../../lib/types";
import { useActivity } from "../../stores/activity";
import { isQuestion, useAttention } from "../../stores/attention";

export const SCENE_CARD_WIDTH = 248;
/** Height used to keep the card inside the view (one line of activity). */
export const SCENE_CARD_HEIGHT = 64;
/** A card docked in the room's corner has room for the agent's portrait, role and what they're doing. */
const DOCKED_CARD_WIDTH = 320;

interface SceneAgentCardProps {
  agent: Agent;
  /** Where the card sits in the room: beside the agent, or docked in a corner. */
  placement: CSSProperties;
  docked?: boolean;
}

/** Who an agent is and what they're doing, beside them or in the room's corner. */
export default function SceneAgentCard({ agent, placement, docked = false }: SceneAgentCardProps) {
  const activity = useActivity((s) => s.latest[agent.id]);
  const waiting = useAttention((s) => s.pending.some((r) => r.agentId === agent.id && isQuestion(r)));
  const status = AGENT_STATUS[agent.status];
  const doing = waiting ? "Waiting for your answer" : status.busy && activity ? activity.summary : null;
  const state = <span className={cx("scene-card-state", `tone-${status.tone}`)}>{status.label}</span>;

  if (docked) {
    return (
      <div className="scene-card is-docked" role="status" style={{ ...placement, width: DOCKED_CARD_WIDTH }}>
        <Portrait name={agent.name} figure={portraitKey(agent)} accent={agent.accent} size={64} status={agent.status} />
        <span className="scene-card-text">
          <span className="scene-card-head">
            <span className="scene-card-name">{agent.name}</span>
            {state}
          </span>
          <span className="scene-card-role">{agent.role}</span>
          {doing && <span className={cx("scene-card-line", waiting && "is-waiting")}>{doing}</span>}
        </span>
      </div>
    );
  }
  return (
    <div className="scene-card" role="status" style={{ ...placement, width: SCENE_CARD_WIDTH }}>
      <Portrait name={agent.name} figure={portraitKey(agent)} accent={agent.accent} size={32} status={agent.status} />
      <span className="scene-card-text">
        <span className="scene-card-head">
          <span className="scene-card-name">{agent.name}</span>
          {state}
        </span>
        <span className={cx("scene-card-line", waiting && "is-waiting")}>{doing ?? agent.role}</span>
      </span>
    </div>
  );
}
