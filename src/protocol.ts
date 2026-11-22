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
  /** Which agent runs this session. Unset means pi. */
  agent?: "pi" | "claude";
  /** Control actions this session supports. Unset means all of them (pi). */
  actions?: ControlCommand["action"][];
  /** Short label for subagents, e.g. the run id. */
  label?: string;
  /** Current model as "provider/id". */
  model?: string;
  /** Models the web UI can switch to ("provider/id"): pi's scoped list if set, else every model with auth. */
  models?: string[];
  thinkingLevel?: string;
  /** Thinking levels the current model supports, from pi's model catalogue. */
  thinkingLevels?: string[];
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
  /** True while a compaction (manual or automatic) is running in this session. */
  compacting?: boolean;
  /** What triggered the compaction: manual /compact, the context threshold, or overflow recovery. */
  compactionReason?: "manual" | "threshold" | "overflow";
  /** A question the agent is waiting on (Claude Code's AskUserQuestion). null once it's answered. */
  ask?: AskState | null;
}

export interface AskQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

export interface AskState {
  id: string;
  questions: AskQuestion[];
}

/** A message as shown in the UI (pi AgentMessage, trimmed for transport). */
export type WireMessage = Record<string, any> & { role: string; timestamp?: number };

/** One tool call a codemode script made (pi's `details.calls` on the codemode result). */
export interface CodeCall {
  name: string;
  /** JSON preview of the arguments, already shortened by pi. */
  args?: string;
  status: "running" | "ok" | "error" | "cancelled";
  durationMs?: number;
  cost?: number;
  error?: string;
}

export interface ToolState {
  toolCallId: string;
  toolName: string;
  status: "running" | "done" | "error";
  partial?: string;
  /** codemode: the script's nested calls so far. */
  calls?: CodeCall[];
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
  | { type: "remove"; sessionId: string }
  /** Image bytes, sent once per hub connection. Messages reference it as { type: "image", ref }. */
  | { type: "image"; sessionId: string; ref: string; mimeType: string; data: string };

/** Browser -> hub -> publisher. */
export interface ControlCommand {
  cmdId: string;
  sessionId: string;
  action: "prompt" | "abort" | "compact" | "new" | "model" | "thinking" | "answer";
  text?: string;
  /** For "model": "provider/id". */
  model?: string;
  /** For "thinking": pi thinking level (off, minimal, low, medium, high, xhigh, max). */
  level?: string;
  /** How to deliver a prompt while the agent is busy. */
  mode?: "steer" | "followUp";
  /** For "answer": the AskState id, and question text -> answer (option labels, or the user's own words). */
  qid?: string;
  answers?: Record<string, string>;
}

/** Hub -> browser initial state. */
export interface HubState {
  sessions: Array<{ meta: SessionMeta; messages: WireMessage[]; partial: WireMessage | null; tools: ToolState[] }>;
  hub: { pid: number; startedAt: number; version: string; build: string };
}
