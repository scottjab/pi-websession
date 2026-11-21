// One bridge process per shared Claude Code session. Started detached by the
// hooks (`node bridge.ts <session_id>`). It tails the session's transcript and
// its subagents' transcripts, publishes them to the hub like a pi session, and
// turns web commands into inbox files the hooks deliver.

import { existsSync, closeSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUILD, computeBuild, debug, readShares } from "../config.ts";
import { processNode } from "../node.ts";
import type { ControlCommand, SessionEvent, SessionMeta, WireMessage } from "../protocol.ts";
import { toWire } from "../serialize.ts";
import { claudeShareKey, enqueue, pidAlive, readPid, sessionDir, type HookEvent } from "./state.ts";
import { TranscriptReader } from "./transcript.ts";

const POLL_MS = 250;
const CHECK_MS = 3000;
/** How often to look for a newer copy of the plugin code. */
const BUILD_CHECK_MS = 30_000;
/** Transcript lines this soon after a subagent finished are its last writes, not a restart. */
const RESUME_GRACE_MS = 5000;
const PARTIAL_THROTTLE_MS = 150;
const MAX_MESSAGES = 4000;
/** Subagents that finished longer ago than this aren't listed when the bridge starts. */
const SUBAGENT_RECENT_MS = 30 * 60 * 1000;
const ACTIONS: ControlCommand["action"][] = ["prompt", "abort"];

const sid = process.argv[2] ?? "";
let mainThread: Thread | undefined;
const dir = sessionDir(sid);

/** Reads whole lines appended to a file since the last call. */
class Tail {
  private offset = 0;
  private rest = "";
  readonly file: string;
  constructor(file: string, fromEnd = false) {
    this.file = file;
    if (fromEnd) {
      try {
        this.offset = statSync(file).size;
      } catch {}
    }
  }
  read(): any[] {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0; // truncated or replaced
      this.rest = "";
    }
    if (size === this.offset) return [];
    const fd = openSync(this.file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size - this.offset, 64 * 1024 * 1024));
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      const text = this.rest + buf.subarray(0, n).toString("utf8");
      const lines = text.split("\n");
      this.rest = lines.pop() ?? "";
      const out: any[] = [];
      for (const l of lines) {
        if (!l.trim()) continue;
        try {
          out.push(JSON.parse(l));
        } catch {}
      }
      return out;
    } finally {
      closeSync(fd);
    }
  }
}

function notice(id: string, level: "info" | "warning" | "error", text: string): void {
  processNode().publish({ type: "notice", sessionId: id, level, text });
}

function controlOn(): boolean {
  return !!readShares()[claudeShareKey(sid)]?.control;
}

/** Is an idle waiter (the asyncRewake Stop hook) running right now? */
function waiterAlive(): boolean {
  try {
    const [tok, pid] = readFileSync(join(dir, "waiter"), "utf8").split(" ");
    return tok !== "busy" && pidAlive(Number(pid));
  } catch {
    return false;
  }
}

/** One Claude Code thread (main session or a subagent) as a hub session. */
class Thread {
  meta: SessionMeta;
  private messages: WireMessage[] = [];
  private partial: WireMessage | null = null;
  private partialTimer?: NodeJS.Timeout;
  private reader: TranscriptReader;
  private tail: Tail;
  registered = false;
  private dropTimer?: NodeJS.Timeout;
  readonly file: string;
  readonly agentId: string | undefined;
  /** False while replaying the transcript that existed before the bridge started. */
  private loaded = false;

  constructor(file: string, agentId: string | undefined, base: Partial<SessionMeta>) {
    this.file = file;
    this.agentId = agentId;
    this.meta = {
      id: agentId ? `claude-${agentId}` : sid,
      file,
      kind: agentId ? "subagent" : "main",
      agent: "claude",
      actions: ACTIONS,
      status: "idle",
      controllable: controlOn(),
      pid: process.pid,
      host: hostname(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      ...base,
    };
    this.tail = new Tail(file);
    this.reader = new TranscriptReader({
      message: (m) => this.push(m),
      partial: (m) => this.setPartial(m),
      meta: (p) => {
        const patch: Partial<SessionMeta> = {};
        if (p.name && !this.agentId && p.name !== this.meta.name) patch.name = p.name;
        if (p.model && p.model !== this.meta.model) patch.model = p.model;
        if (p.usage) patch.usage = p.usage;
        if (p.compacting === false && this.meta.compacting) Object.assign(patch, { compacting: false, compactionReason: undefined });
        if (p.turnStart && this.meta.status === "idle" && this.loaded) patch.status = "running";
        if (p.turnDone && !this.agentId && this.loaded) patch.status = "idle";
        if (Object.keys(patch).length) this.patch(patch);
      },
    });
  }

  get id(): string {
    return this.meta.id;
  }

  load(): void {
    this.poll();
    this.loaded = true;
    if (this.reader.streaming) this.meta.status = "running";
  }

  poll(): boolean {
    const lines = this.tail.read();
    for (const l of lines) this.reader.line(l);
    return lines.length > 0;
  }

  register(): void {
    if (this.registered) return;
    this.registered = true;
    processNode().register({ id: this.id, snapshot: () => this.snapshot(), onCommand: (c) => onCommand(this, c) });
  }

  private emit(ev: SessionEvent): void {
    if (this.registered) processNode().publish(ev);
  }

  patch(p: Partial<SessionMeta>): void {
    Object.assign(this.meta, p, { updatedAt: Date.now() });
    this.emit({ type: "meta", sessionId: this.id, patch: { ...p, updatedAt: this.meta.updatedAt } });
  }

  private push(m: any): void {
    const w = toWire(m, (ref, mime, data) => {
      if (this.registered) processNode().publishImage(this.id, ref, mime, data);
    });
    if (!w) return;
    this.messages.push(w);
    if (this.messages.length > MAX_MESSAGES) this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    this.emit({ type: "message", sessionId: this.id, message: w });
  }

  /** A prompt the hooks delivered from the web. The transcript only has it as hook context. */
  delivered(text: string): void {
    this.push({ role: "user", content: text, timestamp: Date.now() });
  }

  private setPartial(m: any | null): void {
    this.partial = m ? (toWire(m) ?? null) : null;
    if (!m) {
      clearTimeout(this.partialTimer);
      this.partialTimer = undefined;
      this.emit({ type: "partial", sessionId: this.id, message: null });
      return;
    }
    this.partialTimer ??= setTimeout(() => {
      this.partialTimer = undefined;
      this.emit({ type: "partial", sessionId: this.id, message: this.partial });
    }, PARTIAL_THROTTLE_MS);
  }

  snapshot(): SessionEvent {
    this.meta.controllable = controlOn();
    return { type: "snapshot", sessionId: this.id, meta: { ...this.meta }, messages: this.messages, partial: this.partial, tools: [] };
  }

  /**
   * Mark finished. It stays listed (and in snapshots, so a new hub sees it too)
   * for a while, like pi's finished subagents, then drops off.
   */
  end(): void {
    this.reader.flush();
    if (this.meta.status !== "ended") this.patch({ status: "ended" });
    clearTimeout(this.dropTimer);
    this.dropTimer = setTimeout(() => this.unregister(), SUBAGENT_RECENT_MS);
    this.dropTimer.unref();
  }

  /** Picked up again after finishing (a background agent sent a new message). */
  resume(): void {
    clearTimeout(this.dropTimer);
    this.register();
    this.patch({ status: "running" });
  }

  unregister(how: "remove" | "ended" = "remove"): void {
    clearTimeout(this.dropTimer);
    if (!this.registered) return;
    this.registered = false;
    processNode().unregister(this.id, how);
  }
}

// ---------------------------------------------------------------------------
// Web commands
// ---------------------------------------------------------------------------

function onCommand(t: Thread, cmd: ControlCommand): void {
  // Re-check consent at the moment of acting; the hub's copy may be stale.
  if (!controlOn()) {
    t.patch({ controllable: false });
    return notice(t.id, "error", "Web control is not enabled. Run /web control in Claude Code to allow it.");
  }
  const busy = t.meta.status === "running" || t.meta.status === "waiting_ui";
  switch (cmd.action) {
    case "prompt": {
      const text = (cmd.text ?? "").trim();
      if (!text) return;
      if (t.agentId) {
        // Subagents (rightly) don't trust text that shows up beside a tool result, so
        // the message goes to the main thread, which passes it on with SendMessage.
        const mainBusy = mainThread?.meta.status === "running" || mainThread?.meta.status === "waiting_ui";
        enqueue(sid, { kind: "prompt", text, mode: mainBusy ? "steer" : "followUp", relay: { agentId: t.agentId, name: t.meta.name }, at: Date.now() });
        return notice(
          t.id,
          "info",
          mainBusy || waiterAlive()
            ? "Sent to the main session to pass on with SendMessage. If the main session is waiting on this subagent in the foreground, it only gets there once the subagent returns."
            : "Queued for the main session to pass on, after its next turn ends.",
        );
      }
      if (!busy) {
        enqueue(sid, { kind: "prompt", text, mode: "followUp", at: Date.now() });
        if (waiterAlive()) return notice(t.id, "info", "Prompt sent.");
        return notice(t.id, "warning", "Queued, but nothing is listening for it yet. It goes in after the session's next turn ends (say anything in the terminal to kick it off).");
      }
      const mode = cmd.mode === "followUp" ? "followUp" : "steer";
      enqueue(sid, { kind: "prompt", text, mode, at: Date.now() });
      return notice(t.id, "info", mode === "steer" ? "Steering message queued. Claude sees it after the current tool call." : "Follow-up queued for when this turn ends.");
    }
    case "abort":
      if (!busy) return notice(t.id, "info", "Already idle.");
      enqueue(sid, { kind: "abort", agentId: t.agentId, at: Date.now() });
      return notice(t.id, "info", "Stop requested. It takes effect at the next tool call. A long reply with no tool calls runs to the end.");
    default:
      return notice(t.id, "error", `${cmd.action} isn't available for Claude Code sessions.`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

function readInfo(): { transcript?: string; cwd?: string; claudePid?: number } {
  try {
    return JSON.parse(readFileSync(join(dir, "info.json"), "utf8"));
  } catch {
    return {};
  }
}

function readAgentMeta(file: string): any {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
  } catch {
    return {};
  }
}

async function main(): Promise<void> {
  if (!sid || !existsSync(dir)) return;
  const pidFile = join(dir, "bridge.pid");
  const other = readPid(pidFile);
  if (other && other !== process.pid && pidAlive(other)) return;
  writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

  let info = readInfo();
  // The transcript is written asynchronously; give it a moment to appear.
  for (let i = 0; i < 120 && !(info.transcript && existsSync(info.transcript)); i++) {
    await new Promise((r) => setTimeout(r, 500));
    info = readInfo();
  }
  if (!info.transcript || !existsSync(info.transcript)) return debug("claude bridge: no transcript", sid);
  debug("claude bridge start", sid, info.transcript);

  const transcript = info.transcript;
  const main = new Thread(transcript, undefined, { cwd: info.cwd, pid: info.claudePid ?? process.pid, name: undefined });
  main.load();
  main.register();
  mainThread = main;

  const subDir = join(dirname(transcript), basename(transcript, ".jsonl"), "subagents");
  const subs = new Map<string, Thread>();
  /** agentId -> when it finished. */
  const finished = new Map<string, number>();

  const scanSubagents = (initial: boolean) => {
    let names: string[];
    try {
      names = readdirSync(subDir).filter((n) => /^agent-[A-Za-z0-9_-]+\.jsonl$/.test(n));
    } catch {
      return;
    }
    for (const n of names) {
      const agentId = n.slice("agent-".length, -".jsonl".length);
      if (subs.has(agentId)) continue;
      const file = join(subDir, n);
      const am = readAgentMeta(file);
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {}
      if (initial && am.finished && Date.now() - mtime > SUBAGENT_RECENT_MS) {
        subs.set(agentId, undefined as any); // seen, not shown
        continue;
      }
      const t = new Thread(file, agentId, {
        parentFile: transcript,
        cwd: am.worktreePath || info.cwd,
        label: am.agentType || agentId.slice(0, 8),
        name: am.description,
        status: am.finished ? "ended" : "running",
      });
      t.load();
      subs.set(agentId, t);
      t.register();
      if (am.finished) {
        finished.set(agentId, Date.now());
        t.end();
      }
    }
  };
  scanSubagents(true);

  const events = new Tail(join(dir, "events"), true);
  const thread = (agentId?: string) => (agentId ? subs.get(agentId) : main);
  let stopping = false;

  const handle = (ev: HookEvent) => {
    switch (ev.t) {
      case "status": {
        const t = thread(ev.agentId);
        if (t && t.meta.status !== "ended" && t.meta.status !== ev.s) t.patch({ status: ev.s });
        return;
      }
      case "delivered": {
        const t = thread(ev.agentId);
        t?.delivered(ev.text);
        return;
      }
      case "aborted":
        notice(thread(ev.agentId)?.id ?? main.id, "info", "Stopped.");
        return;
      case "compact":
        main.patch(ev.on ? { compacting: true, compactionReason: ev.reason === "auto" ? "threshold" : "manual" } : { compacting: false, compactionReason: undefined });
        return;
      case "subagent": {
        scanSubagents(false);
        const t = subs.get(ev.agentId);
        if (t && ev.done) {
          t.poll();
          finished.set(ev.agentId, Date.now());
          t.end();
        }
        return;
      }
      case "end":
        stopping = true;
        return;
    }
  };

  const shutdown = async (how: "remove" | "ended", thenRestart = false) => {
    for (const t of subs.values()) t?.unregister();
    processNode().unregister(main.id, how);
    await processNode().drain(1500);
    try {
      if (readPid(pidFile) === process.pid) unlinkSync(pidFile);
    } catch {}
    if (thenRestart) spawn(process.execPath, [fileURLToPath(import.meta.url), sid], { detached: true, stdio: "ignore", env: process.env }).unref();
    process.exit(0);
  };

  setInterval(() => {
    main.poll();
    for (const [id, t] of subs) {
      if (!t) continue;
      if (t.poll() && finished.has(id) && Date.now() - finished.get(id)! > RESUME_GRACE_MS) {
        // A finished background agent picked up again (e.g. a message sent to it).
        finished.delete(id);
        t.resume();
      }
    }
    for (const ev of events.read()) handle(ev);
    if (stopping) void shutdown("remove");
  }, POLL_MS);

  // The plugin got updated under us: hand over to a bridge running the new code.
  setInterval(() => {
    if (computeBuild() !== BUILD) {
      debug("claude bridge: new build, restarting", sid);
      void shutdown("remove", true);
    }
  }, BUILD_CHECK_MS).unref();

  let lastScan = 0;
  setInterval(() => {
    if (Date.now() - lastScan > CHECK_MS) {
      lastScan = Date.now();
      scanSubagents(false);
    }
    const shared = !!readShares()[claudeShareKey(sid)];
    if (!shared || !existsSync(dir)) {
      debug("claude bridge: share removed", sid);
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
      return void shutdown("remove");
    }
    const ctl = controlOn();
    for (const t of [main, ...subs.values()]) if (t?.registered && t.meta.controllable !== ctl) t.patch({ controllable: ctl });
    if (info.claudePid && !pidAlive(info.claudePid)) {
      debug("claude bridge: claude exited", sid);
      return void shutdown("remove");
    }
    const fresh = readInfo();
    if (fresh.claudePid && fresh.claudePid !== info.claudePid) {
      info = fresh;
      main.patch({ pid: fresh.claudePid });
    }
  }, CHECK_MS).unref();
}

main().catch((err) => {
  debug("claude bridge crashed", String(err?.stack ?? err));
  process.exit(1);
});
