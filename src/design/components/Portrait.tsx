import { cx } from "../cx";
import { portraitUrl } from "../portraits";
import { AGENT_STATUS } from "../../lib/status";
import type { AgentStatus } from "../../lib/types";

export type PortraitSize = 24 | 32 | 40 | 48 | 64;

interface PortraitProps {
  name: string;
  figure?: string | null;
  size?: PortraitSize;
  /** Shows a small state dot; the state is also stated in text nearby. */
  status?: AgentStatus;
  /** The agent's own colour, used for the initials fallback. */
  accent?: string | null;
  className?: string;
}

const initialsOf = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

export function Portrait({ name, figure, size = 40, status, accent, className }: PortraitProps) {
  const url = portraitUrl(figure);
  return (
    <span
      className={cx("portrait", className)}
      style={{ width: size, height: size, fontSize: size, ["--portrait-accent" as string]: accent ?? undefined }}
      aria-hidden
    >
      {url ? <img src={url} alt="" draggable={false} /> : <span className="portrait-initials">{initialsOf(name)}</span>}
      {status && <span className={cx("portrait-dot", `tone-${AGENT_STATUS[status].tone}`)} />}
    </span>
  );
}
