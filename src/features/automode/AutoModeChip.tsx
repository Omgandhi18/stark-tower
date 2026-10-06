import { FastForward, ShieldCheck } from "lucide-react";
import { Popover } from "../../design";
import { selectThread, useChats } from "../../stores/chats";
import Chip from "../conversation/ComposerChip";
import AutoModeSwitch from "./AutoModeSwitch";
import { useAutoModeOf } from "./autoMode";

/** Under the message box: whether this conversation asks first or runs in auto mode. */
export default function AutoModeChip({ agentId, agentName }: { agentId: string; agentName: string }) {
  const conversationId = useChats((s) => selectThread(agentId)(s).conversationId);
  const on = useAutoModeOf(conversationId);
  if (conversationId === null || on === undefined) return null;

  return (
    <Popover
      label={`Permissions in this conversation with ${agentName}`}
      className="chip-popover auto-mode-popover"
      trigger={(p) => (
        <Chip
          trigger={p}
          icon={on ? FastForward : ShieldCheck}
          text={on ? "Auto mode" : "Ask first"}
          title={`What ${agentName} may do without asking you`}
          className={on ? "is-auto" : undefined}
        />
      )}
    >
      {() => <AutoModeSwitch conversationId={conversationId} />}
    </Popover>
  );
}
