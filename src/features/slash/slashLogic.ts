// The slash menu's logic: find the "/command" being typed, rank and group what an agent can
// run, and say how each MCP server is doing.
import { CircleAlert, CircleCheck, CircleDashed, CircleSlash, KeyRound, LoaderCircle, type LucideIcon } from "lucide-react";
import type { StateTone } from "../../lib/status";
import type { McpServer, McpStatus, SlashItem, SlashSource } from "../../lib/types";

export interface SlashQuery {
  /** What follows the slash. */
  query: string;
}

/** The most commands shown at once; typing narrows the rest. */
const MENU_LIMIT = 150;

/** Command names: letters, digits and the separators plugins and MCP servers use. */
const COMMAND_CHARS = /^[\p{L}\p{N}_:.-]*$/u;

/** Opens the MCP servers view instead of inserting a command. */
export const MCP_ENTRY: SlashItem = {
  name: "mcp",
  description: "See this agent's MCP servers and whether they're connected",
  hint: "",
  kind: "builtin",
  source: "provider",
  origin: "",
};

export const isMcpEntry = (item: SlashItem) => item === MCP_ENTRY;

/** The `/token` at the start of the message, when the caret is still inside it. */
export function detectSlash(text: string, caret: number): SlashQuery | null {
  if (!text.startsWith("/")) return null;
  const token = text.slice(1, caret);
  return caret >= 1 && COMMAND_CHARS.test(token) && !/\s/.test(text.slice(0, caret)) ? { query: token } : null;
}

/** Whether a message opens with a command (`/review`, `/sarathi:review the diff`), as the agent will see it. */
export const startsWithCommand = (text: string) => /^\/[\p{L}\p{N}_:.-]+(?:\s|$)/u.test(text);

/** Replace the typed command with the chosen one, ready for arguments. */
export function insertCommand(name: string) {
  const text = `/${name} `;
  return { text, caret: text.length };
}

/** `/mcp` on its own opens the servers view rather than asking the agent. */
export const isMcpRequest = (text: string) => text.trim().toLowerCase() === "/mcp";

function score(item: SlashItem, q: string): number {
  const name = item.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  // "review" finds "sarathi:review": the part after the plugin's name.
  if (name.split(/[:_]/).some((part) => part.startsWith(q))) return 2;
  if (name.includes(q)) return 3;
  return item.description.toLowerCase().includes(q) ? 4 : -1;
}

/** Best matches first, keeping the catalog's order (project, personal, plugins, …) among equals. */
export function rankCommands(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.toLowerCase();
  if (!q) return items.slice(0, MENU_LIMIT);
  return items
    .map((item, order) => ({ item, order, rank: score(item, q) }))
    .filter((r) => r.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, MENU_LIMIT)
    .map((r) => r.item);
}

export interface SlashGroup {
  key: string;
  label: string;
  /** Each item with its place in the whole list, for the keyboard. */
  entries: { item: SlashItem; index: number }[];
}

const SOURCE_LABEL: Record<SlashSource, string> = {
  project: "This project",
  user: "Yours",
  plugin: "Plugin",
  synced: "From claude.ai",
  mcp: "MCP server",
  provider: "Built in",
};

export const groupLabel = (item: SlashItem) => {
  const base = SOURCE_LABEL[item.source];
  return item.origin ? `${base} · ${item.origin}` : base;
};

/** Consecutive matches from the same place share a heading, in the order they were ranked. */
export function groupCommands(ranked: readonly SlashItem[]): SlashGroup[] {
  const groups: SlashGroup[] = [];
  ranked.forEach((item, index) => {
    const key = `${item.source}:${item.origin}`;
    const last = groups[groups.length - 1];
    if (last?.key === key) last.entries.push({ item, index });
    else groups.push({ key, label: groupLabel(item), entries: [{ item, index }] });
  });
  return groups;
}

/** The DOM id of a menu option, for aria-activedescendant. */
export const optionId = (listId: string, index: number) => `${listId}-${index}`;

export interface ServerPresentation {
  label: string;
  tone: StateTone;
  icon: LucideIcon;
  /** Still working on it: the icon spins. */
  live: boolean;
}

const STATUS: Record<McpStatus, ServerPresentation> = {
  connected: { label: "Connected", tone: "success", icon: CircleCheck, live: false },
  pending: { label: "Connecting…", tone: "running", icon: LoaderCircle, live: true },
  failed: { label: "Failed", tone: "danger", icon: CircleAlert, live: false },
  "needs-auth": { label: "Needs sign-in", tone: "attention", icon: KeyRound, live: false },
  disabled: { label: "Off", tone: "idle", icon: CircleSlash, live: false },
  unknown: { label: "Not started yet", tone: "idle", icon: CircleDashed, live: false },
};

export const serverStatus = (status: McpStatus) => STATUS[status];

/** How many servers want the developer's attention (failed, or waiting on a sign-in). */
export const serversNeedingAttention = (servers: readonly McpServer[]) => servers.filter((s) => s.status === "failed" || s.status === "needs-auth").length;

export const toolCount = (server: McpServer) => (server.tools === null ? null : `${server.tools} ${server.tools === 1 ? "tool" : "tools"}`);
