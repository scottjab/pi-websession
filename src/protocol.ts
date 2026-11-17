// Wire protocol shared by publishers (one per pi session), the hub, and the browser.

export type SessionStatus = "idle" | "running" | "waiting_ui" | "offline" | "ended";

export interface SessionMeta {
  id: string;
  /** Session file path (stable key; children point at their parent's file). */
  file?: string;
  parentFile?: string;
  /** Session id of the parent session, filled in by the hub when known. */
  parentId?: string;
  name?: string;
  cwd?: string;
  kind: "main" | "subagent";
  /** Short label for subagents, e.g. the run id. */
  label?: string;
  model?: string;
  thinkingLevel?: string;
  status: SessionStatus;
  /** True when the user consented to web control for this session tree. */
  controllable: boolean;
  pid: number;
  host?: string;
  startedAt: number;
  updatedAt: number;
  /** Rolling token/cost totals from assistant messages. */
  usage?: { input: number; output: number; cost: number };
  /** Context usage percent, when known. */
  contextPercent?: number;
}

/** A message as shown in the UI (pi AgentMessage, trimmed for transport). */
export type WireMessage = Record<string, any> & { role: string; timestamp?: number };

export interface ToolState {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  partial?: string;
  startedAt: number;
  durationMs?: number;
}

/** Publisher -> hub -> browser. Every event carries the session id. */
export type SessionEvent =
  | { type: "snapshot"; sessionId: string; meta: SessionMeta; messages: WireMessage[]; partial?: WireMessage | null; tools?: ToolState[] }
  | { type: "meta"; sessionId: string; patch: Partial<SessionMeta> }
  | { type: "message"; sessionId: string; message: WireMessage }
  | { type: "partial"; sessionId: string; message: WireMessage | null }
  | { type: "delta"; sessionId: string; contentIndex: number; kind: "text" | "thinking"; delta: string }
  | { type: "tool"; sessionId: string; tool: ToolState }
  | { type: "notice"; sessionId: string; level: "info" | "warning" | "error"; text: string }
  | { type: "remove"; sessionId: string };

/** Browser -> hub -> publisher. */
export interface ControlCommand {
  cmdId: string;
  sessionId: string;
  action: "prompt" | "abort" | "compact";
  text?: string;
  /** How to deliver a prompt while the agent is busy. */
  mode?: "steer" | "followUp";
}

/** Hub -> browser initial state. */
export interface HubState {
  sessions: Array<{ meta: SessionMeta; messages: WireMessage[]; partial: WireMessage | null; tools: ToolState[] }>;
  hub: { pid: number; startedAt: number; version: string };
}
