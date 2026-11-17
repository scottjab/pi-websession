import type { WireMessage } from "./protocol.ts";

const MAX_TEXT = 60_000;
const MAX_ARGS = 30_000;
const MAX_PARTIAL_TOOL_OUTPUT = 8_000;

function clip(s: string, max = MAX_TEXT): string {
  if (typeof s !== "string") return s;
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n\n… [${s.length - max} chars truncated] …\n\n${s.slice(-tail)}`;
}

function clipArgs(args: unknown): unknown {
  try {
    const json = JSON.stringify(args);
    if (json && json.length > MAX_ARGS) return { _truncated: clip(json, MAX_ARGS) };
  } catch {
    return { _unserializable: true };
  }
  return args;
}

function block(b: any): any {
  if (!b || typeof b !== "object") return b;
  switch (b.type) {
    case "text":
      return { type: "text", text: clip(b.text ?? "") };
    case "thinking":
      return { type: "thinking", thinking: clip(b.thinking ?? ""), redacted: b.redacted || undefined };
    case "toolCall":
      return { type: "toolCall", id: b.id, name: b.name, arguments: clipArgs(b.arguments) };
    case "image":
      // Images are big; the phone view only needs to know one was there.
      return { type: "image", mimeType: b.mimeType, omitted: true };
    default:
      return { type: b.type ?? "unknown" };
  }
}

function content(c: unknown): unknown {
  if (typeof c === "string") return clip(c);
  if (Array.isArray(c)) return c.map(block);
  return c;
}

/** Trim a pi AgentMessage down to what the web UI renders. Returns undefined to skip. */
export function toWire(m: any): WireMessage | undefined {
  if (!m || typeof m !== "object" || typeof m.role !== "string") return undefined;
  const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
  switch (m.role) {
    case "system":
      return undefined; // prompt + tool declarations, huge and not interesting live
    case "user":
      return { role: "user", content: content(m.content), timestamp: ts };
    case "assistant":
      return {
        role: "assistant",
        content: Array.isArray(m.content) ? m.content.map(block) : [],
        model: m.model,
        provider: m.provider,
        stopReason: m.stopReason,
        errorMessage: m.errorMessage ? clip(m.errorMessage, 4000) : undefined,
        usage: m.usage ? { input: m.usage.input, output: m.usage.output, cost: m.usage.cost?.total } : undefined,
        timestamp: ts,
      };
    case "toolResult":
      return {
        role: "toolResult",
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        content: content(m.content),
        isError: !!m.isError,
        timestamp: ts,
      };
    case "bashExecution":
      return {
        role: "bashExecution",
        command: clip(m.command ?? "", 4000),
        output: clip(m.output ?? ""),
        exitCode: m.exitCode,
        cancelled: m.cancelled,
        timestamp: ts,
      };
    case "custom":
      return {
        role: "custom",
        customType: m.customType,
        content: content(m.content),
        display: m.display,
        timestamp: ts,
      };
    case "branchSummary":
    case "compactionSummary":
      return { role: m.role, summary: clip(m.summary ?? ""), timestamp: ts };
    default:
      return { role: m.role, timestamp: ts };
  }
}

/** Render a tool's partial result (from tool_execution_update) to a short text tail. */
export function partialToolText(partial: any): string | undefined {
  if (!partial) return undefined;
  let text = "";
  const c = partial.content ?? partial;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b?.type === "text").map((b) => b.text).join("");
  if (!text) return undefined;
  return text.length > MAX_PARTIAL_TOOL_OUTPUT ? "…" + text.slice(-MAX_PARTIAL_TOOL_OUTPUT) : text;
}
