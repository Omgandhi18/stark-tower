import type { Agent } from "../lib/types";

interface Props {
  agents: Agent[];
  contained: boolean;
}

/** Arc-reactor load gauge: how much of the tower is actively drawing power. */
export default function ReactorMeter({ agents, contained }: Props) {
  const online = agents.filter((a) => a.status !== "offline").length;
  const busy = agents.filter(
    (a) => a.status === "working" || a.status === "thinking",
  ).length;
  const pct = agents.length ? Math.round((busy / agents.length) * 100) : 0;

  return (
    <div className={`reactor-meter ${contained ? "tripped" : ""}`}>
      <div className="rm-core" />
      <div className="rm-stats">
        <div className="rm-line">
          <span className="rm-label">REACTOR LOAD</span>
          <span className="rm-val">{pct}%</span>
        </div>
        <div className="rm-bar">
          <div className="rm-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="rm-sub">
          {online} online · {busy} active
          {contained && <span className="rm-alert"> · CONTAINMENT ACTIVE</span>}
        </div>
      </div>
    </div>
  );
}
