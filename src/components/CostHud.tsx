import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { onUsageUpdate } from "../lib/api";

const CONTEXT_LIMIT = 200_000; // approx. model context window, for the fill bar

interface Usage {
  cost: number;
  ctx: number;
}

/**
 * Live cost / context HUD. Accumulates each agent's spend from `usage://update`
 * (emitted on every result) and shows the latest context-window fill.
 */
export default function CostHud() {
  const [usage, setUsage] = useState<Record<string, Usage>>({});
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const unsub = onUsageUpdate((u) => {
      setUsage((prev) => ({
        ...prev,
        [u.agentId]: {
          cost: (prev[u.agentId]?.cost ?? 0) + u.costUsd,
          ctx: u.contextTokens,
        },
      }));
    });
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  const rows = Object.entries(usage);
  const total = rows.reduce((sum, [, u]) => sum + u.cost, 0);
  if (rows.length === 0) return null;

  return (
    <div className={`ov ov-cost glass ${open ? "open" : ""}`}>
      <button className="ov-roster-head" onClick={() => setOpen((o) => !o)}>
        <span className="label">Cost</span>
        <span className="ov-roster-meta">
          <span className="label">${total.toFixed(2)}</span>
          <span className="chev">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
      </button>
      {open && (
        <div className="cost-list">
          {rows
            .sort((a, b) => b[1].cost - a[1].cost)
            .map(([id, u]) => {
              const pct = Math.min(100, Math.round((u.ctx / CONTEXT_LIMIT) * 100));
              return (
                <div key={id} className="cost-row">
                  <span className="cost-name">{id.toUpperCase()}</span>
                  <span className="cost-usd">${u.cost.toFixed(3)}</span>
                  <span className="cost-ctx" title={`${u.ctx.toLocaleString()} tokens`}>
                    <span className="cost-bar">
                      <span
                        className={`cost-fill ${pct >= 85 ? "hot" : ""}`}
                        style={{ width: `${pct}%` }}
                      />
                    </span>
                    <span className="cost-pct">{pct}%</span>
                  </span>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
}
