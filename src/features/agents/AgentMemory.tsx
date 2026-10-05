import { useCallback, useEffect, useState } from "react";
import { BookOpen, RefreshCw } from "lucide-react";
import { Button, EmptyState, Markdown, SkeletonRows } from "../../design";
import { getMemory } from "../../lib/api";
import { errorMessage } from "../../lib/errors";

type MemoryState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; message: string };

/** What the agent has chosen to remember across sessions (it curates this itself). */
export default function AgentMemory({ agentId, name }: { agentId: string; name: string }) {
  const [memory, setMemory] = useState<MemoryState>({ status: "loading" });

  const load = useCallback(() => {
    setMemory({ status: "loading" });
    getMemory(agentId)
      .then((text) => setMemory({ status: "ready", text }))
      .catch((e) => setMemory({ status: "error", message: errorMessage(e, "The memory file couldn't be read.") }));
  }, [agentId]);

  useEffect(() => {
    let live = true;
    getMemory(agentId)
      .then((text) => live && setMemory({ status: "ready", text }))
      .catch((e) => live && setMemory({ status: "error", message: errorMessage(e, "The memory file couldn't be read.") }));
    return () => {
      live = false;
    };
  }, [agentId]);

  return (
    <div className="agent-memory">
      <div className="agent-memory-bar">
        <p className="agent-memory-note">Notes {name} keeps for itself between sessions. It edits them as it learns.</p>
        <Button size="sm" variant="ghost" icon={RefreshCw} onClick={load} disabled={memory.status === "loading"}>
          Reload
        </Button>
      </div>
      {memory.status === "loading" && <SkeletonRows rows={2} label="Loading memory" />}
      {memory.status === "error" && (
        <p className="agent-memory-error" role="alert">
          {memory.message}
        </p>
      )}
      {memory.status === "ready" &&
        (memory.text.trim() ? (
          <Markdown text={memory.text} className="agent-memory-text" />
        ) : (
          <EmptyState compact icon={BookOpen} title="Nothing remembered yet" body={`${name} hasn't written anything down so far.`} />
        ))}
    </div>
  );
}
