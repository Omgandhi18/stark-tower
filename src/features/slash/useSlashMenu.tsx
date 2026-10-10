import { useId, useMemo, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { slashRefreshMcp } from "../../lib/api";
import type { SlashItem } from "../../lib/types";
import SlashMenu, { type SlashView } from "./SlashMenu";
import { MCP_ENTRY, detectSlash, insertCommand, isMcpEntry, isMcpRequest, optionId, rankCommands, type SlashQuery } from "./slashLogic";
import { blockedNotice, isNewChatEntry, newChatEntry, sessionCommandOf } from "./sessionCommands";
import { useSlashCatalog } from "./useSlashCatalog";

interface SlashMenuOptions {
  agentId: string;
  agentName: string;
  /** The chat's conversation; null for a chat that hasn't started. */
  conversationId: number | null;
  folder: string;
  draft: string;
  setDraft: (text: string) => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** Off while the message answers a question rather than runs a command. */
  disabled: boolean;
  /** How many characters of the box come before `draft` (Work's "@agent " routing), for placing the caret. */
  caretOffset?: number;
  /** "/clear" (chosen or sent): start a new chat instead of reaching the agent. */
  onNewChat: () => void;
  /** A command that would swap the agent's session was sent: say why it wasn't. */
  onBlocked: (notice: string) => void;
}

/** The catalog's commands with Starkline's own "/clear" and "/mcp" just ahead of the provider's. */
function withOwnEntries(items: readonly SlashItem[], newChat: SlashItem): SlashItem[] {
  const at = items.findIndex((i) => i.source === "provider");
  const own = [newChat, MCP_ENTRY];
  return at < 0 ? [...items, ...own] : [...items.slice(0, at), ...own, ...items.slice(at)];
}

/**
 * The "/" menu for a chat composer. The composer feeds it the text and caret as they change and
 * the key presses first; it answers whether it handled one, and gives back the popup to show.
 */
export function useSlashMenu({ agentId, agentName, conversationId, folder, draft, setDraft, inputRef, disabled, caretOffset = 0, onNewChat, onBlocked }: SlashMenuOptions) {
  const listId = useId();
  const { catalog, status, request, reload } = useSlashCatalog(agentId, conversationId, folder);
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [view, setView] = useState<SlashView>("commands");
  const [highlightState, setHighlightState] = useState({ query: "", index: 0 });
  // Escape closes the menu for the text it was closed on; typing on brings it back.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const newChat = useMemo(() => newChatEntry(agentName), [agentName]);
  const options = slash && view === "commands" ? rankCommands(withOwnEntries(catalog?.items ?? [], newChat), slash.query) : [];
  const index = slash && highlightState.query === slash.query ? Math.min(highlightState.index, Math.max(0, options.length - 1)) : 0;
  const loading = status === "loading" || (status === "idle" && !catalog);
  // Nothing matches what's being typed (a path, say): stay out of the way so Enter sends it.
  const hasContent = view === "servers" || options.length > 0 || (loading && !slash?.query);
  const open = Boolean(slash) && !disabled && dismissedFor !== draft && hasContent;

  const track = (text: string, caret: number) => {
    const found = disabled ? null : detectSlash(text, caret);
    if (!found || found.query !== slash?.query) setView("commands");
    setSlash(found);
    if (found) request();
  };

  const placeCaret = (position: number) =>
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position + caretOffset, position + caretOffset);
    });

  const pick = (item: SlashItem) => {
    if (isMcpEntry(item)) {
      setView("servers");
      return;
    }
    if (isNewChatEntry(item)) {
      setSlash(null);
      onNewChat();
      return;
    }
    const next = insertCommand(item.name);
    setDraft(next.text);
    setSlash(null);
    placeCaret(next.caret);
  };

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      if (view === "servers") setView("commands");
      else setDismissedFor(draft);
      return true;
    }
    if (view === "servers" || !slash || options.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlightState({ query: slash.query, index: (index + step + options.length) % options.length });
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pick(options[index]);
      return true;
    }
    return false;
  };

  /** "/mcp" shows the servers, "/clear" starts a new chat, and a command that would swap the session is turned away: none go to the agent. True when it did. */
  const interceptSubmit = (text: string): boolean => {
    if (disabled) return false;
    const session = sessionCommandOf(text);
    if (session) {
      setSlash(null);
      if (session.kind === "new-chat") onNewChat();
      else onBlocked(blockedNotice(session.name));
      return true;
    }
    if (!isMcpRequest(text)) return false;
    request();
    setSlash({ query: "mcp" });
    setDismissedFor(null);
    setView("servers");
    return true;
  };

  const menu: ReactNode = open && (
    <SlashMenu
      id={listId}
      view={view}
      agentName={agentName}
      catalog={catalog}
      loading={loading}
      options={options}
      highlight={index}
      canRefresh={conversationId !== null}
      onPick={pick}
      onHighlight={(i) => slash && setHighlightState({ query: slash.query, index: i })}
      onBack={() => setView("commands")}
      onRefresh={() => {
        if (conversationId !== null) void slashRefreshMcp(conversationId).then(() => reload());
      }}
    />
  );

  const showingList = open && view === "commands" && options.length > 0;
  return {
    menu,
    open,
    track,
    handleKey,
    interceptSubmit,
    close: () => {
      setSlash(null);
      setView("commands");
    },
    aria: {
      expanded: showingList,
      controls: showingList ? listId : undefined,
      activeDescendant: showingList ? optionId(listId, index) : undefined,
    },
  };
}
