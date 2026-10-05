import { Portrait, cx } from "../../design";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent } from "../../lib/types";
import { useActivity } from "../../stores/activity";
import { isQuestion, useAttention } from "../../stores/attention";

export const SCENE_CARD_WIDTH = 248;
/** Height used to keep the card inside the view (one line of activity). */
export const SCENE_CARD_HEIGHT = 64;

interface SceneAgentCardProps {
  agent: Agent;
  left: number;
  top: number;
}

/** Who an agent is and what they're doing, floating beside them in the room. */
export default function SceneAgentCard({ agent, left, top }: SceneAgentCardProps) {
  const activity = useActivity((s) => s.latest[agent.id]);
  const waiting = useAttention((s) => s.pending.some((r) => r.agentId === agent.id && isQuestion(r)));
  const status = AGENT_STATUS[agent.status];
  const line = waiting ? "Waiting for your answer" : status.busy && activity ? activity.summary : agent.role;
  return (
    <div className="scene-card" role="status" style={{ left, top, width: SCENE_CARD_WIDTH }}>
      <Portrait name={agent.name} figure={agent.figure} accent={agent.accent} size={32} status={agent.status} />
      <span className="scene-card-text">
        <span className="scene-card-head">
          <span className="scene-card-name">{agent.name}</span>
          <span className={cx("scene-card-state", `tone-${status.tone}`)}>{status.label}</span>
        </span>
        <span className={cx("scene-card-line", waiting && "is-waiting")}>{line}</span>
      </span>
    </div>
  );
}
