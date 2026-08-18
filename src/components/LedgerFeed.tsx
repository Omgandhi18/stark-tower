import type { LedgerEntry } from "../lib/types";

interface Props {
  entries: LedgerEntry[];
}

const KIND_COLOR: Record<string, string> = {
  route: "#4fd0ff",
  spawn: "#7cf5c4",
  task: "#ffd166",
  containment: "#ff4d4d",
};

function timeStr(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default function LedgerFeed({ entries }: Props) {
  return (
    <div className="ledger">
      <div className="ledger-head">REACTOR LEDGER</div>
      <div className="ledger-body">
        {entries.length === 0 && (
          <div className="ledger-empty">No activity yet.</div>
        )}
        {entries.map((e) => (
          <div key={e.id} className="ledger-row">
            <span className="ledger-time">{timeStr(e.ts)}</span>
            <span
              className="ledger-kind"
              style={{ color: KIND_COLOR[e.kind] ?? "#5f7796" }}
            >
              {e.kind}
            </span>
            <span className="ledger-detail">{e.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
