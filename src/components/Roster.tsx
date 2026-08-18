import {
  Circle,
  CircleDot,
  Loader2,
  Zap,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import type { Agent, AgentStatus } from "../lib/types";
import { STATUS_META } from "../lib/theme";
import Avatar from "./Avatar";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_ICON: Record<AgentStatus, LucideIcon> = {
  offline: Circle,
  idle: CircleDot,
  thinking: Loader2,
  working: Zap,
  blocked: ShieldAlert,
};

export default function Roster({ agents, selectedId, onSelect }: Props) {
  return (
    <div className="roster">
      {agents.map((a) => {
        const meta = STATUS_META[a.status];
        const Icon = STATUS_ICON[a.status];
        return (
          <button
            key={a.id}
            className={`roster-row ${a.id === selectedId ? "selected" : ""}`}
            onClick={() => onSelect(a.id)}
          >
            <Avatar agent={a} size={26} />
            <span className="roster-main">
              <span className="roster-name">{a.name}</span>
              <span className="roster-role">{a.role}</span>
            </span>
            <span className="roster-status" style={{ color: meta.color }}>
              <Icon
                size={12}
                strokeWidth={2.25}
                className={a.status === "thinking" ? "spin" : ""}
              />
              {meta.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
