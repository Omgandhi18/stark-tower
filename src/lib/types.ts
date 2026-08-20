// Domain types are GENERATED from Rust by tauri-specta (see bindings.ts, produced
// by the `export_typescript_bindings` test). Re-exported here so the rest of the
// app keeps importing from `./types` while the shapes can never drift from Rust.
export type {
  Agent,
  AgentKind,
  AgentStatus,
  AgentConfig,
  AppConfig,
  AuthConfig,
  Conversation,
  EngineConfig,
  LedgerEntry,
  StoredMessage,
  Task,
  DispatchResult,
  ProjectInfo,
  ProjectsState,
  PathEntry,
} from "./bindings";

import type { AgentStatus } from "./bindings";

// ---- UI / event-payload types (not command types, so not generated) ----

export interface AssistLink {
  from: string;
  to: string;
  id: number;
}

export type TaskStatus = "todo" | "doing" | "blocked" | "done";

export interface PtyData {
  agentId: string;
  data: number[];
}

export interface StatusEvent {
  agentId: string;
  status: AgentStatus;
}

/** Per-turn usage, emitted on each agent `result` (usage://update). */
export interface UsageUpdate {
  agentId: string;
  costUsd: number;
  contextTokens: number;
}

/** Notify-only update check result (update://status). */
export interface UpdateStatus {
  available: boolean;
  latest: string | null;
  current: string;
  error: string | null;
}

export type ChatEventKind =
  | "init"
  | "text"
  | "thinking"
  | "tool"
  | "result"
  | "error"
  | "exit"
  | "system";

export interface ChatEvent {
  agentId: string;
  kind: ChatEventKind;
  text?: string;
  tool?: string;
  detail?: string;
  cwd?: string;
}

/** Resolved floor lighting phase (what StarkFloor actually renders). */
export type LightPhase = "morning" | "day" | "evening" | "night";

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
