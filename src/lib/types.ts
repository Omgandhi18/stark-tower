export type AgentStatus = "offline" | "idle" | "thinking" | "working" | "blocked";

export type AgentKind = "orchestrator" | "worker";

export interface Agent {
  id: string;
  name: string;
  role: string;
  kind: AgentKind;
  engine: string;
  accent: string;
  figure: string;
  home_x: number;
  home_y: number;
  status: AgentStatus;
}

export interface AssistLink {
  from: string;
  to: string;
  id: number;
}

export interface ProjectInfo {
  path: string;
  name: string;
}

export interface ProjectsState {
  projects: ProjectInfo[];
  active: string;
}

export interface LedgerEntry {
  id: number;
  ts: number;
  agent_id: string;
  kind: string;
  detail: string;
  load: number;
}

export interface DispatchResult {
  agent_id: string;
  name: string;
  spawned: boolean;
}

export interface PtyData {
  agentId: string;
  data: number[];
}

export interface StatusEvent {
  agentId: string;
  status: AgentStatus;
}

export type ChatEventKind =
  | "init"
  | "text"
  | "thinking"
  | "tool"
  | "tool_result"
  | "result"
  | "error"
  | "exit";

export interface ChatEvent {
  agentId: string;
  kind: ChatEventKind;
  text?: string;
  tool?: string;
  detail?: string;
  cwd?: string;
}

/** How an engine authenticates: cli-login | api-key-env | none. */
export interface AuthConfig {
  method: string;
  env: Record<string, string>;
}

/** A backend agents can run on (Claude Code, Codex, OpenCode, custom CLI). */
export interface EngineConfig {
  id: string;
  label: string;
  kind: string;
  command: string;
  extra_args: string[];
  model: string;
  auth: AuthConfig;
  supports_mcp: boolean;
  enabled: boolean;
}

/** An editable roster member (name, role, sprite, personality, engine, model). */
export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  kind: AgentKind;
  accent: string;
  figure: string;
  engine: string;
  model: string;
  personality: string;
  home_x: number;
  home_y: number;
  enabled: boolean;
}

/** The whole persisted configuration: engines + roster. */
export interface AppConfig {
  version: number;
  onboarded: boolean;
  lighting: string; // "auto" | "system" | "morning" | "day" | "evening" | "night"
  engines: EngineConfig[];
  agents: AgentConfig[];
}

/** Resolved floor lighting phase (what StarkFloor actually renders). */
export type LightPhase = "morning" | "day" | "evening" | "night";

/** A file or folder under a project dir, for the chat's @ picker. */
export interface PathEntry {
  path: string;
  dir: boolean;
}

/** A persisted chat turn, returned by get_chat to rehydrate the transcript. */
export interface StoredMessage {
  id: number;
  ts: number;
  role: "user" | "agent" | "tool" | "thinking" | "error" | "system";
  text?: string;
  tool?: string;
  detail?: string;
}

export type ReviewKind =
  | "plan"
  | "diff"
  | "findings"
  | "questions"
  | "choice"
  | "mockup";

export interface ReviewRequest {
  id: string;
  agentId: string;
  title: string;
  body: string;
  kind: ReviewKind;
  choices: string[];
}
