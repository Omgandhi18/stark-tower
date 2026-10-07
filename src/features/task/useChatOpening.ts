import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/errors";
import { useNavigation } from "../../stores/navigation";
import { agentChatTask } from "../conversation/chatActions";

interface Failure {
  agentId: string;
  attempt: number;
  message: string;
}

/** While an agent's chat is asked for, find the task it runs as and show that. Says why if it can't. */
export function useChatOpening(agentId: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);

  useEffect(() => {
    if (!agentId) return;
    let current = true;
    agentChatTask(agentId)
      .then((taskId) => {
        // Going somewhere else meanwhile drops the request, so the chat can't pull you back.
        const navigation = useNavigation.getState();
        if (current && navigation.chatAgent === agentId) navigation.openTask(taskId);
      })
      .catch((e) => {
        if (current) setFailure({ agentId, attempt, message: errorMessage(e, "The chat couldn't be opened.") });
      });
    return () => {
      current = false;
    };
  }, [agentId, attempt]);

  const error = failure && failure.agentId === agentId && failure.attempt === attempt ? failure.message : null;
  return { error, retry: () => setAttempt((n) => n + 1) };
}
