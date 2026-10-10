import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CornerDownLeft, SendHorizontal, Sparkles } from "lucide-react";
import { portraitKey, IconButton, Kbd, Portrait, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { startTask } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useAgents, selectOrchestrator } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import type { AttachmentDraft } from "../attachments/useAttachmentDraft";
import { clearToNewChat } from "../conversation/chatActions";
import { useSlashMenu } from "../slash/useSlashMenu";
import { useWorkspace } from "../../stores/workspace";
import { leadingAgent, mentionSuggestions, routeMessage } from "./mentions";

interface ComposerProps {
  /** The project Work is filtered to: messages run there. */
  project: string | null;
  /** Files attached to the request (Work takes dropped ones too). */
  attachments: AttachmentDraft;
}

/**
 * Ask the orchestrator, or @mention any agent, with files attached if you like. Sending opens
 * the task's chat straight away. It sits under the board, so attached files and the agent list
 * open above it. ⌘K focuses it from anywhere on Work.
 */
export default function Composer({ project, attachments }: ComposerProps) {
  const agents = useAgents((s) => s.agents);
  const orchestrator = useAgents(selectOrchestrator);
  const openTask = useNavigation((s) => s.openTask);
  const route = useNavigation((s) => s.route);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlightState, setHighlightState] = useState({ text: "", index: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const activeProject = useWorkspace((s) => s.activeProject);

  const humans = agents.filter((a) => a.kind !== "maintenance");
  const suggestions = mentionSuggestions(text, humans);
  const showSuggestions = suggestions.length > 0;
  // A new keystroke starts the highlight over at the top of the list.
  const highlight = highlightState.text === text ? Math.min(highlightState.index, Math.max(0, suggestions.length - 1)) : 0;
  const setHighlight = (index: number) => setHighlightState({ text, index });

  // The "/" menu is the one a chat has, for whoever the request goes to: the @mentioned agent, else
  // the orchestrator. It works on the text after "@agent ", so the command stays first when it's sent.
  const addressed = leadingAgent(text, humans);
  const prefix = addressed?.prefix ?? "";
  const slashAgent = addressed?.agent ?? orchestrator;
  const folder = project ?? activeProject;
  const slash = useSlashMenu({
    agentId: slashAgent?.id ?? "",
    agentName: slashAgent?.name ?? "",
    conversationId: null,
    folder,
    draft: text.slice(prefix.length),
    setDraft: (body) => setText(prefix + body),
    inputRef,
    disabled: !slashAgent || sending,
    caretOffset: prefix.length,
    // "/clear" opens a new chat with that agent in Work's project, as it does in a chat.
    onNewChat: () => {
      if (slashAgent) void clearToNewChat({ agentId: slashAgent.id, key: slashAgent.id }, folder, { done: () => setText(""), failed: setError });
    },
    onBlocked: (notice) => setError(notice),
  });
  const track = (value: string, caret: number) => {
    const lead = leadingAgent(value, humans)?.prefix.length ?? 0;
    slash.track(value.slice(lead), caret - lead);
  };

  // ⌘K jumps to the composer while Work is on screen.
  useEffect(() => {
    if (route !== "work") return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [route]);

  const pick = (name: string) => {
    setText(`@${name} `);
    inputRef.current?.focus();
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (slash.interceptSubmit(text.slice(prefix.length))) return;
    const routing = routeMessage(text, humans, orchestrator?.id);
    if (!routing.ok) {
      setError(routing.reason);
      return;
    }
    const target = humans.find((a) => a.id === routing.agentId);
    setSending(true);
    setError(null);
    const name = target?.name ?? routing.agentId;
    try {
      // Work handed over here becomes a task, in that project's chat with the agent.
      const task = await startTask(routing.agentId, routing.message, project ?? undefined, [...attachments.files]);
      setText("");
      attachments.sent();
      // Work starts at once (beside the agent's busy chat, in a new one, if they're working
      // already), and its chat opens so you can follow along.
      openTask(task.id);
    } catch (err) {
      setError(errorMessage(err, `The task couldn't be handed to ${name}.`));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.handleKey(e)) return;
    if (showSuggestions && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((highlight + step + suggestions.length) % suggestions.length);
      return;
    }
    if (showSuggestions && (e.key === "Tab" || e.key === "Enter")) {
      e.preventDefault();
      pick(suggestions[highlight].name);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const placeholder = orchestrator
    ? `Ask ${orchestrator.name}, or @mention an agent…`
    : "@mention an agent to give it work…";

  return (
    <div className="composer-wrap">
      <AttachmentTray draft={attachments} />
      <form className={cx("composer", sending && "is-sending")} onSubmit={submit}>
        <Sparkles aria-hidden size={ICON_SIZE.lg} strokeWidth={ICON_STROKE} className="composer-icon" />
        <textarea
          ref={inputRef}
          className="composer-input selectable"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-autocomplete="list"
          aria-expanded={showSuggestions || slash.aria.expanded}
          aria-controls={showSuggestions ? listId : slash.aria.controls}
          aria-activedescendant={showSuggestions ? `${listId}-${highlight}` : slash.aria.activeDescendant}
          onChange={(e) => {
            setText(e.target.value);
            track(e.target.value, e.target.selectionStart ?? e.target.value.length);
            if (error) setError(null);
          }}
          onSelect={(e) => track(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
          onBlur={slash.close}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            attachments.addBlobs(pasted);
          }}
        />
        <AttachButton draft={attachments} />
        <Kbd>⌘K</Kbd>
        <span className="composer-divider" aria-hidden />
        <IconButton icon={SendHorizontal} label="Send" type="submit" disabled={sending || !text.trim() || attachments.adding > 0} />
        {slash.menu}
        {showSuggestions && (
          <ul id={listId} role="listbox" className="mention-list" aria-label="Agents">
            {suggestions.map((a, i) => (
              <li
                key={a.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === highlight}
                className={cx("mention-option", i === highlight && "is-highlighted")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(a.name);
                }}
              >
                <Portrait name={a.name} figure={portraitKey(a)} accent={a.accent} size={24} />
                <span className="mention-name">{a.name}</span>
                <span className="mention-role">{a.role}</span>
                {i === highlight && (
                  <CornerDownLeft aria-hidden size={ICON_SIZE.sm} strokeWidth={ICON_STROKE} className="mention-enter" />
                )}
              </li>
            ))}
          </ul>
        )}
      </form>
      <p className="composer-notice" role="status" aria-live="polite">
        {error && <span className="composer-error">{error}</span>}
      </p>
    </div>
  );
}
