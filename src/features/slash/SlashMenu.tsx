import { useEffect, useRef } from "react";
import { ArrowLeft, MessageSquarePlus, Plug, RefreshCw, Server, Sparkles, SquareSlash, Terminal, type LucideIcon } from "lucide-react";
import { IconButton, StatusPill, Tag, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import type { McpServer, SlashCatalog, SlashItem, SlashKind } from "../../lib/types";
import { isNewChatEntry } from "./sessionCommands";
import { groupCommands, isMcpEntry, optionId, serverStatus, toolCount } from "./slashLogic";
import "./slash.css";

export type SlashView = "commands" | "servers";

const KIND_ICON: Record<SlashKind, LucideIcon> = {
  skill: Sparkles,
  command: SquareSlash,
  prompt: Plug,
  builtin: Terminal,
};

const KIND_NAME: Record<SlashKind, string> = {
  skill: "Skill",
  command: "Command",
  prompt: "MCP prompt",
  builtin: "Built in",
};

interface SlashMenuProps {
  id: string;
  view: SlashView;
  agentName: string;
  /** Null until the first answer arrives. */
  catalog: SlashCatalog | null;
  loading: boolean;
  /** The matches for what's been typed, best first. */
  options: readonly SlashItem[];
  highlight: number;
  /** The chat has a running session that can be asked for its servers' status. */
  canRefresh: boolean;
  onPick: (item: SlashItem) => void;
  onHighlight: (index: number) => void;
  onBack: () => void;
  onRefresh: () => void;
}

/** What the agent can run, as you type "/" at the start of a message; or, from "/mcp", its MCP servers. */
export default function SlashMenu(props: SlashMenuProps) {
  return (
    <div className="slash-menu">
      {props.view === "servers" ? <ServersView {...props} /> : <CommandsView {...props} />}
    </div>
  );
}

function CommandsView({ id, agentName, catalog, loading, options, highlight, onPick, onHighlight }: SlashMenuProps) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(".is-highlighted")?.scrollIntoView({ block: "nearest" });
  }, [highlight, options]);

  const groups = groupCommands(options);
  return (
    <>
      <div className="slash-head">
        <span>{agentName}&rsquo;s commands</span>
        {loading && !catalog ? <span className="slash-head-note">Looking…</span> : catalog && !catalog.live && <span className="slash-head-note">Full list once this chat starts</span>}
      </div>
      {options.length === 0 ? (
        <p className="slash-note">Looking for what {agentName} can run…</p>
      ) : (
        <ul id={id} ref={listRef} role="listbox" aria-label={`${agentName}'s commands`} className="slash-list">
          {groups.map((group) => (
            <li key={group.key} role="presentation" className="slash-group">
              <span className="slash-group-label" aria-hidden>
                {group.label}
              </span>
              <ul role="presentation" className="slash-group-items">
                {group.entries.map(({ item, index }) => {
                  const Icon = isMcpEntry(item) ? Server : isNewChatEntry(item) ? MessageSquarePlus : KIND_ICON[item.kind];
                  return (
                    <li
                      key={`${item.source}:${item.origin}:${item.name}`}
                      id={optionId(id, index)}
                      role="option"
                      aria-selected={index === highlight}
                      title={`${KIND_NAME[item.kind]} · ${group.label}`}
                      className={cx("slash-option", index === highlight && "is-highlighted")}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onPick(item);
                      }}
                      onMouseEnter={() => onHighlight(index)}
                    >
                      <Icon aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="slash-option-icon" />
                      <span className="slash-option-name">/{item.name}</span>
                      {item.hint && <span className="slash-option-hint">{item.hint}</span>}
                      <span className="slash-option-description">{item.description}</span>
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  user: "Yours",
  project: "This project",
  local: "This project, just you",
  plugin: "Plugin",
  "built-in": "Built in",
  "claude.ai": "claude.ai",
};

function ServerRow({ server }: { server: McpServer }) {
  const state = serverStatus(server.status);
  const tools = toolCount(server);
  return (
    <li className="slash-server">
      <div className="slash-server-line">
        <Server aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="slash-option-icon" />
        <span className="slash-server-name">{server.name}</span>
        {server.source && <Tag>{SOURCE_LABEL[server.source] ?? server.source}</Tag>}
        {server.transport && <span className="slash-server-meta">{server.transport}</span>}
        <span className="slash-server-spacer" aria-hidden />
        {tools && server.status !== "failed" && <span className="slash-server-meta">{tools}</span>}
        <StatusPill label={state.label} tone={state.tone} icon={state.icon} live={state.live} />
      </div>
      {server.error && <p className="slash-server-error">{server.error}</p>}
    </li>
  );
}

function ServersView({ agentName, catalog, canRefresh, onBack, onRefresh }: SlashMenuProps) {
  const servers = catalog?.servers ?? [];
  return (
    <>
      <div className="slash-head">
        <span className="slash-head-title">
          <IconButton
            icon={ArrowLeft}
            label="Back to commands"
            size="sm"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onBack}
          />
          MCP servers
        </span>
        {canRefresh && catalog?.live && (
          <IconButton icon={RefreshCw} label="Check again" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={onRefresh} />
        )}
      </div>
      {servers.length === 0 ? (
        <p className="slash-note">{catalog ? `${agentName} has no MCP servers set up.` : "Looking…"}</p>
      ) : (
        <ul className="slash-list slash-servers" aria-label={`${agentName}'s MCP servers`}>
          {servers.map((server) => (
            <ServerRow key={`${server.source}:${server.name}`} server={server} />
          ))}
        </ul>
      )}
      <p className="slash-foot">
        {catalog?.live ? "Status as this chat's session reports it." : "They start with this chat's first message."} Add or remove servers in the agent&rsquo;s own setup.
      </p>
    </>
  );
}
