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
  /** Reads before the tool's detail: "Editing src/App.tsx". */
  verb: string;
  icon: LucideIcon;
}

const TOOLS: Record<string, ToolPresentation> = {
  Read: { verb: "Reading", icon: FileText },
  Edit: { verb: "Editing", icon: FilePen },
  MultiEdit: { verb: "Editing", icon: FilePen },
  NotebookEdit: { verb: "Editing", icon: FilePen },
  Write: { verb: "Writing", icon: FilePlus },
  Bash: { verb: "Running", icon: SquareTerminal },
  Grep: { verb: "Searching for", icon: Search },
  Glob: { verb: "Finding files", icon: FolderSearch },
  WebFetch: { verb: "Reading", icon: Globe },
  WebSearch: { verb: "Searching the web for", icon: Globe },
  Task: { verb: "Delegating", icon: Workflow },
  TodoWrite: { verb: "Updating the plan", icon: ListChecks },
  delegate: { verb: "Delegating to a teammate", icon: Forward },
  message: { verb: "Messaging a teammate", icon: MessageSquare },
  ask_human: { verb: "Asking you", icon: MessageCircleQuestion },
  report_bug: { verb: "Reporting an app bug", icon: Bug },
  approve: { verb: "Checking permission", icon: ShieldCheck },
};

export function presentTool(tool: string | undefined): ToolPresentation {
  const name = tool ?? "";
  return TOOLS[name] ?? { verb: name ? `Using ${name}` : "Using a tool", icon: Wrench };
}
