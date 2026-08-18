import { useState } from "react";
import { dispatchTask } from "../lib/api";
import type { DispatchResult } from "../lib/types";

interface Props {
  onDispatched: (result: DispatchResult) => void;
}

/** JARVIS command line — type a task, JARVIS routes it to a free agent. */
export default function CommandCenter({ onDispatched }: Props) {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const send = async () => {
    const task = prompt.trim();
    if (!task || busy) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await dispatchTask(task, 100, 28);
      setPrompt("");
      setNote(
        `JARVIS routed to ${res.name}${res.spawned ? " (bringing online…)" : ""}`,
      );
      onDispatched(res);
    } catch (e) {
      setNote(typeof e === "string" ? e : "Dispatch failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="command-center">
      <div className="cc-prompt-label">
        <span className="cc-jarvis">JARVIS</span>
        <span className="cc-hint">— dispatch a task to the tower</span>
      </div>
      <div className="cc-input-row">
        <textarea
          className="cc-input"
          placeholder="e.g. Scaffold a REST endpoint for user auth and write tests…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
        />
        <button className="cc-send" onClick={send} disabled={busy}>
          {busy ? "Routing…" : "Dispatch"}
        </button>
      </div>
      {note && <div className="cc-note">{note}</div>}
    </div>
  );
}
