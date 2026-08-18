import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import rehypeHighlight from "rehype-highlight";
import type { Agent, ChatEvent, ProjectInfo, ReviewRequest } from "../lib/types";
import { chatSend, chatStop, getChat, onChatEvent } from "../lib/api";

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
          role: r.role,
          text: r.text,
          tool: r.tool,
          detail: r.detail,
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
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={1}
          placeholder={
            question ? `Answer ${agent.name}…` : `Message ${agent.name}…`
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
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
