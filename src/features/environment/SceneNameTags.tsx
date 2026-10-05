import { cx } from "../../design";
import { worldToScreen, type Camera, type Point, type Size } from "../../environment/reference/camera";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent } from "../../lib/types";

export interface NameTagPlace {
  slotId: string;
  /** The tag's top-left, world px. */
  at: Point;
}

interface SceneNameTagsProps {
  places: readonly NameTagPlace[];
  seats: ReadonlyMap<string, Agent>;
  /** Agents with a question, approval or review waiting on the developer. */
  waitingOnYou: ReadonlySet<string>;
  camera: Camera;
  view: Size;
}

/** Each seated agent's name, role and state beside them, as the cafe's mockup labels its team. */
export default function SceneNameTags({ places, seats, waitingOnYou, camera, view }: SceneNameTagsProps) {
  return places.map(({ slotId, at }) => {
    const agent = seats.get(slotId);
    if (!agent) return null;
    const position = worldToScreen(at, camera, view);
    const tone = waitingOnYou.has(agent.id) ? "attention" : AGENT_STATUS[agent.status].tone;
    // The hotspot under each character already names them to assistive tech.
    return (
      <div key={slotId} className="scene-tag" style={{ left: position.x, top: position.y }} aria-hidden>
        <span className={cx("scene-tag-dot", `tone-${tone}`)} />
        <span className="scene-tag-name">{agent.name}</span>
        <span className="scene-tag-role">{agent.role}</span>
      </div>
    );
  });
}
