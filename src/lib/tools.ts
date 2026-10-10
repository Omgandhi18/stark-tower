// How an agent's tool calls read in the UI: one verb and one icon per tool,
// shared by the transcript and the one-line activity summaries.
import {
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Forward,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  MessageSquare,
  Search,
  SquareTerminal,
  Bug,
  ShieldCheck,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export interface ToolPresentation {
  /** Reads before the tool's detail while it runs: "Editing src/App.tsx". */
  verb: string;
  /** The same, once it's finished: "Edited src/App.tsx". */
  done: string;
  icon: LucideIcon;
  /** Tools that share a group are counted together in a run's summary ("edited 2 files"). */
  group: string;
  /** The summary's verb, past tense: "edited". */
  past: string;
  /** What `count` calls amounted to, after the verb: "a file", "3 files". */
  noun: (count: number) => string;
}

const times = (what: string) => (n: number) => (n === 1 ? what : `${what} ${n} times`);
const plural = (one: string, many: string) => (n: number) => (n === 1 ? one : `${n} ${many}`);
const READ = { group: "read", past: "read", noun: plural("a file", "files") };
const EDIT = { group: "edit", past: "edited", noun: plural("a file", "files") };

const TOOLS: Record<string, ToolPresentation> = {
  Read: { verb: "Reading", done: "Read", icon: FileText, ...READ },
  Edit: { verb: "Editing", done: "Edited", icon: FilePen, ...EDIT },
  MultiEdit: { verb: "Editing", done: "Edited", icon: FilePen, ...EDIT },
  NotebookEdit: { verb: "Editing", done: "Edited", icon: FilePen, ...EDIT },
  Write: { verb: "Writing", done: "Wrote", icon: FilePlus, group: "write", past: "wrote", noun: plural("a file", "files") },
  Bash: { verb: "Running", done: "Ran", icon: SquareTerminal, group: "run", past: "ran", noun: plural("a command", "commands") },
  Grep: { verb: "Searching for", done: "Searched for", icon: Search, group: "search", past: "searched", noun: times("the code") },
  Glob: { verb: "Finding files", done: "Found files", icon: FolderSearch, group: "glob", past: "looked up", noun: plural("a set of files", "sets of files") },
  WebFetch: { verb: "Reading", done: "Read", icon: Globe, group: "fetch", past: "fetched", noun: plural("a page", "pages") },
  WebSearch: { verb: "Searching the web for", done: "Searched the web for", icon: Globe, group: "web", past: "searched the web", noun: (n) => (n === 1 ? "once" : `${n} times`) },
  Task: { verb: "Delegating", done: "Delegated", icon: Workflow, group: "task", past: "delegated", noun: plural("a task", "tasks") },
  TodoWrite: { verb: "Updating the plan", done: "Updated the plan", icon: ListChecks, group: "plan", past: "updated", noun: times("the plan") },
  delegate: { verb: "Delegating to a teammate", done: "Delegated to a teammate", icon: Forward, group: "delegate", past: "delegated", noun: plural("to a teammate", "tasks to teammates") },
  message: { verb: "Messaging a teammate", done: "Messaged a teammate", icon: MessageSquare, group: "message", past: "messaged", noun: plural("a teammate", "teammates") },
  ask_human: { verb: "Asking you", done: "Asked you", icon: MessageCircleQuestion, group: "ask", past: "asked", noun: plural("you a question", "you questions") },
  report_bug: { verb: "Reporting an app bug", done: "Reported an app bug", icon: Bug, group: "bug", past: "reported", noun: plural("a bug", "bugs") },
  approve: { verb: "Checking permission", done: "Checked permission", icon: ShieldCheck, group: "approve", past: "checked", noun: plural("a permission", "permissions") },
};

/** The servers whose tools agents call by an `mcp__<server>__<tool>` name, as people know them. */
const SERVER_NAMES: Record<string, string> = { stark: "Starkline" };

const words = (name: string) => name.replace(/[_-]+/g, " ").trim();
const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "Starkline: claim files" for `mcp__stark__claim_files`, and an unknown tool's own name otherwise. */
export function toolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (!mcp) return tool;
  return `${SERVER_NAMES[mcp[1]] ?? capitalised(words(mcp[1]))}: ${words(mcp[2])}`;
}

export function presentTool(tool: string | undefined): ToolPresentation {
  const name = tool ?? "";
  const label = toolLabel(name);
  return (
    TOOLS[name] ?? {
      verb: name ? `Using ${label}` : "Using a tool",
      done: name ? `Used ${label}` : "Used a tool",
      icon: Wrench,
      group: "other",
      past: "used",
      noun: plural("a tool", "tools"),
    }
  );
}
