import { useEffect, useState } from "react";
import { ArrowLeft, FolderOpen, MessageSquarePlus, PanelRight, SquareTerminal } from "lucide-react";
import { Button, IconButton, Portrait, SelectField, StatusPill } from "../../design";
import { errorMessage } from "../../lib/errors";
import { formatTokens } from "../../lib/format";
import { AGENT_STATUS } from "../../lib/status";
import type { Agent } from "../../lib/types";
import { selectThread, useChats } from "../../stores/chats";
import { useConfig } from "../../stores/config";
import { useNavigation } from "../../stores/navigation";
import { usePreview } from "../../stores/preview";
import { useSpend } from "../../stores/spend";
import { useTerminal } from "../../stores/terminal";
import { reportedCost } from "../spend/spendModel";
import { useWorkspace } from "../../stores/workspace";
import { engineLabel } from "../agents/display";
import { startNewChat } from "./chatActions";
import ContextButton from "../context/ContextButton";
import { folderOptions } from "./folders";

/** Who you're talking to, where they work, and a fresh start. */
export default function ConversationHeader({ agent }: { agent: Agent }) {
  const navigate = useNavigation((s) => s.navigate);
  const config = useConfig((s) => s.config);
  const worktrees = useWorkspace((s) => s.worktrees);
  const projects = useWorkspace((s) => s.projects);
  const activeProject = useWorkspace((s) => s.activeProject);
  const chatFolder = useChats((s) => selectThread(agent.id)(s).folder);
  const conversationId = useChats((s) => selectThread(agent.id)(s).conversationId);
  const usage = useSpend((s) => conversationId === null ? undefined : s.chats[conversationId]);
  const revision = useSpend((s) => s.revision);
  useEffect(() => {
    if (conversationId !== null) void useSpend.getState().refreshChat(conversationId).catch(() => {});
  }, [conversationId, revision]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const terminalOpen = useTerminal((s) => s.open);
  const toggleTerminal = useTerminal((s) => s.toggle);
  const previewing = usePreview((s) => s.open);
  const togglePreview = usePreview((s) => s.toggle);
  const status = AGENT_STATUS[agent.status];
  const folder = chatFolder || activeProject;

  const newChat = async () => {
    setStarting(true);
    setError(null);
    try {
      await startNewChat(agent.id);
    } catch (e) {
      setError(errorMessage(e, "A new chat couldn't be started."));
    } finally {
      setStarting(false);
    }
  };

  return (
    <header className="conversation-header">
      <IconButton icon={ArrowLeft} label="Back to Work" onClick={() => navigate("work")} />
      <Portrait name={agent.name} figure={agent.figure} accent={agent.accent} size={40} status={agent.status} />
      <div className="conversation-who">
        <h1 className="conversation-name">{agent.name}</h1>
        <p className="conversation-role">
          {agent.role}
          <span aria-hidden> · </span>
          {engineLabel(agent.engine, config)}
        </p>
      </div>
      <StatusPill label={status.label} tone={status.tone} icon={status.icon} live={status.busy} />
      <div className="conversation-tools">
        {error && (
          <span className="conversation-error" role="alert">
            {error}
          </span>
        )}
        {usage && usage.total.turns > 0 && (
          <span className="conversation-usage" title="This conversation’s recorded cost and the latest context fill">
            {reportedCost(usage.total)} this chat, {formatTokens(usage.context_tokens)} context
          </span>
        )}
        <SelectField
          label="Works in"
          hideLabel
          icon={FolderOpen}
          value={folder}
          options={folderOptions(projects, folder, worktrees)}
          onChange={(path) => useChats.getState().setFolder(agent.id, path)}
          className="conversation-folder"
        />
        <ContextButton agentId={agent.id} name={agent.name} folder={folder} />
        <Button icon={MessageSquarePlus} disabled={starting} onClick={newChat}>
          New chat
        </Button>
        <IconButton icon={SquareTerminal} label="Terminal" aria-pressed={terminalOpen} onClick={toggleTerminal} />
        <IconButton icon={PanelRight} label={previewing ? "Hide the browser and simulator" : "Show the browser and simulator"} aria-pressed={previewing} onClick={togglePreview} />
      </div>
    </header>
  );
}
