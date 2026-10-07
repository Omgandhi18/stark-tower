import { BookOpen } from "lucide-react";
import { IconButton, Popover, cx } from "../../design";
import { useMemoryNotes } from "../../stores/memoryNotes";
import AgentMemory from "./AgentMemory";
import "./agents.css";

/** A quiet way to see what an agent remembers between sessions; a dot says it changed since you last looked. */
export default function MemoryButton({ agentId, name }: { agentId: string; name: string }) {
  const updated = useMemoryNotes((s) => Boolean(s.updated[agentId]));
  const label = updated ? `${name}'s memory, updated` : `${name}'s memory`;
  return (
    <Popover
      label={`${name}'s memory`}
      align="end"
      className="memory-popover"
      trigger={(p) => (
        <IconButton
          {...p}
          icon={BookOpen}
          label={label}
          className={cx("memory-button", updated && "has-update")}
          aria-haspopup="dialog"
          onClick={() => {
            useMemoryNotes.getState().seen(agentId);
            p.onClick();
          }}
        />
      )}
    >
      {() => (
        // Focus goes in at once (Reload waits for the notes), so Escape closes it.
        <div className="memory-popover-body" tabIndex={-1} data-autofocus>
          <AgentMemory agentId={agentId} name={name} />
        </div>
      )}
    </Popover>
  );
}
