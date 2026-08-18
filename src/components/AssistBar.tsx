import { useEffect, useState } from "react";
import type { Agent } from "../lib/types";
import { requestAssist } from "../lib/api";

interface Props {
  agents: Agent[];
  selectedId: string | null;
  onAssisted: (toId: string) => void;
}

/**
 * Agent-to-agent help. The selected agent pulls another agent into its project
 * to assist — the helper joins the same working directory and gets context.
 */
export default function AssistBar({ agents, selectedId, onAssisted }: Props) {
  const selected = agents.find((a) => a.id === selectedId) ?? null;
  const others = agents.filter((a) => a.id !== selectedId);

  const [target, setTarget] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (others.length && !others.find((a) => a.id === target)) {
      setTarget(others[0].id);
    }
  }, [selectedId, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!selected) return null;

  const send = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await requestAssist(selected.id, target, note.trim(), 100, 28);
      setNote("");
      onAssisted(target);
    } catch {
      /* surfaced in ledger */
    } finally {
      setBusy(false);
    }
  };

  const targetAgent = others.find((a) => a.id === target);

  return (
    <div className="assist-bar">
      <span className="assist-lead">
        <span className="assist-icon">⇄</span>
        <b style={{ color: selected.accent }}>{selected.name}</b> pulls in
      </span>
      <select
        className="assist-select"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        style={{ color: targetAgent?.accent }}
      >
        {others.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} — {a.role}
          </option>
        ))}
      </select>
      <input
        className="assist-note"
        placeholder="what do you need help with? (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") send();
        }}
      />
      <button className="assist-send" onClick={send} disabled={busy}>
        {busy ? "…" : "Request help"}
      </button>
    </div>
  );
}
