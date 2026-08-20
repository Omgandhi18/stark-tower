import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Bug as BugIcon, Wrench } from "lucide-react";
import type { Bug } from "../lib/types";
import { getBugs, setBugStatus, runMaintenance, onBugsChanged } from "../lib/api";

const NEXT: Record<string, string> = {
  open: "wontfix",
  doing: "fixed",
  fixed: "open",
  wontfix: "open",
};

/** Bugs agents reported about the app. "Fix with DUM-E" hands the open ones to
 *  the maintenance agent; click a status pill to cycle it. */
export default function BugsPanel({
  onOpenAgent,
}: {
  onOpenAgent: (id: string) => void;
}) {
  const [bugs, setBugs] = useState<Bug[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const reload = () => {
      getBugs().then(setBugs).catch(() => {});
    };
    reload();
    const unsub = onBugsChanged(reload);
    return () => {
      unsub.then((f) => f());
    };
  }, []);

  const openCount = bugs.filter((b) => b.status === "open" || b.status === "doing").length;
  if (bugs.length === 0) return null;

  const fixAll = () => {
    runMaintenance()
      .then(() => onOpenAgent("dum-e"))
      .catch(() => {});
  };

  return (
    <div className={`ov ov-bugs glass ${open ? "open" : ""}`}>
      <button className="ov-roster-head" onClick={() => setOpen((o) => !o)}>
        <span className="label">
          <BugIcon size={12} style={{ marginRight: 5, verticalAlign: "-2px" }} />
          Bugs
        </span>
        <span className="ov-roster-meta">
          <span className="label">{openCount} open</span>
          <span className="chev">
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </span>
      </button>
      {open && (
        <div className="bugs-list">
          {openCount > 0 && (
            <button className="bugs-fix" onClick={fixAll}>
              <Wrench size={13} /> Fix {openCount} with DUM-E
            </button>
          )}
          {bugs.map((b) => (
            <div key={b.id} className={`bug-row bug-${b.status}`}>
              <button
                className={`bug-status bug-status-${b.status}`}
                onClick={() => setBugStatus(b.id, NEXT[b.status] ?? "open").catch(() => {})}
                title="Click to change status"
              >
                {b.status}
              </button>
              <span className="bug-title" title={b.detail || b.title}>
                {b.title}
              </span>
              <span className="bug-reporter">{b.reporter.toUpperCase()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
