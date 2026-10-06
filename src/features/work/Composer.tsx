import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CornerDownLeft, SendHorizontal, Sparkles } from "lucide-react";
import { portraitKey, IconButton, Kbd, Portrait, cx, ICON_SIZE, ICON_STROKE } from "../../design";
import { startTask } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { useAgents, selectOrchestrator } from "../../stores/agents";
import { useNavigation } from "../../stores/navigation";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import type { AttachmentDraft } from "../attachments/useAttachmentDraft";
import { mentionSuggestions, routeMessage } from "./mentions";

interface ComposerProps {
  /** The project Work is filtered to: messages run there. */
  project: string | null;
  /** Files attached to the request (Work takes dropped ones too). */
  attachments: AttachmentDraft;
}

type Notice =
  | { kind: "started" | "queued"; taskId: string; name: string }
  | { kind: "error"; text: string };

/** Ask the orchestrator, or @mention any agent, with files attached if you like. ⌘K focuses it from anywhere on Work. */
export default function Composer({ project, attachments }: ComposerProps) {
  const agents = useAgents((s) => s.agents);
  const orchestrator = useAgents(selectOrchestrator);
  const openTask = useNavigation((s) => s.openTask);
  const route = useNavigation((s) => s.route);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [highlightState, setHighlightState] = useState({ text: "", index: 0 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listId = useId();

  const humans = agents.filter((a) => a.kind !== "maintenance");
  const suggestions = mentionSuggestions(text, humans);
  const showSuggestions = suggestions.length > 0;
  // A new keystroke starts the highlight over at the top of the list.
  const highlight = highlightState.text === text ? Math.min(highlightState.index, Math.max(0, suggestions.length - 1)) : 0;
  const setHighlight = (index: number) => setHighlightState({ text, index });

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
    const routing = routeMessage(text, humans, orchestrator?.id);
    if (!routing.ok) {
      setNotice({ kind: "error", text: routing.reason });
      return;
    }
    const target = humans.find((a) => a.id === routing.agentId);
    setSending(true);
    setNotice(null);
    const name = target?.name ?? routing.agentId;
    try {
      // Work handed over here becomes a task, in that project's chat with the agent.
      const task = await startTask(routing.agentId, routing.message, project ?? undefined, [...attachments.files]);
      setText("");
      attachments.sent();
      setNotice({ kind: task.status === "todo" ? "queued" : "started", taskId: task.id, name });
    } catch (err) {
      setNotice({ kind: "error", text: errorMessage(err, `The task couldn't be handed to ${name}.`) });
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
          aria-expanded={showSuggestions}
          aria-controls={showSuggestions ? listId : undefined}
          aria-activedescendant={showSuggestions ? `${listId}-${highlight}` : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (notice?.kind === "error") setNotice(null);
          }}
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
      <AttachmentTray draft={attachments} />
      <p className="composer-notice" role="status" aria-live="polite">
        {(notice?.kind === "started" || notice?.kind === "queued") && (
          <>
            {notice.kind === "started" ? `${notice.name} has started.` : `${notice.name} is busy, so this starts when they finish.`}{" "}
            <button type="button" className="link-button" onClick={() => openTask(notice.taskId)}>
              Open task
            </button>
          </>
        )}
        {notice?.kind === "error" && <span className="composer-error">{notice.text}</span>}
      </p>
    </div>
  );
}
