// One ProcessNode per Node process. It owns the connection to the hub (or is
// the hub) and multiplexes every published session in this process: the main
// session plus in-process foreground subagents. Detached background runners
// are separate processes with their own ProcessNode.

import { randomBytes } from "node:crypto";
import { request, type ClientRequest } from "node:http";
import { hostname } from "node:os";
import { debug, port, token } from "./config.ts";
import { Hub, type OwnerMessage } from "./hub.ts";
import type { ControlCommand, SessionEvent } from "./protocol.ts";

export interface LocalSession {
  id: string;
  snapshot(): SessionEvent;
  onCommand(cmd: ControlCommand): void;
}

export type NodeMode = "idle" | "connecting" | "hub" | "client";

const FLUSH_MS = 60;
const MAX_QUEUE = 5000;
const MAX_BATCH_BYTES = 6 * 1024 * 1024;

class ProcessNode {
  readonly ownerId = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  private sessions = new Map<string, LocalSession>();
  mode: NodeMode = "idle";
  hub?: Hub;
  lastError?: string;
  private queue: SessionEvent[] = [];
  private flushTimer?: NodeJS.Timeout;
  private posting = false;
  private sub?: ClientRequest;
  private retryTimer?: NodeJS.Timeout;
  private idleCheck?: NodeJS.Timeout;
  private listeners = new Set<() => void>();
  private retryDelay = 500;
  /** Image refs the current hub already has. Reset whenever we (re)connect. */
  private sentImages = new Set<string>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    debug("node mode", this.mode, this.lastError ?? "");
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {}
    }
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  register(s: LocalSession): void {
    this.sessions.set(s.id, s);
    if (this.mode === "idle") this.ensureRunning();
    else this.publish(s.snapshot());
  }

  /**
   * Stop publishing a session. With `ended`, the hub keeps it around (marked
   * ended) so finished subagents stay visible; otherwise it's removed.
   */
  unregister(id: string, how: "remove" | "ended" = "remove"): void {
    if (!this.sessions.has(id)) return;
    if (how === "remove") this.publish({ type: "remove", sessionId: id });
    else this.publish({ type: "meta", sessionId: id, patch: { status: "ended", updatedAt: Date.now() } });
    this.sessions.delete(id);
    if (this.sessions.size === 0) void this.drain(1500).then(() => this.maybeStop());
  }

  /** Wait (bounded) until queued events reached the hub. Used before the process exits. */
  async drain(timeoutMs: number): Promise<void> {
    if (this.mode !== "client") return;
    const deadline = Date.now() + timeoutMs;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.flush();
    while ((this.queue.length > 0 || this.posting) && this.mode === "client" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
      if (!this.posting && this.queue.length) this.flush();
    }
  }

  publish(ev: SessionEvent): void {
    // Final events (remove / ended) are published just before the session leaves the map.
    if (!this.sessions.has(ev.sessionId)) return;
    if (this.mode === "hub" && this.hub) {
      this.hub.ingest(this.ownerId, ev);
      return;
    }
    if (this.mode !== "client") return; // snapshot on connect covers anything dropped here
    this.queue.push(ev);
    if (this.queue.length > MAX_QUEUE) {
      // Hub can't keep up. Resync from scratch instead of growing forever.
      this.queue = [];
      this.sentImages.clear();
      for (const s of this.sessions.values()) this.queue.push(s.snapshot());
    }
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  /** Send image bytes once per hub connection; messages carry only the ref. */
  publishImage(sessionId: string, ref: string, mimeType: string, data: string): void {
    if (this.mode !== "hub" && this.mode !== "client") return;
    if (this.sentImages.has(ref) || !this.sessions.has(sessionId)) return;
    this.sentImages.add(ref);
    this.publish({ type: "image", sessionId, ref, mimeType, data });
  }

  private dispatch(cmd: ControlCommand): void {
    const s = this.sessions.get(cmd.sessionId);
    if (!s) return;
    try {
      s.onCommand(cmd);
    } catch (err: any) {
      this.publish({ type: "notice", sessionId: cmd.sessionId, level: "error", text: `Command failed: ${err?.message ?? err}` });
    }
  }

  private resyncAll(): void {
    this.sentImages.clear();
    for (const s of this.sessions.values()) this.publish(s.snapshot());
  }

  private ensureRunning(): void {
    if (this.mode === "hub" || this.mode === "client" || this.sessions.size === 0) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.mode = "connecting";
    this.changed();
    Hub.start().then(
      (hub) => {
        if (this.sessions.size === 0) {
          void hub.close();
          this.mode = "idle";
          this.changed();
          return;
        }
        this.hub = hub;
        this.mode = "hub";
        this.lastError = hub.warning;
        this.retryDelay = 500;
        hub.attachOwner(this.ownerId, (msg: OwnerMessage) => {
          if (msg.type === "command") queueMicrotask(() => this.dispatch(msg.command));
        });
        this.resyncAll();
        this.startIdleCheck();
        this.changed();
      },
      (err: any) => {
        if (err?.code === "EADDRINUSE") this.connectClient();
        else {
          this.lastError = `hub failed: ${err?.code ?? err?.message ?? err}`;
          this.scheduleRetry();
        }
      },
    );
  }

  private scheduleRetry(): void {
    this.mode = this.sessions.size ? "connecting" : "idle";
    this.changed();
    if (this.sessions.size === 0 || this.retryTimer) return;
    const delay = this.retryDelay + Math.random() * 400;
    this.retryDelay = Math.min(this.retryDelay * 2, 10_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.ensureRunning();
    }, delay);
    this.retryTimer.unref();
  }

  private connectClient(): void {
    const req = request({
      host: "127.0.0.1",
      port: port(),
      path: `/ingest/subscribe?owner=${encodeURIComponent(this.ownerId)}`,
      method: "GET",
      headers: { authorization: `Bearer ${token()}`, accept: "text/event-stream" },
    });
    this.sub = req;
    req.on("response", (res) => {
      if (res.statusCode !== 200) {
        this.lastError = res.statusCode === 401 ? "port is held by a hub with a different token" : `port ${port()} is in use by something else (HTTP ${res.statusCode})`;
        res.resume();
        this.sub = undefined;
        this.scheduleRetry();
        return;
      }
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk: string) => {
        buf += chunk;
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (event === "ready") {
            this.mode = "client";
            this.lastError = undefined;
            this.retryDelay = 500;
            this.queue = [];
            this.resyncAll();
            this.changed();
          } else if (data) {
            try {
              const msg = JSON.parse(data) as OwnerMessage;
              if (msg.type === "command") this.dispatch(msg.command);
            } catch {}
          }
        }
      });
      res.on("close", () => this.onClientLost());
      res.on("error", () => this.onClientLost());
    });
    req.on("error", (err: any) => {
      this.lastError = `hub connection failed: ${err?.code ?? err}`;
      this.onClientLost();
    });
    req.end();
    // Don't keep a finished background runner alive just for this socket.
    req.on("socket", (s) => s.unref());
  }

  private onClientLost(): void {
    if (this.sub === undefined && this.mode !== "client" && this.mode !== "connecting") return;
    this.sub = undefined;
    this.queue = [];
    this.sentImages.clear();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    // Hub went away (its pi exited). Race to become the new hub.
    this.scheduleRetry();
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (this.posting || this.queue.length === 0 || this.mode !== "client") return;
    // Batch by count and size; images and big snapshots can be several MB each.
    let n = 0;
    let bytes = 0;
    while (n < this.queue.length && n < 500) {
      const len = JSON.stringify(this.queue[n]).length;
      if (n > 0 && bytes + len > MAX_BATCH_BYTES) break;
      bytes += len;
      n++;
    }
    const events = this.queue.splice(0, n);
    this.posting = true;
    const body = JSON.stringify({ owner: this.ownerId, events });
    const req = request({
      host: "127.0.0.1",
      port: port(),
      path: "/ingest/events",
      method: "POST",
      headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    req.on("response", (res) => {
      res.resume();
      this.posting = false;
      if (res.statusCode === 409) {
        this.sub?.destroy();
        return;
      }
      if (this.queue.length) this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
    });
    req.on("error", () => {
      this.posting = false;
    });
    req.on("socket", (s) => s.unref());
    req.end(body);
  }

  private startIdleCheck(): void {
    clearInterval(this.idleCheck);
    this.idleCheck = setInterval(() => this.maybeStop(), 30_000);
    this.idleCheck.unref();
  }

  /** Shut down when nothing in this process is shared and no other process depends on our hub. */
  private maybeStop(): void {
    if (this.sessions.size > 0) return;
    if (this.mode === "hub" && this.hub) {
      if (this.hub.remoteOwnerCount(this.ownerId) > 0) return;
      clearInterval(this.idleCheck);
      void this.hub.close();
      this.hub = undefined;
    }
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const sub = this.sub;
    this.sub = undefined;
    this.mode = "idle";
    sub?.destroy();
    this.changed();
  }
}

const KEY = Symbol.for("pi-websession.process-node.v1");

/** Process-wide singleton, shared even if jiti loads this module more than once. */
export function processNode(): ProcessNode {
  const g = globalThis as any;
  g[KEY] ??= new ProcessNode();
  return g[KEY];
}
