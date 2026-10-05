import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AtSign, SendHorizontal, Square } from "lucide-react";
import { Button, IconButton, cx } from "../../design";
import type { PathEntry } from "../../lib/types";
import { selectThread, useChats } from "../../stores/chats";
import FilePicker from "./FilePicker";
import { detectMention, insertMention, optionId, rankPaths, type MentionQuery } from "./fileMentions";
import { useFolderFiles } from "./useFolderFiles";

/** The input grows with its text up to this height, then scrolls. */
const MAX_INPUT_HEIGHT = 220;

interface ChatComposerProps {
  agentId: string;
  agentName: string;
  folder: string;
  pending: boolean;
  /** A question is waiting: the next message answers it. */
  answering: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}

/** Message box with an @ file picker. Enter sends, Shift+Enter adds a line. */
export default function ChatComposer({ agentId, agentName, folder, pending, answering, onSend, onStop }: ChatComposerProps) {
  const draft = useChats((s) => selectThread(agentId)(s).draft);
  const setDraft = useChats((s) => s.setDraft);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState({ query: "", index: 0 });
  const files = useFolderFiles(folder);
  const listId = useId();

  const options = mention ? rankPaths(files.entries, mention.query) : [];
  const index = mention && highlight.query === mention.query ? Math.min(highlight.index, Math.max(0, options.length - 1)) : 0;
  const picking = Boolean(mention && folder);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [draft]);

  const updateMention = (text: string, caret: number) => {
    const found = detectMention(text, caret);
    setMention(found);
    if (found) files.request();
  };

  const placeCaret = (position: number) =>
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
    });

  const pick = (entry: PathEntry) => {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? draft.length;
    const next = insertMention(draft, mention, caret, entry);
    setDraft(agentId, next.text);
    setMention(null);
    placeCaret(next.caret);
  };

  const startMention = () => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const needsSpace = caret > 0 && !/\s/.test(draft[caret - 1]);
    const insert = `${needsSpace ? " " : ""}@`;
    const text = draft.slice(0, caret) + insert + draft.slice(caret);
    setDraft(agentId, text);
    updateMention(text, caret + insert.length);
    placeCaret(caret + insert.length);
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft(agentId, "");
    setMention(null);
    onSend(text);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (picking && mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setHighlight({ query: mention.query, index: (index + step + options.length) % options.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        // While the folder is still being scanned, Enter must not send half a mention.
        if (options.length || files.status === "loading") e.preventDefault();
        if (options.length) {
          pick(options[index]);
          return;
        }
        if (files.status === "loading") return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const placeholder = answering ? `Answer ${agentName}…` : `Message ${agentName}…`;

  return (
    <div className={cx("chat-composer", answering && "is-answering")}>
      {picking && (
        <FilePicker
          id={listId}
          folder={folder}
          status={files.status}
          options={options}
          highlight={index}
          onPick={pick}
          onHighlight={(i) => mention && setHighlight({ query: mention.query, index: i })}
        />
      )}
      <textarea
        ref={inputRef}
        className="chat-input selectable"
        rows={1}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-expanded={picking && options.length > 0}
        aria-controls={picking && options.length > 0 ? listId : undefined}
        aria-activedescendant={picking && options.length > 0 ? optionId(listId, index) : undefined}
        onChange={(e) => {
          setDraft(agentId, e.target.value);
          updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => {
          const input = e.currentTarget;
          if (mention) updateMention(input.value, input.selectionStart ?? input.value.length);
        }}
        onBlur={() => setMention(null)}
        onKeyDown={onKeyDown}
      />
      <div className="chat-composer-bar">
        <IconButton icon={AtSign} label="Add a file or folder" size="sm" disabled={!folder} onClick={startMention} />
        <span className="chat-composer-hint">Enter to send, Shift+Enter for a new line</span>
        {pending && (
          <Button size="sm" variant="secondary" icon={Square} onClick={onStop}>
            Stop
          </Button>
        )}
        <Button size="sm" variant="primary" icon={SendHorizontal} disabled={!draft.trim()} onClick={submit}>
          {answering ? "Answer" : "Send"}
        </Button>
      </div>
    </div>
  );
}
