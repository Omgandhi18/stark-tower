// How a run of tool calls reads in the transcript: grouped under one summary line, each call
// a row that opens to its input and output. Pure, so it's tested without rendering.
import { presentTool } from "../../../lib/tools";
import type { ChatMessage } from "../../../stores/chats";

/** A transcript entry: one message, or a run of consecutive tool calls. */
export type TranscriptItem =
  | { kind: "message"; message: ChatMessage }
  /** `key` is the run's first call, which stays put as the run grows. */
  | { kind: "tools"; key: number; calls: ChatMessage[] };

/** Consecutive tool calls become one run. */
export function groupTools(messages: readonly ChatMessage[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const message of messages) {
    const last = items[items.length - 1];
    if (message.role !== "tool") items.push({ kind: "message", message });
    else if (last?.kind === "tools") last.calls.push(message);
    else items.push({ kind: "tools", key: message.id, calls: [message] });
  }
  return items;
}

/**
 * "failed"/"done": it came back. "running": still going. "noresult": the turn ended without it
 * reporting back. "unknown": saved before outputs were kept.
 */
export type CallState = "running" | "failed" | "done" | "noresult" | "unknown";

/** `live`: the agent is still working, so a call without a result is still going. */
export function callState(call: ChatMessage, live: boolean): CallState {
  if (call.result?.noResult) return "noresult";
  if (call.result) return call.result.isError ? "failed" : "done";
  return live ? "running" : "unknown";
}

/** Tools whose detail is a file. A row names just the file; the full path shows when it's opened. */
const FILE_TOOLS = new Set(["Read", "Edit", "MultiEdit", "NotebookEdit", "Write"]);
/** Tools whose detail is a command, file, pattern or address, so it reads as code after the verb. */
const CODE_TOOLS = new Set([...FILE_TOOLS, "Bash", "Grep", "Glob", "WebFetch"]);
/** Codex runs each command through the shell: `/bin/zsh -lc "npm test"` reads as `npm test`. */
const SHELL_WRAPPER = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/;

/** A row's words: the verb (past tense once the call is over), then what it worked on, as code. */
export interface CallLabel {
  lead: string;
  code?: string;
  /** Everything, for the tooltip. */
  full: string;
}

const firstLine = (text: string) => {
  const [line, ...rest] = text.trim().split("\n");
  return rest.length ? `${line} …` : line;
};

/** The command as it was meant: without Codex's shell wrapper. */
export function displayCommand(command: string): string {
  return SHELL_WRAPPER.exec(command.trim())?.[2] ?? command.trim();
}

/**
 * "Ran npm test", "Read App.tsx", or the agent's own one-line description of a command when it
 * gave one ("Inspect the lockfile's Vercel entries"), as in Claude's own transcript.
 */
export function callLabel(call: ChatMessage, state: CallState): CallLabel {
  const tool = presentTool(call.tool);
  const verb = state === "running" ? tool.verb : tool.done;
  const input = callInput(call);
  const name = call.tool ?? "";
  if (name === "Bash") {
    const command = input.command ? displayCommand(input.command) : call.detail ?? "";
    const description = stringField(parseInput(call), "description");
    if (description) return { lead: description, full: command ? `${description}\n${command}` : description };
    return command ? { lead: verb, code: firstLine(command), full: `${verb} ${command}` } : { lead: verb, full: verb };
  }
  const detail = FILE_TOOLS.has(name) ? input.path ?? call.detail : call.detail;
  if (!detail) return { lead: verb, full: verb };
  if (!CODE_TOOLS.has(name)) return { lead: `${verb} ${detail}`, full: `${verb} ${detail}` };
  const shown = FILE_TOOLS.has(name) ? detail.split("/").filter(Boolean).pop() ?? detail : firstLine(detail);
  return { lead: verb, code: shown, full: `${verb} ${detail}` };
}

/** A run in a sentence: "Ran 2 commands (1 failed), read a file, edited 3 files". */
export function summarizeCalls(calls: readonly ChatMessage[], live: boolean): string {
  const clauses = new Map<string, { past: string; noun: (n: number) => string; count: number; failed: number }>();
  for (const call of calls) {
    const { group, past, noun } = presentTool(call.tool);
    const clause = clauses.get(group) ?? { past, noun, count: 0, failed: 0 };
    clause.count += 1;
    if (callState(call, live) === "failed") clause.failed += 1;
    clauses.set(group, clause);
  }
  const text = [...clauses.values()]
    .map((c) => `${c.past} ${c.noun(c.count)}${c.failed ? ` (${c.failed} failed)` : ""}`)
    .join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a call was given, laid out for reading. */
export interface CallInput {
  /** A shell command, shown as code. */
  command?: string;
  /** The file or page it worked on. */
  path?: string;
  /** Every other argument, as JSON. */
  args?: string;
}

const PATH_KEYS = ["file_path", "notebook_path", "path", "url"];

/** The call's input; for calls saved without one, what its row said (a command or a path). */
/** The call's input as an object, when it was kept and is one. */
function parseInput(call: ChatMessage): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = call.input ? JSON.parse(call.input) : undefined;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const stringField = (input: Record<string, unknown> | undefined, key: string) => {
  const value = input?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export function callInput(call: ChatMessage): CallInput {
  const parsed = parseInput(call);
  if (!parsed) {
    if (!call.detail) return {};
    return call.tool === "Bash" ? { command: call.detail } : ["Read", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch"].includes(call.tool ?? "") ? { path: call.detail } : {};
  }
  const rest = { ...parsed };
  const input: CallInput = {};
  if (typeof rest.command === "string") {
    input.command = rest.command;
    delete rest.command;
    // A command's description is its row's label already.
    delete rest.description;
  }
  const pathKey = PATH_KEYS.find((k) => typeof rest[k] === "string");
  if (pathKey) {
    input.path = rest[pathKey] as string;
    delete rest[pathKey];
  }
  if (Object.keys(rest).length > 0) input.args = JSON.stringify(rest, null, 2);
  return input;
}

/** How many images the call returned that were too large to keep. */
export function droppedImages(call: ChatMessage): number {
  return call.result?.imagesDropped ?? 0;
}

/** "Image too large to keep", for the row and its body. */
export function droppedImagesNote(count: number): string {
  return count === 1 ? "Image too large to keep" : `${count} images too large to keep`;
}

/** What a row opens to: its input, its output, or images. */
export function hasDetails(call: ChatMessage): boolean {
  const input = callInput(call);
  return Boolean(input.command || input.path || input.args || (call.result && !call.result.noResult) || call.liveOutput || call.attachments?.length || droppedImages(call));
}

/** The output a row shows: what came back, else what has streamed so far. */
export function outputText(call: ChatMessage): string {
  return call.result ? call.result.text ?? "" : call.liveOutput ?? "";
}
