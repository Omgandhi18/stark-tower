import { useState } from "react";
import type { Agent } from "../lib/types";

interface Props {
  agent: Agent;
  size?: number;
}

/** Agent avatar from /avatars/<id>.png, falling back to an accent disc. */
export default function Avatar({ agent, size = 30 }: Props) {
  const [failed, setFailed] = useState(false);

  const style = {
    width: size,
    height: size,
    boxShadow: `0 0 8px ${agent.accent}`,
    borderColor: agent.accent,
  };

  if (failed) {
    return (
      <span
        className="avatar avatar-fallback"
        style={{ ...style, background: agent.accent }}
      >
        {agent.name.slice(0, 1)}
      </span>
    );
  }

  return (
    <img
      className="avatar"
      style={style}
      src={`/avatars/${agent.id}.png`}
      alt={agent.name}
      onError={() => setFailed(true)}
    />
  );
}
