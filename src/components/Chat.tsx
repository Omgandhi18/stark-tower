import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, FileText, Folder } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import type {
  Agent,
  ChatEvent,
  PathEntry,
  ProjectInfo,
  ReviewRequest,
} from "../lib/types";
import { chatSend, chatStop, getChat, listFiles, onChatEvent } from "../lib/api";

/** If the caret sits inside an `@token`, return its start index and query. */
function detectMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i])) i--;
  const start = i + 1;
  const token = text.slice(start, caret);
  if (token.startsWith("@")) return { start, query: token.slice(1) };
  return null;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
const shortDir = (p: string) => baseName(p.replace(/\/+$/, "")) || p;

interface Props {
  agent: Agent;
  active: boolean;
  projects: ProjectInfo[];
  activeDir: string;
  /** A pending question this agent asked via ask_human (answered inline). */
  question?: ReviewRequest;
  onAnswer: (id: string, text: string) => void;
}

type Role = "user" | "agent" | "tool" | "thinking" | "error" | "system";

interface Message {
  id: number;
  role: Role;
  text?: string;
  tool?: string;
  detail?: string;
}

const TOOL_LABEL: Record<string, string> = {
  Edit: "EDIT",
  Write: "WRITE",
  Read: "READ",
  NotebookEdit: "EDIT",
  Bash: "BASH",
  Grep: "GREP",
  Glob: "GLOB",
  Task: "AGENT",
  WebFetch: "FETCH",
  WebSearch: "SEARCH",
  delegate: "DELEGATE",
};

let counter = 0;
const nextId = () => ++counter;

/**
 * Chat with one agent's headless Claude Code session. Stays mounted when
 * inactive (hidden) so history survives switching agents.
 */
export default function Chat({
  agent,
  active,
  projects,
  activeDir,
  question,
  onAnswer,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [dir, setDir] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastQ = useRef<string | null>(null);
  const hydrated = useRef(false);

  // @-mention file picker state.
  const [files, setFiles] = useState<PathEntry[]>([]);
  const filesDir = useRef<string>("");
  const [mention, setMention] = useState<{ start: number; query: string } | null>(
    null,
  );
  const [mIndex, setMIndex] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const pendingCaret = useRef<number | null>(null);
  const mentionPopRef = useRef<HTMLDivElement>(null);

  // Lazily load (and cache) the file list for a directory the first time `@`
  // is used, so we're not walking the tree until it's actually needed.
  const ensureFiles = (d: string) => {
    if (!d || filesDir.current === d) return;
    filesDir.current = d;
    setFilesLoading(true);
    listFiles(d)
      .then(setFiles)
      .catch(() => setFiles([]))
      .finally(() => setFilesLoading(false));
  };

  const suggestions = useMemo(() => {
    if (!mention) return [] as PathEntry[];
    const q = mention.query.toLowerCase();
    const pool = q
      ? files.filter((f) => f.path.toLowerCase().includes(q))
      : files;
    return pool
      .map((f) => {
        const b = baseName(f.path).toLowerCase();
        let score = 3;
        if (b.startsWith(q)) score = 0;
        else if (b.includes(q)) score = 1;
        else if (f.path.toLowerCase().startsWith(q)) score = 2;
        return { f, score };
      })
      .sort((a, b) => a.score - b.score || a.f.path.length - b.f.path.length)
      .slice(0, 12)
      .map((s) => s.f);
  }, [mention, files]);

  // Keep the arrow-key-selected suggestion scrolled into view within the popup.
  useEffect(() => {
    const el = mentionPopRef.current?.querySelector<HTMLElement>(
      ".mention-item.sel",
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [mIndex, suggestions]);

  const acceptMention = (entry: PathEntry) => {
    if (!mention) return;
    const caret = inputRef.current?.selectionStart ?? input.length;
    const before = input.slice(0, mention.start);
    const after = input.slice(caret);
    // Trailing slash on folders signals "the whole directory" to the agent.
    const insert = `@${entry.path}${entry.dir ? "/" : ""} `;
    setInput(before + insert + after);
    setMention(null);
    pendingCaret.current = (before + insert).length;
  };

  // Restore caret after an @-mention insertion.
  useEffect(() => {
    if (pendingCaret.current != null && inputRef.current) {
      const pos = pendingCaret.current;
      pendingCaret.current = null;
      inputRef.current.focus();
      inputRef.current.setSelectionRange(pos, pos);
    }
  }, [input]);

  // Keep the highlighted suggestion in range as the list changes.
  useEffect(() => {
    setMIndex(0);
  }, [mention?.query]);

  // Rehydrate the saved transcript once, so a chat survives the UI closing.
  // Prepend (never replace) so any live event that lands first is preserved,
  // and guard synchronously so React StrictMode's double-invoke loads once.
  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;
    getChat(agent.id)
      .then((rows) => {
        if (!rows.length) return;
        const restored: Message[] = rows.map((r) => ({
          id: nextId(),
          role: r.role as Role,
          text: r.text ?? undefined,
          tool: r.tool ?? undefined,
          detail: r.detail ?? undefined,
        }));
        setMessages((prev) => [...restored, ...prev]);
      })
      .catch(() => {});
  }, [agent.id]);

  // Default this chat's directory to the active project until the user picks one.
  useEffect(() => {
    if (!dir && activeDir) setDir(activeDir);
  }, [activeDir, dir]);

  const reset = async () => {
    try {
      await chatStop(agent.id);
    } catch {
      /* ignore */
    }
    setMessages([]);
    setPending(false);
  };

  const push = (m: Omit<Message, "id">) =>
    setMessages((prev) => [...prev, { id: nextId(), ...m }]);

  // Subscribe to this agent's chat events.
  useEffect(() => {
    const unsub = onChatEvent((e: ChatEvent) => {
      if (e.agentId !== agent.id) return;
      switch (e.kind) {
        case "text":
          setPending(false);
          push({ role: "agent", text: e.text });
          break;
        case "tool":
          push({ role: "tool", tool: e.tool, detail: e.detail });
          break;
        case "thinking":
          push({ role: "thinking", text: e.text });
          break;
        case "error":
          setPending(false);
          push({ role: "error", text: e.text });
          break;
        case "result":
          setPending(false);
          break;
        case "init":
          push({ role: "system", text: `session online · ${e.cwd ?? ""}` });
          break;
        case "exit":
          push({ role: "system", text: "session ended" });
          break;
      }
    });
    return () => {
      unsub.then((f) => f());
    };
  }, [agent.id]);

  // Auto-scroll to newest.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pending]);

  // A normal question this agent asked shows inline; the input answers it.
  useEffect(() => {
    if (question && question.id !== lastQ.current) {
      lastQ.current = question.id;
      setPending(false);
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: "agent", text: question.body },
      ]);
    }
  }, [question]);

  useEffect(() => {
    if (active) inputRef.current?.focus();
  }, [active]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    // Answering a pending question routes back to the agent's blocked ask_human.
    if (question) {
      push({ role: "user", text });
      setInput("");
      setPending(true);
      onAnswer(question.id, text);
      return;
    }
    push({ role: "user", text });
    setInput("");
    setPending(true);
    try {
      await chatSend(agent.id, text, dir || undefined);
    } catch (err) {
      setPending(false);
      push({ role: "error", text: typeof err === "string" ? err : "send failed" });
    }
  };

  return (
    <div className="chat" style={{ display: active ? "flex" : "none" }}>
      <div className="chat-header">
        <span className="chat-header-name" style={{ color: agent.accent }}>
          {agent.name}
        </span>
        <span className="chat-header-role">{agent.role}</span>
        <span className="chat-header-spacer" />
        <label className="chat-dir">
          <span className="chat-dir-label">
            {agent.id === "jarvis" ? "home" : "dir"}
          </span>
          <select value={dir} onChange={(e) => setDir(e.target.value)}>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <button className="chat-reset" onClick={reset} title="Reset session">
          <RotateCcw size={14} strokeWidth={2} />
        </button>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <div className="chat-empty-name" style={{ color: agent.accent }}>
              {agent.name}
            </div>
            <div className="chat-empty-role">{agent.role}</div>
            <div className="chat-empty-hint">
              Ask a question or hand over a task. First message brings the session
              online.
            </div>
          </div>
        )}
        {messages.map((m) => (
          <ChatRow key={m.id} m={m} accent={agent.accent} />
        ))}
        {pending && (
          <div className="chat-pending" style={{ color: agent.accent }}>
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
          </div>
        )}
      </div>

      <div className="chat-inputbar">
        {mention && (suggestions.length > 0 || filesLoading) && (
          <div className="mention-pop glass" ref={mentionPopRef}>
            <div className="mention-head">
              <span className="label">
                {filesDir.current ? shortDir(filesDir.current) : "files"}
              </span>
              <span className="mention-hint">
                {filesLoading ? "scanning…" : "↑↓ · enter"}
              </span>
            </div>
            {filesLoading && suggestions.length === 0 && (
              <div className="mention-empty">Scanning files &amp; folders…</div>
            )}
            {suggestions.map((f, i) => (
              <button
                key={f.path}
                className={`mention-item ${i === mIndex ? "sel" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptMention(f);
                }}
                onMouseEnter={() => setMIndex(i)}
              >
                {f.dir ? (
                  <Folder size={13} className="mention-ic mention-ic-dir" strokeWidth={2} />
                ) : (
                  <FileText size={13} className="mention-ic" strokeWidth={2} />
                )}
                <span className="mention-base">
                  {baseName(f.path)}
                  {f.dir ? "/" : ""}
                </span>
                {dirName(f.path) && (
                  <span className="mention-path">{dirName(f.path)}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          placeholder={
            question
              ? `Answer ${agent.name}…`
              : `Message ${agent.name}…  ·  @ to add a file`
          }
          value={input}
          onChange={(e) => {
            const val = e.target.value;
            setInput(val);
            const m = detectMention(val, e.target.selectionStart ?? val.length);
            if (m) {
              ensureFiles(dir);
              setMention(m);
            } else {
              setMention(null);
            }
          }}
          onKeyDown={(e) => {
            const picking = mention && (suggestions.length > 0 || filesLoading);
            if (picking) {
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
              if (suggestions.length) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMIndex((i) => (i + 1) % suggestions.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  acceptMention(suggestions[mIndex]);
                  return;
                }
              }
              // While the scan is still running, don't let Enter fire a send.
              if (filesLoading && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="chat-send" onClick={send} style={{ borderColor: agent.accent, color: agent.accent }}>
          Send
        </button>
      </div>
    </div>
  );
}

function ChatRow({ m, accent }: { m: Message; accent: string }) {
  if (m.role === "user") {
    return (
      <div className="msg msg-user">
        <div className="bubble bubble-user">{m.text}</div>
      </div>
    );
  }
  if (m.role === "agent") {
    return (
      <div className="msg msg-agent">
        <div
          className="bubble bubble-agent md"
          style={{ borderColor: `${accent}55` }}
        >
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks]}
            rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
          >
            {m.text ?? ""}
          </ReactMarkdown>
        </div>
      </div>
    );
  }
  if (m.role === "tool") {
    const label = TOOL_LABEL[m.tool ?? ""] ?? (m.tool ?? "TOOL").toUpperCase();
    const isDelegate = m.tool === "delegate";
    return (
      <div className="msg msg-tool">
        <span className={`tool-chip ${isDelegate ? "tool-chip-delegate" : ""}`}>
          {label}
        </span>
        <span className="tool-detail">{m.detail}</span>
      </div>
    );
  }
  if (m.role === "thinking") {
    return <div className="msg msg-thinking">{m.text}</div>;
  }
  if (m.role === "error") {
    return <div className="msg msg-error">{m.text}</div>;
  }
  return <div className="msg msg-system">{m.text}</div>;
}
