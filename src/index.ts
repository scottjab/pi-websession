import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentDir, bindHosts, debug, findSharedRoot, port, readSessionHeader, readShares, removeShare, rotateToken, setShare, tailscaleDnsName, token } from "./config.ts";
import { processNode } from "./node.ts";
import type { ControlCommand, SessionEvent, SessionMeta, ToolState, WireMessage } from "./protocol.ts";
import { codeCalls, partialToolText, toWire } from "./serialize.ts";

const STATUS_KEY = "websession";
const CONSENT_POLL_MS = 4000;
const PARTIAL_THROTTLE_MS = 120;
const TOOL_THROTTLE_MS = 300;

/** Session ids published in this process, so a double-loaded extension doesn't publish twice. */
const ACTIVE = Symbol.for("pi-websession.active-sessions.v1");
function activeSet(): Set<string> {
  const g = globalThis as any;
  g[ACTIVE] ??= new Set<string>();
  return g[ACTIVE];
}

const SELF_PATH = fileURLToPath(import.meta.url);

function shareKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? `id:${ctx.sessionManager.getSessionId()}`;
}

function isSubagentFile(file: string | undefined): boolean {
  return !!file && /[\\/]run-\d+[\\/]session\.jsonl$/.test(file);
}

function subagentLabel(file: string): string {
  // <parent>/<runId>/run-<n>/session.jsonl
  const runDir = dirname(file);
  const runId = basename(dirname(runDir));
  const n = basename(runDir).replace("run-", "");
  return `${runId.slice(0, 8)}${n !== "0" ? `#${n}` : ""}`;
}

async function shareUrl(): Promise<string> {
  const b = bindHosts();
  const dns = b.publicHost ? await tailscaleDnsName() : undefined;
  const host = dns ?? b.publicHost ?? b.lanHosts[0] ?? "127.0.0.1";
  const t = token();
  const lan = b.lanHosts.filter((h) => h !== host).map((h) => `http://${h}:${port()}/?t=${t}`);
  return [`http://${host}:${port()}/?t=${t}`, ...lan.map((u) => `${u} (LAN)`)].join("\n");
}

// ---------------------------------------------------------------------------
// pi-subagents integration: make foreground children (which don't load ambient
// extensions) load this extension too, so their sessions show up.
// ---------------------------------------------------------------------------

type RequiredReg = { dispose(): void };

async function loadRequiredChildApi(): Promise<((input: any) => RequiredReg) | undefined> {
  const candidates: string[] = [];
  if (process.env.PI_WEBSESSION_SUBAGENTS_PATH) candidates.push(process.env.PI_WEBSESSION_SUBAGENTS_PATH);
  const ad = agentDir();
  try {
    const settings = JSON.parse(readFileSync(join(ad, "settings.json"), "utf8"));
    for (const p of settings.packages ?? []) {
      const src = typeof p === "string" ? p : p?.source;
      if (typeof src !== "string" || !src.includes("pi-subagents")) continue;
      if (src.startsWith("npm:")) candidates.push(join(ad, "npm", "node_modules", "pi-subagents"));
      else if (!src.includes(":")) candidates.push(isAbsolute(src) ? src : resolve(ad, src));
    }
  } catch {}
  candidates.push(join(ad, "npm", "node_modules", "pi-subagents"));
  for (const dir of candidates) {
    const file = join(dir, "bundle", "required-child-extensions.js");
    if (!existsSync(file)) continue;
    try {
      const mod = await import(pathToFileURL(file).href);
      if (typeof mod.registerRequiredChildExtensions === "function") return mod.registerRequiredChildExtensions;
    } catch {}
  }
  try {
    const mod: any = await import("pi-subagents/required-child-extensions" as string);
    if (typeof mod.registerRequiredChildExtensions === "function") return mod.registerRequiredChildExtensions;
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// Publisher: mirrors one pi session to the hub.
// ---------------------------------------------------------------------------

class Publisher {
  readonly id: string;
  private meta: SessionMeta;
  private partial: WireMessage | null = null;
  private pendingDeltas: Array<{ contentIndex: number; kind: "text" | "thinking"; delta: string }> = [];
  private partialDirty = false;
  private partialTimer?: NodeJS.Timeout;
  private tools = new Map<string, ToolState>();
  private toolTimers = new Map<string, NodeJS.Timeout>();
  private consentTimer?: NodeJS.Timeout;
  private requiredReg?: RequiredReg;
  private stopped = false;
  private pi: ExtensionAPI;
  ctx: ExtensionContext;
  private shareRootKey: string;
  private onRevoked: () => void;

  constructor(pi: ExtensionAPI, ctx: ExtensionContext, shareRootKey: string, controllable: boolean, onRevoked: () => void) {
    this.pi = pi;
    this.ctx = ctx;
    this.shareRootKey = shareRootKey;
    this.onRevoked = onRevoked;
    const sm = ctx.sessionManager;
    const file = sm.getSessionFile();
    const header = sm.getHeader() as any;
    const sub = isSubagentFile(file);
    this.id = sm.getSessionId();
    this.meta = {
      id: this.id,
      file,
      parentFile: header?.parentSession,
      name: sm.getSessionName() ?? undefined,
      cwd: sm.getCwd(),
      kind: sub ? "subagent" : "main",
      label: sub && file ? subagentLabel(file) : undefined,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinkingLevel: (ctx as any).thinkingLevel,
      thinkingLevels: this.levelsFor(ctx.model),
      status: ctx.isIdle() ? "idle" : "running",
      controllable,
      pid: process.pid,
      host: hostname(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  start(): void {
    activeSet().add(this.id);
    processNode().register({ id: this.id, snapshot: () => this.snapshot(), onCommand: (c) => this.onCommand(c) });
    this.consentTimer = setInterval(() => this.checkConsent(), CONSENT_POLL_MS);
    this.consentTimer.unref();
    if (this.meta.kind === "main") void this.registerChildExtension();
  }

  stop(how: "remove" | "ended" = "remove"): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.consentTimer);
    clearTimeout(this.partialTimer);
    for (const t of this.toolTimers.values()) clearTimeout(t);
    this.requiredReg?.dispose();
    this.requiredReg = undefined;
    activeSet().delete(this.id);
    processNode().unregister(this.id, how);
  }

  private async registerChildExtension(): Promise<void> {
    try {
      const register = await loadRequiredChildApi();
      if (!register || this.stopped) return;
      this.requiredReg = register({ sessionId: this.id, extensions: [{ id: "pi-websession", path: SELF_PATH }] });
      debug("required child extension registered", this.id);
    } catch (err: any) {
      debug("required child extension failed", String(err?.stack ?? err));
      // Already registered for this session, or pi-subagents too old. Not fatal:
      // background children still load us as an ambient extension.
      this.emit({ type: "notice", sessionId: this.id, level: "warning", text: `Subagent hook unavailable: ${err?.message ?? err}` });
    }
  }

  get kind(): SessionMeta["kind"] {
    return this.meta.kind;
  }

  setControllable(on: boolean): void {
    if (this.meta.controllable === on) return;
    this.meta.controllable = on;
    this.emit({ type: "meta", sessionId: this.id, patch: { controllable: on } });
  }

  /**
   * False once pi disposed this session. In-process subagents are disposed
   * with AgentSession.dispose(), which never fires session_shutdown, so the
   * only sign is that the ctx turns stale and its accessors throw.
   */
  private ctxAlive(): boolean {
    try {
      this.ctx.isIdle();
      return true;
    } catch {
      return false;
    }
  }

  private checkConsent(): void {
    if (!this.ctxAlive()) {
      debug("session disposed without shutdown", this.id);
      this.stop(this.meta.kind === "subagent" ? "ended" : "remove");
      this.onRevoked();
      return;
    }
    const root = this.meta.kind === "main" && this.shareRootKey === shareKey(this.ctx) ? { entry: readShares()[this.shareRootKey] } : findSharedRoot(this.meta.file, this.meta.parentFile);
    if (!root?.entry) {
      this.stop();
      this.onRevoked();
      return;
    }
    this.setControllable(!!root.entry.control);
  }

  private emit(ev: SessionEvent): void {
    if (this.stopped && ev.type !== "remove") return;
    processNode().publish(ev);
  }

  patch(p: Partial<SessionMeta>): void {
    Object.assign(this.meta, p, { updatedAt: Date.now() });
    this.emit({ type: "meta", sessionId: this.id, patch: p });
  }

  private imageSink = (ref: string, mimeType: string, data: string): void => {
    processNode().publishImage(this.id, ref, mimeType, data);
  };

  snapshot(): SessionEvent {
    const messages: WireMessage[] = [];
    let input = 0;
    let output = 0;
    let cost = 0;
    for (const e of this.ctx.sessionManager.getBranch() as any[]) {
      let m: any;
      if (e.type === "message") m = e.message;
      else if (e.type === "custom_message") m = { role: "custom", customType: e.customType, content: e.content, display: e.display, timestamp: Date.parse(e.timestamp) };
      else if (e.type === "compaction") m = { role: "compactionSummary", summary: e.summary, timestamp: Date.parse(e.timestamp) };
      else if (e.type === "branch_summary") m = { role: "branchSummary", summary: e.summary, timestamp: Date.parse(e.timestamp) };
      const w = toWire(m, this.imageSink);
      if (!w) continue;
      if (m.role === "assistant" && m.usage) {
        input += m.usage.input ?? 0;
        output += m.usage.output ?? 0;
        cost += m.usage.cost?.total ?? 0;
      }
      messages.push(w);
    }
    this.meta.usage = { input, output, cost };
    this.refreshContext();
    this.refreshModels();
    return {
      type: "snapshot",
      sessionId: this.id,
      meta: { ...this.meta },
      messages,
      partial: this.partial,
      tools: [...this.tools.values()],
    };
  }

  /** Thinking levels pi supports for this model (from the model's thinkingLevelMap). */
  levelsFor(model: any): string[] | undefined {
    try {
      return model ? [...getSupportedThinkingLevels(model)] : undefined;
    } catch {
      return undefined;
    }
  }

  /** Models offered in the web picker. Same set pi's own model cycling uses. */
  private refreshModels(): void {
    try {
      const scoped = this.ctx.scopedModels?.map((s) => s.model) ?? [];
      const list = scoped.length ? scoped : this.ctx.modelRegistry.getAvailable();
      // No cap: a big catalog (openrouter is ~400) would push later providers off the list.
      const ids = [...new Set(list.map((m) => `${m.provider}/${m.id}`))];
      if (this.meta.model && !ids.includes(this.meta.model)) ids.unshift(this.meta.model);
      this.meta.models = ids;
    } catch {}
  }

  /** Re-send the picker list if it changed (auth added, scope changed). */
  syncModels(): void {
    const before = JSON.stringify(this.meta.models ?? []);
    this.refreshModels();
    if (JSON.stringify(this.meta.models ?? []) !== before) this.emit({ type: "meta", sessionId: this.id, patch: { models: this.meta.models } });
  }

  private refreshContext(): void {
    try {
      const u = this.ctx.getContextUsage();
      if (u?.percent != null) this.meta.contextPercent = Math.round(u.percent);
    } catch {}
  }

  // --- streaming assistant output ---

  messageStart(m: any): void {
    if (m?.role !== "assistant") return;
    this.partial = toWire(m) ?? null;
    this.pendingDeltas = [];
    this.partialDirty = true;
    this.schedulePartial();
  }

  messageUpdate(m: any, ev: any): void {
    if (m?.role !== "assistant") return;
    this.partial = toWire(m) ?? null;
    if (ev && (ev.type === "text_delta" || ev.type === "thinking_delta") && !this.partialDirty) {
      const kind = ev.type === "text_delta" ? "text" : "thinking";
      const last = this.pendingDeltas[this.pendingDeltas.length - 1];
      if (last && last.contentIndex === ev.contentIndex && last.kind === kind) last.delta += ev.delta;
      else this.pendingDeltas.push({ contentIndex: ev.contentIndex, kind, delta: ev.delta });
    } else {
      // Structural change (new block, tool call args...). Resend the whole partial.
      this.partialDirty = true;
      this.pendingDeltas = [];
    }
    this.schedulePartial();
  }

  private schedulePartial(): void {
    this.partialTimer ??= setTimeout(() => this.flushPartial(), PARTIAL_THROTTLE_MS);
  }

  private flushPartial(): void {
    this.partialTimer = undefined;
    if (this.partialDirty) {
      this.partialDirty = false;
      this.pendingDeltas = [];
      this.emit({ type: "partial", sessionId: this.id, message: this.partial });
      return;
    }
    for (const d of this.pendingDeltas) this.emit({ type: "delta", sessionId: this.id, ...d });
    this.pendingDeltas = [];
  }

  messageEnd(m: any): void {
    if (m?.role === "assistant") {
      clearTimeout(this.partialTimer);
      this.partialTimer = undefined;
      this.partial = null;
      this.pendingDeltas = [];
      this.partialDirty = false;
      if (m.usage && this.meta.usage) {
        this.meta.usage.input += m.usage.input ?? 0;
        this.meta.usage.output += m.usage.output ?? 0;
        this.meta.usage.cost += m.usage.cost?.total ?? 0;
      }
    }
    const w = toWire(m, this.imageSink);
    if (w) this.emit({ type: "message", sessionId: this.id, message: w });
    if (m?.role === "assistant") {
      this.refreshContext();
      this.patch({ usage: this.meta.usage, contextPercent: this.meta.contextPercent });
    }
  }

  // --- tools ---

  toolStart(e: any): void {
    const t: ToolState = { toolCallId: e.toolCallId, toolName: e.toolName, status: "running", startedAt: Date.now() };
    this.tools.set(t.toolCallId, t);
    this.emit({ type: "tool", sessionId: this.id, tool: t });
  }

  toolUpdate(e: any): void {
    const t = this.tools.get(e.toolCallId);
    if (!t) return;
    t.partial = partialToolText(e.partialResult);
    const calls = codeCalls(e.partialResult?.details);
    if (calls) t.calls = calls;
    if (this.toolTimers.has(t.toolCallId)) return;
    this.toolTimers.set(
      t.toolCallId,
      setTimeout(() => {
        this.toolTimers.delete(t.toolCallId);
        if (t.status === "running") this.emit({ type: "tool", sessionId: this.id, tool: { ...t } });
      }, TOOL_THROTTLE_MS),
    );
  }

  toolEnd(e: any): void {
    const t: ToolState = this.tools.get(e.toolCallId) ?? { toolCallId: e.toolCallId, toolName: e.toolName, startedAt: Date.now(), status: "running" };
    clearTimeout(this.toolTimers.get(t.toolCallId));
    this.toolTimers.delete(t.toolCallId);
    t.status = e.isError ? "error" : "done";
    t.durationMs = e.durationMs ?? Date.now() - t.startedAt;
    t.partial = undefined;
    t.calls = undefined; // the tool result carries the final list
    this.emit({ type: "tool", sessionId: this.id, tool: { ...t } });
    this.tools.delete(t.toolCallId);
  }

  // --- control from the web UI ---

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.emit({ type: "notice", sessionId: this.id, level, text });
  }

  onCommand(cmd: ControlCommand): void {
    // Re-check consent at the moment of acting; the hub's copy may be stale.
    const root = findSharedRoot(this.meta.file, this.meta.parentFile) ?? (readShares()[this.shareRootKey] ? { entry: readShares()[this.shareRootKey] } : undefined);
    if (!root?.entry?.control) {
      this.setControllable(false);
      this.notice("error", "Web control is not enabled. Run /web control in pi to allow it.");
      return;
    }
    const ctx = this.ctx;
    switch (cmd.action) {
      case "abort":
        if (ctx.isIdle()) return this.notice("info", "Already idle.");
        ctx.abort();
        this.notice("info", "Abort requested.");
        return;
      case "compact":
        ctx.compact({
          onComplete: () => this.notice("info", "Compaction finished."),
          onError: (err: Error) => this.notice("error", `Compaction failed: ${err.message}`),
        });
        this.notice("info", "Compaction started.");
        return;
      case "new": {
        if (this.meta.kind === "subagent") return this.notice("error", "New context is only available for main sessions.");
        if (!ctx.isIdle()) return this.notice("error", "Wait for the current run to finish (or abort) before starting a new context.");
        // Command contexts are what carry newSession(); route through our own
        // /web command to get one. The /web handler does the actual switch.
        this.pi.sendUserMessage("/web new", { expandPromptTemplates: true } as any);
        return;
      }
      case "model": {
        const want = String(cmd.model ?? "");
        const slash = want.indexOf("/");
        const model = slash > 0 ? ctx.modelRegistry.find(want.slice(0, slash), want.slice(slash + 1)) : undefined;
        if (!model) return this.notice("error", `Unknown model: ${want}`);
        if (want === this.meta.model) return;
        // Session-only, like picking a model for this chat. pi's saved default stays as is.
        this.pi.setModel(model).then(
          (ok) => {
            if (!ok) return this.notice("error", `No API key for ${want}.`);
            this.notice("info", `Model set to ${want}.`);
            if (ctx.hasUI) ctx.ui.notify(`[web] model → ${want}`, "info");
          },
          (err: any) => this.notice("error", `Model switch failed: ${err?.message ?? err}`),
        );
        return;
      }
      case "thinking": {
        const level = String(cmd.level ?? "");
        const allowed = this.levelsFor(ctx.model) ?? [];
        if (!allowed.length) return this.notice("error", "This model does not support thinking levels.");
        if (!allowed.includes(level)) return this.notice("error", `Unknown thinking level for this model: ${level} (supported: ${allowed.join(", ")})`);
        if (level === (this.meta.thinkingLevel ?? undefined)) return;
        // Session-only, like the model picker. pi clamps to levels the model supports.
        try {
          (this.pi as any).setThinkingLevel(level);
          this.notice("info", `Thinking level set to ${level}.`);
          if (ctx.hasUI) ctx.ui.notify(`[web] thinking → ${level}`, "info");
        } catch (err: any) {
          this.notice("error", `Thinking level change failed: ${err?.message ?? err}`);
        }
        return;
      }
      case "prompt": {
        const text = (cmd.text ?? "").trim();
        if (!text) return;
        if (ctx.isIdle()) {
          this.pi.sendUserMessage(text, { expandPromptTemplates: true } as any);
          this.notice("info", "Prompt sent.");
        } else {
          const mode = cmd.mode === "followUp" ? "followUp" : "steer";
          this.pi.sendUserMessage(text, { deliverAs: mode });
          this.notice("info", mode === "steer" ? "Steering message queued." : "Follow-up queued.");
        }
        if (ctx.hasUI) ctx.ui.notify(`[web] ${text.length > 80 ? text.slice(0, 80) + "…" : text}`, "info");
        return;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function websession(pi: ExtensionAPI) {
  let pub: Publisher | undefined;
  let ctxRef: ExtensionContext | undefined;
  let offNodeChange: (() => void) | undefined;

  pi.registerFlag("web", {
    description: "Share this session over HTTP (same as running /web on)",
    type: "boolean",
    default: false,
  });

  const updateStatus = async () => {
    const ctx = ctxRef;
    try {
      if (!ctx?.hasUI) return;
    } catch {
      return; // stale ctx: the session was disposed
    }
    if (!pub) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const node = processNode();
    const ctl = readShares()[shareKey(ctx)]?.control ? " +ctl" : "";
    const where = node.mode === "hub" ? "hub" : node.mode === "client" ? "on" : node.mode;
    ctx.ui.setStatus(STATUS_KEY, `web:${where}${ctl}${node.lastError ? " ⚠" : ""}`);
  };

  const startPublishing = (ctx: ExtensionContext, rootKey: string, control: boolean) => {
    if (pub) return;
    const id = ctx.sessionManager.getSessionId();
    if (activeSet().has(id)) return; // another copy of this extension already publishes it
    pub = new Publisher(pi, ctx, rootKey, control, () => {
      pub = undefined;
      void updateStatus();
    });
    pub.start();
    offNodeChange ??= processNode().onChange(() => void updateStatus());
    void updateStatus();
  };

  const stopPublishing = (how: "remove" | "ended" = "remove") => {
    pub?.stop(how);
    pub = undefined;
    offNodeChange?.();
    offNodeChange = undefined;
    void updateStatus();
  };

  debug("factory loaded", SELF_PATH);

  pi.on("session_start", async (e: any, ctx) => {
    ctxRef = ctx;
    debug("session_start", e?.reason, ctx.sessionManager.getSessionId(), ctx.sessionManager.getSessionFile(), (ctx.sessionManager.getHeader() as any)?.parentSession);
    const key = shareKey(ctx);
    if (pi.getFlag("web") && !readShares()[key]) {
      setShare(key, { control: false, enabledAt: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId() });
    }
    const header = ctx.sessionManager.getHeader() as any;
    const root = findSharedRoot(ctx.sessionManager.getSessionFile(), header?.parentSession) ?? (readShares()[key] ? { key, entry: readShares()[key] } : undefined);
    if (!root) return;
    startPublishing(ctx, root.key, !!root.entry.control);
    if (ctx.hasUI && root.key === key) {
      ctx.ui.notify(`Web sharing is on for this session: ${await shareUrl()}`, "info");
    }
  });

  pi.on("session_shutdown", async () => {
    // Keep the opt-in recorded so background subagents stay visible and a
    // resumed session comes back shared. /web off clears it.
    // Finished subagents stay listed (as ended); a main session that quits goes away.
    stopPublishing(pub?.kind === "subagent" ? "ended" : "remove");
    ctxRef = undefined;
    // Background runners exit right after this; get the last events out first.
    await processNode().drain(1500);
  });

  const touch = (ctx: ExtensionContext) => {
    ctxRef = ctx;
    if (pub) pub.ctx = ctx;
  };

  pi.on("agent_start", async (_e, ctx) => {
    touch(ctx);
    pub?.patch({ status: "running" });
  });
  pi.on("agent_settled", async (_e, ctx) => {
    touch(ctx);
    pub?.patch({ status: "idle" });
  });
  pi.on("ui_prompt_start", async (_e, ctx) => {
    touch(ctx);
    pub?.patch({ status: "waiting_ui" });
  });
  pi.on("ui_prompt_end", async (_e, ctx) => {
    touch(ctx);
    pub?.patch({ status: ctx.isIdle() ? "idle" : "running" });
  });
  pi.on("message_start", async (e, ctx) => {
    touch(ctx);
    pub?.messageStart(e.message);
  });
  pi.on("message_update", async (e: any, ctx) => {
    touch(ctx);
    pub?.messageUpdate(e.message, e.assistantMessageEvent);
  });
  pi.on("message_end", async (e, ctx) => {
    touch(ctx);
    pub?.messageEnd(e.message);
  });
  pi.on("tool_execution_start", async (e, ctx) => {
    touch(ctx);
    if ((e as any).parentToolCallId) return; // nested (codemode): listed in the parent's details.calls
    pub?.toolStart(e);
  });
  pi.on("tool_execution_update", async (e, ctx) => {
    touch(ctx);
    if ((e as any).parentToolCallId) return; // nested (codemode): listed in the parent's details.calls
    pub?.toolUpdate(e);
  });
  pi.on("tool_execution_end", async (e, ctx) => {
    touch(ctx);
    if ((e as any).parentToolCallId) return; // nested (codemode): listed in the parent's details.calls
    pub?.toolEnd(e);
  });
  pi.on("model_select", async (e: any, ctx) => {
    touch(ctx);
    const m = e.model ?? ctx.model;
    if (m) pub?.patch({ model: `${m.provider}/${m.id}`, thinkingLevels: pub.levelsFor(m) });
    pub?.syncModels();
  });
  pi.on("thinking_level_select", async (e: any, ctx) => {
    touch(ctx);
    pub?.patch({ thinkingLevel: e.level ?? e.thinkingLevel });
  });
  pi.on("session_info_changed", async (e: any, ctx) => {
    touch(ctx);
    pub?.patch({ name: e.name });
  });
  pi.on("session_before_compact", async (e, ctx) => {
    touch(ctx);
    // reason tells manual (/compact or the web button) apart from automatic (threshold or overflow recovery).
    pub?.patch({ compacting: true, compactionReason: e.reason });
  });
  pi.on("session_compact", async (_e, ctx) => {
    touch(ctx);
    pub?.patch({ compacting: false, compactionReason: undefined });
    // History changed shape; resend everything.
    if (pub) processNode().publish(pub.snapshot());
  });
  pi.on("session_compact_failed", async (_e, ctx) => {
    touch(ctx);
    // Also covers aborts and extensions cancelling in session_before_compact.
    pub?.patch({ compacting: false, compactionReason: undefined });
  });
  pi.on("session_tree", async (_e, ctx) => {
    touch(ctx);
    if (pub) processNode().publish(pub.snapshot());
  });

  pi.registerCommand("web", {
    description: "Share this session over HTTP: /web [on|off|control|nocontrol|new|url|status|rotate]",
    getArgumentCompletions: (prefix: string) => {
      const items = ["on", "off", "control", "nocontrol", "new", "url", "status", "rotate"].map((v) => ({ value: v, label: v }));
      const f = items.filter((i) => i.value.startsWith(prefix.trim()));
      return f.length ? f : null;
    },
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const sub = (args ?? "").trim().toLowerCase() || "on";
      const key = shareKey(ctx);
      const existing = readShares()[key];
      const say = (msg: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(msg, level);

      switch (sub) {
        case "on": {
          if (!existing) setShare(key, { control: false, enabledAt: new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId() });
          startPublishing(ctx, key, !!existing?.control);
          const b = bindHosts();
          say(`Sharing this session (view only${existing?.control ? " + control" : ""}). Open: ${await shareUrl()}${b.warning ? `\n⚠ ${b.warning}` : ""}\nRun /web control to allow prompting from the browser.`);
          return;
        }
        case "control": {
          const ok = await ctx.ui.confirm(
            "Allow web control?",
            "Anyone with the URL+token can send prompts, steer, abort, compact, start new contexts in this session and its subagents from a browser. Allow?",
          );
          if (!ok) return say("Web control not enabled.");
          setShare(key, { control: true, enabledAt: existing?.enabledAt ?? new Date().toISOString(), sessionId: ctx.sessionManager.getSessionId() });
          startPublishing(ctx, key, true);
          pub?.setControllable(true);
          void updateStatus();
          say(`Web control enabled. ${await shareUrl()}`);
          return;
        }
        case "nocontrol": {
          if (!existing) return say("This session isn't shared.");
          setShare(key, { ...existing, control: false });
          pub?.setControllable(false);
          void updateStatus();
          say("Web control disabled (still sharing view only).");
          return;
        }
        case "off": {
          removeShare(key);
          stopPublishing("remove");
          say("Web sharing off for this session. Subagents stop publishing within a few seconds.");
          return;
        }
        case "new": {
          if (!ctx.isIdle()) return say("Wait for the current run to finish (or abort) before starting a new context.", "warning");
          say("Starting a new context…");
          try {
            // parentSession keeps the share entry reachable: the replacement
            // session's session_start finds it through the parent chain and
            // starts publishing with the same control flag.
            const res = await (ctx as any).newSession({ parentSession: ctx.sessionManager.getSessionFile() });
            if (res?.cancelled) say("New session was cancelled.");
          } catch (err: any) {
            say(`New session failed: ${err?.message ?? err}`, "error");
          }
          return;
        }
        case "url":
          say(await shareUrl());
          return;
        case "rotate": {
          rotateToken();
          say(`New token. Restart other pi processes that are sharing so they pick it up.\n${await shareUrl()}`, "warning");
          return;
        }
        case "status": {
          const node = processNode();
          const shares = Object.keys(readShares()).length;
          say(
            [
              `this session: ${pub ? "shared" : "not shared"}${existing?.control ? " (control on)" : ""}`,
              `node: ${node.mode}${node.hub ? ` (hub on ${node.hub.hosts.join(", ")}:${port()})` : ""}`,
              node.lastError ? `last error: ${node.lastError}` : "",
              `opted-in sessions on disk: ${shares}`,
              `url: ${await shareUrl()}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
          return;
        }
        default:
          say("Usage: /web [on|off|control|nocontrol|new|url|status|rotate]", "warning");
      }
    },
  });
}
