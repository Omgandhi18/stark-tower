import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AtSign, SendHorizontal, Square } from "lucide-react";
import { Button, IconButton, cx } from "../../design";
import type { Attachment, PathEntry } from "../../lib/types";
import { conversationOfKey, selectThread, useChats, type ChatRef } from "../../stores/chats";
import { AttachButton, AttachmentTray } from "../attachments/AttachmentTray";
import type { AttachmentDraft } from "../attachments/useAttachmentDraft";
import AutoModeChip from "../automode/AutoModeChip";
import FilePicker from "./FilePicker";
import ModelChips from "./ModelChips";
import { detectMention, insertMention, optionId, rankPaths, type MentionQuery } from "./fileMentions";
import { clearToNewChat } from "./chatActions";
import { composeFiles, composeMessage } from "./references/referenceModel";
import { ReferenceTray } from "./references/ReferenceTray";
import { useSlashMenu } from "../slash/useSlashMenu";
import { useFolderFiles } from "./useFolderFiles";

/** The input grows with its text up to this height, then scrolls. */
const MAX_INPUT_HEIGHT = 220;

interface ChatComposerProps {
  /** The chat the message goes to. */
  chat: ChatRef;
  agentName: string;
  folder: string;
  pending: boolean;
  /** A question is waiting: the next message answers it. */
  answering: boolean;
  /** Files attached to the message being written (the panel around it takes dropped ones too). */
  attachments: AttachmentDraft;
  onSend: (text: string, files: Attachment[]) => void;
  onStop: () => void;
}

/** Message box with an @ file picker and attachments (picked, pasted or dropped). Enter sends, Shift+Enter adds a line. */
export default function ChatComposer({ chat, agentName, folder, pending, answering, attachments, onSend, onStop }: ChatComposerProps) {
  const { agentId, key } = chat;
  const draft = useChats((s) => selectThread(key)(s).draft);
  const setDraft = useChats((s) => s.setDraft);
  const references = useChats((s) => selectThread(key)(s).references);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState({ query: "", index: 0 });
  const files = useFolderFiles(folder);
  const listId = useId();
  const slash = useSlashMenu({
    agentId,
    agentName,
    conversationId: conversationOfKey(key),
    folder,
    draft,
    setDraft: (text) => setDraft(key, text),
    inputRef,
    disabled: answering,
    onNewChat: () => void clearToNewChat(chat, folder),
    onBlocked: (notice) => useChats.getState().push(key, { role: "system", text: notice }),
  });

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
    setDraft(key, next.text);
    setMention(null);
    placeCaret(next.caret);
  };

  const startMention = () => {
    const input = inputRef.current;
    const caret = input?.selectionStart ?? draft.length;
    const needsSpace = caret > 0 && !/\s/.test(draft[caret - 1]);
    const insert = `${needsSpace ? " " : ""}@`;
    const text = draft.slice(0, caret) + insert + draft.slice(caret);
    setDraft(key, text);
    updateMention(text, caret + insert.length);
    placeCaret(caret + insert.length);
  };

  // An answer is words only: files go with the next message.
  const sending = answering ? [] : attachments.files;
  const canSend = Boolean(draft.trim() || sending.length || references.length) && attachments.adding === 0;

  const submit = () => {
    const text = draft.trim();
    if (!canSend || slash.interceptSubmit(text)) return;
    const message = composeMessage(references, text);
    const outgoing = answering ? [] : composeFiles(references, sending);
    setDraft(key, "");
    useChats.getState().clearReferences(key);
    setMention(null);
    if (sending.length) attachments.sent();
    onSend(message, outgoing);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.handleKey(e)) return;
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
      <ReferenceTray chatKey={key} />
      {slash.menu}
      {!answering && <AttachmentTray draft={attachments} />}
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
        data-chat-key={key}
        ref={inputRef}
        className="chat-input selectable"
        rows={1}
        value={draft}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-autocomplete="list"
        aria-expanded={slash.aria.expanded || (picking && options.length > 0)}
        aria-controls={slash.aria.controls ?? (picking && options.length > 0 ? listId : undefined)}
        aria-activedescendant={slash.aria.activeDescendant ?? (picking && options.length > 0 ? optionId(listId, index) : undefined)}
        onChange={(e) => {
          setDraft(key, e.target.value);
          updateMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          slash.track(e.target.value, e.target.selectionStart ?? e.target.value.length);
        }}
        onSelect={(e) => {
          const input = e.currentTarget;
          if (mention) updateMention(input.value, input.selectionStart ?? input.value.length);
          slash.track(input.value, input.selectionStart ?? input.value.length);
        }}
        onBlur={() => {
          setMention(null);
          slash.close();
        }}
        onKeyDown={onKeyDown}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (!pasted.length || answering) return;
          e.preventDefault();
          attachments.addBlobs(pasted);
        }}
      />
      <div className="chat-composer-bar">
        <AttachButton draft={attachments} disabled={answering} title={answering ? "Answer the question first, then attach files" : undefined} />
        <IconButton icon={AtSign} label="Mention a project file or folder" size="sm" disabled={!folder} onClick={startMention} />
        <ModelChips agentId={agentId} agentName={agentName} />
        <AutoModeChip chatKey={key} agentName={agentName} />
        <span className="chat-composer-spacer" aria-hidden />
        {pending && (
          <Button size="sm" variant="secondary" icon={Square} onClick={onStop}>
            Stop
          </Button>
        )}
        <Button size="sm" variant="primary" icon={SendHorizontal} disabled={!canSend} onClick={submit}>
          {answering ? "Answer" : "Send"}
        </Button>
      </div>
    </div>
  );
}
