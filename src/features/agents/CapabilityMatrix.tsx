import { cx } from "../../design";
import type { Capability, ProviderCapabilities, Support } from "../../lib/types";

const ROWS: ReadonlyArray<{ key: keyof Omit<ProviderCapabilities, "kind" | "label">; label: string }> = [
  { key: "resume", label: "Resume a chat later" },
  { key: "events", label: "Live activity" },
  { key: "approvals", label: "Approvals through Starkline" },
  { key: "sandbox", label: "Sandboxed commands" },
  { key: "helpers", label: "Temporary helpers" },
  { key: "team_tools", label: "Delegate, ask you, message" },
];

const SUPPORT: Record<Support, { label: string; tone: string }> = {
  yes: { label: "Yes", tone: "tone-success" },
  limited: { label: "Limited", tone: "tone-attention" },
  no: { label: "No", tone: "tone-idle" },
};

/** The built-in providers side by side; the one in use shows why, row by row. */
export default function CapabilityMatrix({ providers, current }: { providers: readonly ProviderCapabilities[]; current: string }) {
  const shown = providers.filter((p) => p.kind !== "generic-cli" || p.kind === current);
  return (
    <table className="capability-table">
      <caption className="visually-hidden">What Starkline can do on each provider</caption>
      <thead>
        <tr>
          <th scope="col">Capability</th>
          {shown.map((p) => (
            <th key={p.kind} scope="col" className={cx(p.kind === current && "is-current")}>
              {p.label}
              {p.kind === current && <span className="capability-current">In use</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.key}>
            <th scope="row">{row.label}</th>
            {shown.map((p) => {
              const cell: Capability = p[row.key];
              const support = SUPPORT[cell.support];
              return (
                <td key={p.kind} className={cx(p.kind === current && "is-current")} title={cell.note}>
                  <span className={cx("capability-support", support.tone)}>{support.label}</span>
                  {p.kind === current && <span className="capability-note">{cell.note}</span>}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
