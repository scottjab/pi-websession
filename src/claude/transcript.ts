// Claude Code transcript (JSONL) -> pi-shaped messages the web UI already renders.
//
// Claude Code writes one line per content block, so an assistant message shows
// up as several lines sharing message.id. The converter keeps the newest one
// open (shown as the live partial) and closes it when something else arrives.

export interface TranscriptSink {
  /** A finished message (pi AgentMessage shape; the caller runs it through toWire). */
  message(m: any): void;
  /** The assistant message still being written, or null when there's none. */
  partial(m: any | null): void;
  /** Session facts picked up from the transcript. */
  meta(p: { name?: string; model?: string; cwd?: string; compacting?: boolean; usage?: { input: number; output: number; cost: number }; turnDone?: boolean; turnStart?: boolean }): void;
}

const SYS_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>\s*/g;

/** Claude Code tool names -> the names the UI has special rendering for. */
function toolName(name: string): string {
  switch (name) {
    case "Agent":
    case "Task":
      return "subagent";
    default:
      return name;
  }
}

/** Map Claude Code tool inputs onto what the UI's cards read (path, edits[{oldText,newText}]). */
function toolArgs(name: string, input: any): any {
  if (!input || typeof input !== "object") return input;
  switch (name) {
    case "Edit":
      return { ...input, path: input.file_path, edits: [{ oldText: input.old_string ?? "", newText: input.new_string ?? "" }] };
    case "MultiEdit":
      return { ...input, path: input.file_path, edits: (input.edits ?? []).map((e: any) => ({ oldText: e?.old_string ?? "", newText: e?.new_string ?? "" })) };
    case "Read":
    case "Write":
      return { ...input, path: input.file_path };
    default:
      return input;
  }
}

function imageBlock(b: any): any {
  const src = b?.source;
  if (src?.type === "base64" && typeof src.data === "string") return { type: "image", mimeType: src.media_type || "image/png", data: src.data };
  return { type: "image", mimeType: "image/png" };
}

/** Plain user text, minus Claude Code's injected reminders. Slash commands read as "/name args". */
function userText(s: string): string | undefined {
  const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/.exec(s);
  if (cmd) return `${cmd[1].trim()}${cmd[2]?.trim() ? " " + cmd[2].trim() : ""}`;
  const t = s.replace(SYS_REMINDER, "").trim();
  return t || undefined;
}

function resultContent(c: any): any[] {
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (!Array.isArray(c)) return [];
  return c.map((b) => (b?.type === "image" ? imageBlock(b) : b?.type === "text" ? { type: "text", text: b.text ?? "" } : { type: "text", text: JSON.stringify(b) }));
}

function patchDiff(sp: any): string | undefined {
  if (!Array.isArray(sp) || !sp.length) return undefined;
  return sp.map((h: any) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${(h.lines ?? []).join("\n")}`).join("\n");
}

export class TranscriptReader {
  private open?: { id: string; msg: any };
  private toolStarted = new Map<string, number>();
  private toolNames = new Map<string, string>();
  private counted = new Set<string>();
  private usage = { input: 0, output: 0, cost: 0 };

  private sink: TranscriptSink;

  constructor(sink: TranscriptSink) {
    this.sink = sink;
  }

  /** Close the assistant message in progress, if any. */
  flush(): void {
    if (!this.open) return;
    const m = this.open.msg;
    this.open = undefined;
    this.sink.partial(null);
    this.sink.message(m);
  }

  /** Whether an assistant message is still being written. */
  get streaming(): boolean {
    return !!this.open;
  }

  line(e: any): void {
    if (!e || typeof e !== "object") return;
    if (e.isSidechain && !e.agentId) return;
    const ts = Date.parse(e.timestamp) || Date.now();
    switch (e.type) {
      case "ai-title":
      case "custom-title":
      case "summary": {
        const name = e.customTitle ?? e.aiTitle ?? (e.type === "summary" ? e.summary : undefined);
        if (typeof name === "string" && name.trim()) this.sink.meta({ name: name.trim() });
        return;
      }
      case "system":
        if (e.subtype === "compact_boundary") {
          this.flush();
          this.sink.meta({ compacting: false });
        } else if (e.subtype === "turn_duration") {
          this.flush();
          this.sink.meta({ turnDone: true });
        }
        return;
      case "assistant":
        return this.assistant(e, ts);
      case "user":
        return this.user(e, ts);
    }
  }

  private assistant(e: any, ts: number): void {
    const m = e.message;
    if (!m || !Array.isArray(m.content)) return;
    const id = m.id ?? e.uuid;
    if (this.open && this.open.id !== id) this.flush();
    if (!this.open) {
      this.open = {
        id,
        msg: { role: "assistant", content: [], model: m.model, provider: "anthropic", timestamp: ts },
      };
      if (m.model && m.model !== "<synthetic>") this.sink.meta({ model: `anthropic/${m.model}` });
    }
    const msg = this.open.msg;
    msg.stopReason = m.stop_reason ?? msg.stopReason;
    for (const b of m.content) {
      if (b?.type === "text") msg.content.push({ type: "text", text: b.text ?? "" });
      else if (b?.type === "thinking") msg.content.push({ type: "thinking", thinking: b.thinking ?? "", redacted: !b.thinking || undefined });
      else if (b?.type === "redacted_thinking") msg.content.push({ type: "thinking", thinking: "", redacted: true });
      else if (b?.type === "tool_use" || b?.type === "server_tool_use") {
        msg.content.push({ type: "toolCall", id: b.id, name: toolName(b.name), arguments: toolArgs(b.name, b.input) });
        this.toolStarted.set(b.id, ts);
        this.toolNames.set(b.id, b.name);
      }
    }
    if (m.usage && !this.counted.has(id)) {
      this.counted.add(id);
      const u = m.usage;
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      msg.usage = { input, output: u.output_tokens ?? 0 };
      this.usage.input += input;
      this.usage.output += u.output_tokens ?? 0;
      this.sink.meta({ usage: { ...this.usage } });
    }
    if (m.stop_reason === "end_turn" || m.stop_reason === "stop_sequence") this.flush();
    else this.sink.partial(msg);
  }

  private user(e: any, ts: number): void {
    const m = e.message;
    if (!m || e.isMeta) return;
    this.flush();
    if (e.isCompactSummary) {
      const text = typeof m.content === "string" ? m.content : resultContent(m.content).map((b) => b.text ?? "").join("\n");
      this.sink.message({ role: "compactionSummary", summary: text, timestamp: ts });
      return;
    }
    if (typeof m.content === "string") {
      if (/^<local-command-(stdout|stderr)>/.test(m.content)) {
        const out = m.content.replace(/<\/?local-command-(stdout|stderr)>/g, "").trim();
        if (out) this.sink.message({ role: "custom", customType: "claude-command", content: out, display: true, timestamp: ts });
        return;
      }
      // Background agent finished, hook woke the session, etc. Not something the user typed.
      if (/^\s*<task-notification>/.test(m.content)) {
        const summary = /<summary>([\s\S]*?)<\/summary>/.exec(m.content)?.[1]?.trim();
        // A hook waking the session: the web prompt it carried is already shown.
        if (summary && !/hook feedback$/i.test(summary)) this.sink.message({ role: "custom", customType: "notification", content: summary, display: true, timestamp: ts });
        return;
      }
      const t = userText(m.content);
      if (t) {
        this.sink.message({ role: "user", content: t, timestamp: ts });
        this.sink.meta({ turnStart: true });
      }
      return;
    }
    if (!Array.isArray(m.content)) return;
    const rest: any[] = [];
    for (const b of m.content) {
      if (b?.type === "tool_result") {
        const ccName = this.toolNames.get(b.tool_use_id) ?? "";
        const tur = e.toolUseResult && typeof e.toolUseResult === "object" ? e.toolUseResult : undefined;
        let content = resultContent(b.content);
        // Read results come back numbered ("  12→line"); the UI numbers lines itself.
        if (ccName === "Read" && typeof tur?.file?.content === "string") content = [{ type: "text", text: tur.file.content }];
        const started = this.toolStarted.get(b.tool_use_id);
        this.sink.message({
          role: "toolResult",
          toolCallId: b.tool_use_id,
          toolName: toolName(ccName),
          content,
          isError: !!b.is_error,
          durationMs: started ? Math.max(0, ts - started) : undefined,
          details: ccName === "Edit" || ccName === "MultiEdit" || ccName === "Write" ? { diff: patchDiff(tur?.structuredPatch) } : undefined,
          timestamp: ts,
        });
        this.toolStarted.delete(b.tool_use_id);
      } else if (b?.type === "text") {
        const t = userText(b.text ?? "");
        if (t) rest.push({ type: "text", text: t });
      } else if (b?.type === "image") rest.push(imageBlock(b));
    }
    if (rest.length) {
      this.sink.message({ role: "user", content: rest, timestamp: ts });
      this.sink.meta({ turnStart: true });
    }
  }
}
