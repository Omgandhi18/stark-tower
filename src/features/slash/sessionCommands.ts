// Commands that would swap, reset or end an agent's session behind Starkline's back. The backend
// refuses to send them (src-tauri/src/slash/mod.rs keeps the same lists); here they are answered
// before they get that far: `/clear` starts a new chat, the rest say why they aren't sent.
import type { SlashItem } from "../../lib/types";

/** Start over: Claude Code's `/clear` and its aliases, OpenCode's `/new`. */
const NEW_CHAT_COMMANDS: readonly string[] = ["clear", "reset", "new"];

/** Swap, rewind or end the session: Claude Code's and OpenCode's `/resume`, `/branch`, `/rewind`, `/undo`, `/exit` and their aliases. */
const BLOCKED_COMMANDS: readonly string[] = ["resume", "continue", "sessions", "branch", "rewind", "checkpoint", "undo", "redo", "exit", "quit", "background", "bg"];

/** The command a message opens with, as `startsWithCommand` reads it. */
const LEADING_COMMAND = /^\/([\p{L}\p{N}_:.-]+)(?:\s|$)/u;

export type SessionCommand = { kind: "new-chat" } | { kind: "blocked"; name: string };

/** What Starkline does with a message that opens with a session-swapping command; null for any other message. */
export function sessionCommandOf(text: string): SessionCommand | null {
  const name = LEADING_COMMAND.exec(text.trimStart())?.[1];
  if (!name) return null;
  const lower = name.toLowerCase();
  if (NEW_CHAT_COMMANDS.includes(lower)) return { kind: "new-chat" };
  return BLOCKED_COMMANDS.includes(lower) ? { kind: "blocked", name } : null;
}

/** Why a blocked command wasn't sent. */
export const blockedNotice = (name: string) => `/${name} would change or end this chat's session behind Starkline's back, so it isn't sent.`;

/** The menu's own "/clear": a built-in of Starkline's, offered for every engine. */
export const newChatEntry = (agentName: string): SlashItem => ({
  name: "clear",
  description: `Start a new chat with ${agentName}`,
  hint: "",
  kind: "builtin",
  source: "provider",
  origin: "",
});

/** Whether a menu item is that entry (an engine's own `/clear` never reaches the menu). */
export const isNewChatEntry = (item: SlashItem) => item.name === "clear" && item.source === "provider";
