import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { APP_ID, bindHosts, debug, isTailscaleAddr, port, tailnetAuthEnabled, tailnetUsers, tailscaleOwner, tailscaleWhois, token } from "./config.ts";
import type { ControlCommand, HubState, SessionEvent, SessionMeta, ToolState, WireMessage } from "./protocol.ts";

export const VERSION = "0.1.0";

const MAX_MESSAGES = 1500;
const MAX_TOOLS = 60;
const OFFLINE_GRACE_MS = 90_000;
const ENDED_RETENTION_MS = 30 * 60_000;
const MAX_BODY = 48 * 1024 * 1024;
const MAX_IMAGE_STORE = 96 * 1024 * 1024;
const MAX_FILE_VIEW = 1024 * 1024;
// Never serve these through the file viewer, even inside the project.
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.netrc|\.npmrc|\.pypirc|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|kdbx|age)|credentials(\.json)?|secrets?(\.[a-z]+)?)$/i;
const BROWSER_BACKLOG_LIMIT = 8 * 1024 * 1024;
const WHOIS_TTL_MS = 60_000;

/** Messages the hub pushes down to a publisher process. */
export type OwnerMessage = { type: "command"; command: ControlCommand };

interface Owner {
  id: string;
  send(msg: OwnerMessage): void;
  res?: ServerResponse;
}

interface SessionRec {
  meta: SessionMeta;
  messages: WireMessage[];
  partial: WireMessage | null;
  tools: Map<string, ToolState>;
  ownerId: string;
  removeTimer?: NodeJS.Timeout;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": hi\n\n");
}

const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pi web</title><style>body{font:16px system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0}
form{display:flex;gap:8px;flex-direction:column;width:min(320px,90vw)}input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #444;background:#222;color:#eee}
button{background:#3b82f6;border:0}</style></head><body><form method="get" action="/"><b>pi web session</b>
<input name="t" placeholder="access token" autocomplete="off" autocapitalize="off" autofocus><button>Open</button>
<small style="color:#888">Run <code>/web</code> in pi to see the token.</small></form></body></html>`;

export class Hub {
  readonly startedAt = Date.now();
  private sessions = new Map<string, SessionRec>();
  private owners = new Map<string, Owner>();
  private browsers = new Set<ServerResponse>();
  private images = new Map<string, { mimeType: string; buf: Buffer }>();
  private imageBytes = 0;
  private servers: Server[] = [];
  private heartbeat?: NodeJS.Timeout;
  readonly hosts: string[];
  readonly publicHost?: string;
  readonly warning?: string;
  private readonly secret = token();
  /** Tailnet peer address -> verdict, so whois runs about once a minute per device. */
  private whoisCache = new Map<string, { ok: boolean; at: number }>();

  private constructor() {
    const b = bindHosts();
    this.hosts = b.hosts;
    this.publicHost = b.publicHost;
    this.warning = b.warning;
  }

  /** Try to become the hub. Rejects with EADDRINUSE if another process already is. */
  static async start(): Promise<Hub> {
    const hub = new Hub();
    const p = port();
    const failed: string[] = [];
    for (const host of hub.hosts) {
      const server = createServer((req, res) => {
        hub.handle(req, res).catch((err) => {
          if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
          else res.end();
        });
      });
      server.keepAliveTimeout = 65_000;
      // Never keep the hosting pi alive just because a browser or another
      // publisher is connected. When this process exits, a client takes over.
      server.on("connection", (sock) => sock.unref());
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(p, host, () => {
            server.off("error", reject);
            resolve();
          });
        });
        hub.servers.push(server);
      } catch (err: any) {
        // The first (loopback) listener decides hub ownership. Failing on an
        // extra address (wifi dropped, tailscale down) is not fatal.
        if (hub.servers.length === 0) throw err;
        failed.push(`${host} (${err?.code ?? err})`);
      }
    }
    if (failed.length) {
      const w = `Could not bind ${failed.join(", ")}`;
      (hub as any).warning = hub.warning ? `${hub.warning}; ${w}` : w;
    }
    for (const s of hub.servers) s.unref();
    hub.heartbeat = setInterval(() => hub.pingAll(), 15_000);
    hub.heartbeat.unref();
    return hub;
  }

  async close(): Promise<void> {
    clearInterval(this.heartbeat);
    for (const res of this.browsers) res.end();
    for (const o of this.owners.values()) o.res?.end();
    this.browsers.clear();
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    for (const s of this.servers) s.closeAllConnections?.();
    this.servers = [];
  }

  /** Number of publisher processes other than the hub's own. */
  remoteOwnerCount(localOwnerId: string): number {
    let n = 0;
    for (const id of this.owners.keys()) if (id !== localOwnerId) n++;
    return n;
  }

  attachOwner(id: string, send: (msg: OwnerMessage) => void, res?: ServerResponse): void {
    this.owners.set(id, { id, send, res });
  }

  detachOwner(id: string): void {
    const owner = this.owners.get(id);
    if (!owner) return;
    this.owners.delete(id);
    for (const [sid, rec] of this.sessions) {
      if (rec.ownerId !== id) continue;
      if (rec.meta.status === "ended") continue; // finished cleanly; its retention timer is already running
      rec.meta.status = "offline";
      rec.meta.updatedAt = Date.now();
      this.broadcast({ type: "meta", sessionId: sid, patch: { status: "offline", updatedAt: rec.meta.updatedAt } });
      this.expire(sid, rec, OFFLINE_GRACE_MS, "offline");
    }
  }

  private expire(sid: string, rec: SessionRec, ms: number, status: "offline" | "ended"): void {
    clearTimeout(rec.removeTimer);
    rec.removeTimer = setTimeout(() => {
      if (this.sessions.get(sid) === rec && rec.meta.status === status) this.removeTree(sid);
    }, ms);
    rec.removeTimer.unref();
  }

  /** Remove a session plus any finished (ended/offline) descendants. Live children stay. */
  private removeTree(sid: string): void {
    const rec = this.sessions.get(sid);
    if (rec) clearTimeout(rec.removeTimer);
    this.sessions.delete(sid);
    this.broadcast({ type: "remove", sessionId: sid });
    for (const [cid, child] of this.sessions) {
      if (child.meta.parentId === sid && (child.meta.status === "ended" || child.meta.status === "offline")) this.removeTree(cid);
    }
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  private resolveParent(meta: SessionMeta): void {
    if (!meta.parentFile) return;
    for (const rec of this.sessions.values()) {
      if (rec.meta.file && rec.meta.file === meta.parentFile) {
        meta.parentId = rec.meta.id;
        return;
      }
    }
  }

  ingest(ownerId: string, ev: SessionEvent): void {
    const sid = ev.sessionId;
    let rec = this.sessions.get(sid);
    switch (ev.type) {
      case "snapshot": {
        clearTimeout(rec?.removeTimer);
        const meta = { ...ev.meta };
        this.resolveParent(meta);
        rec = {
          meta,
          messages: ev.messages.slice(-MAX_MESSAGES),
          partial: ev.partial ?? null,
          tools: new Map((ev.tools ?? []).map((t) => [t.toolCallId, t])),
          ownerId,
        };
        this.sessions.set(sid, rec);
        this.broadcast({ ...ev, meta, messages: rec.messages });
        // Children that registered before their parent can now be linked.
        if (meta.file) {
          for (const other of this.sessions.values()) {
            if (other.meta.parentFile === meta.file && other.meta.parentId !== sid) {
              other.meta.parentId = sid;
              this.broadcast({ type: "meta", sessionId: other.meta.id, patch: { parentId: sid } });
            }
          }
        }
        return;
      }
      case "remove":
        this.removeTree(sid);
        return;
      case "image":
        this.storeImage(ev.ref, ev.mimeType, ev.data);
        return;
      case "notice":
        this.broadcast(ev);
        return;
    }
    if (!rec) return; // events before snapshot are dropped; the snapshot will cover them
    rec.ownerId = ownerId;
    switch (ev.type) {
      case "meta":
        Object.assign(rec.meta, ev.patch);
        if (ev.patch.status === "ended") {
          rec.partial = null;
          this.expire(sid, rec, ENDED_RETENTION_MS, "ended");
        }
        break;
      case "message":
        rec.messages.push(ev.message);
        if (rec.messages.length > MAX_MESSAGES) rec.messages.splice(0, rec.messages.length - MAX_MESSAGES);
        if (ev.message.role === "assistant") rec.partial = null;
        break;
      case "partial":
        rec.partial = ev.message;
        break;
      case "delta": {
        const b = rec.partial?.content?.[ev.contentIndex];
        if (!rec.partial) return;
        if (!b) {
          rec.partial.content ??= [];
          rec.partial.content[ev.contentIndex] = ev.kind === "text" ? { type: "text", text: ev.delta } : { type: "thinking", thinking: ev.delta };
        } else if (ev.kind === "text") b.text = (b.text ?? "") + ev.delta;
        else b.thinking = (b.thinking ?? "") + ev.delta;
        break;
      }
      case "tool":
        rec.tools.set(ev.tool.toolCallId, ev.tool);
        if (rec.tools.size > MAX_TOOLS) {
          for (const [id, t] of rec.tools) {
            if (rec.tools.size <= MAX_TOOLS) break;
            if (t.status !== "running") rec.tools.delete(id);
          }
        }
        break;
    }
    rec.meta.updatedAt = Date.now();
    this.broadcast(ev);
  }

  private storeImage(ref: string, mimeType: string, data: string): void {
    if (this.images.has(ref) || !/^[a-f0-9]{16,64}$/.test(ref) || !/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mimeType)) return; // no SVG: it could run script on our origin
    const buf = Buffer.from(data, "base64");
    this.images.set(ref, { mimeType, buf });
    this.imageBytes += buf.length;
    // Oldest first (Map keeps insertion order).
    for (const [k, v] of this.images) {
      if (this.imageBytes <= MAX_IMAGE_STORE) break;
      this.images.delete(k);
      this.imageBytes -= v.buf.length;
    }
  }

  /** Read a text file for the viewer. Only inside the session's cwd, never secrets. */
  private async readProjectFile(sid: string, p: string): Promise<{ status: number; body: any }> {
    const rec = this.sessions.get(sid);
    if (!rec?.meta.cwd) return { status: 404, body: { error: "unknown session" } };
    let root: string;
    let full: string;
    try {
      root = await realpath(rec.meta.cwd);
      const expanded = p.startsWith("~/") ? resolve(process.env.HOME ?? "/", p.slice(2)) : p;
      full = await realpath(isAbsolute(expanded) ? expanded : resolve(rec.meta.cwd, expanded));
    } catch {
      return { status: 404, body: { error: "file not found" } };
    }
    if (full !== root && !full.startsWith(root + sep)) return { status: 403, body: { error: "outside the session's working directory" } };
    const rel = full.slice(root.length + 1);
    if (SECRET_FILE.test(rel) || rel.split(sep).some((part) => part === ".git" || part === ".ssh" || part === ".gnupg")) {
      return { status: 403, body: { error: "not shown (looks like a secret)" } };
    }
    const fh = await open(full, "r").catch(() => undefined);
    if (!fh) return { status: 404, body: { error: "file not found" } };
    try {
      const st = await fh.stat();
      if (!st.isFile()) return { status: 400, body: { error: "not a file" } };
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_VIEW));
      await fh.read(buf, 0, buf.length, 0);
      if (buf.subarray(0, 8000).includes(0)) return { status: 415, body: { error: "binary file" } };
      return { status: 200, body: { path: rel, name: basename(full), text: buf.toString("utf8"), size: st.size, truncated: st.size > MAX_FILE_VIEW } };
    } finally {
      await fh.close();
    }
  }

  private snapshotState(): HubState {
    return {
      sessions: [...this.sessions.values()].map((r) => ({ meta: r.meta, messages: r.messages, partial: r.partial, tools: [...r.tools.values()] })),
      hub: { pid: process.pid, startedAt: this.startedAt, version: VERSION },
    };
  }

  private broadcast(ev: SessionEvent): void {
    if (this.browsers.size === 0) return;
    const frame = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of this.browsers) {
      if (res.writableLength > BROWSER_BACKLOG_LIMIT) {
        // Slow client (phone on a bad connection). Drop it; it reconnects and gets fresh state.
        this.browsers.delete(res);
        res.destroy();
        continue;
      }
      res.write(frame);
    }
  }

  private pingAll(): void {
    for (const res of this.browsers) res.write(": ping\n\n");
    for (const o of this.owners.values()) o.res?.write(": ping\n\n");
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  private authed(req: IncomingMessage, url: URL): "ok" | "query" | false {
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ") && safeEqual(auth.slice(7).trim(), this.secret)) return "ok";
    const c = readCookie(req, "piws_t");
    if (c && safeEqual(c, this.secret)) return "ok";
    const q = url.searchParams.get("t");
    if (q && safeEqual(q.trim().toLowerCase(), this.secret)) return "query";
    return false;
  }

  /**
   * Token-free entry for a trusted tailnet user. Only for connections that came in on the
   * Tailscale address from a Tailscale peer; tailscaled says who the peer is. Trusted: the
   * logins in PI_WEBSESSION_TS_USERS, else this node's owner. Tagged devices never are.
   */
  private async tailnetAuthed(req: IncomingMessage): Promise<boolean> {
    if (!tailnetAuthEnabled()) return false;
    const remote = req.socket.remoteAddress;
    if (!isTailscaleAddr(remote) || !isTailscaleAddr(req.socket.localAddress)) return false;
    const hit = this.whoisCache.get(remote!);
    if (hit && Date.now() - hit.at < WHOIS_TTL_MS) return hit.ok;
    const [peer, owner] = await Promise.all([tailscaleWhois(remote!), tailscaleOwner()]);
    const allowed = tailnetUsers() ?? (owner ? [owner] : []);
    const ok = !!peer?.login && allowed.includes(peer.login);
    debug("tailnet auth", remote, peer?.node, peer?.login ?? "(tagged/unknown)", ok ? "allowed" : "denied");
    if (this.whoisCache.size > 256) this.whoisCache.clear();
    this.whoisCache.set(remote!, { ok, at: Date.now() });
    return ok;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;

    if (path === "/api/ping") return json(res, 200, { app: APP_ID, version: VERSION, pid: process.pid });
    if (path === "/manifest.webmanifest") {
      res.writeHead(200, { "content-type": "application/manifest+json" });
      res.end(JSON.stringify({ name: "pi web", short_name: "pi", start_url: "/", display: "standalone", background_color: "#0d1117", theme_color: "#0d1117" }));
      return;
    }

    const auth = this.authed(req, url) || ((await this.tailnetAuthed(req)) ? "ok" : false);
    if (auth === "query") {
      res.writeHead(302, {
        "set-cookie": `piws_t=${encodeURIComponent(this.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
        location: url.searchParams.get("s") ? `/#${encodeURIComponent(url.searchParams.get("s")!)}` : "/",
      });
      res.end();
      return;
    }
    if (!auth) {
      if (path === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(LOGIN_PAGE);
        return;
      }
      return json(res, 401, { error: "unauthorized" });
    }

    if (path === "/" && req.method === "GET") {
      const html = readFileSync(fileURLToPath(new URL("./web/index.html", import.meta.url)), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }

    if (path === "/api/stream" && req.method === "GET") {
      sseHeaders(res);
      res.write(`event: state\ndata: ${JSON.stringify(this.snapshotState())}\n\n`);
      this.browsers.add(res);
      req.on("close", () => this.browsers.delete(res));
      return;
    }

    if (path === "/api/control" && req.method === "POST") {
      // Custom header forces a CORS preflight, which blocks cross-site form posts.
      if (req.headers["x-piws"] !== "1") return json(res, 403, { error: "missing x-piws header" });
      let cmd: ControlCommand;
      try {
        cmd = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      const rec = this.sessions.get(cmd.sessionId);
      if (!rec) return json(res, 404, { error: "unknown session" });
      if (!rec.meta.controllable) return json(res, 403, { error: "control not enabled for this session (run /web control in pi)" });
      if (!["prompt", "abort", "compact", "model"].includes(cmd.action)) return json(res, 400, { error: "bad action" });
      const owner = this.owners.get(rec.ownerId);
      if (!owner) return json(res, 503, { error: "session is offline" });
      owner.send({ type: "command", command: { ...cmd, cmdId: String(cmd.cmdId ?? Date.now()) } });
      return json(res, 202, { ok: true });
    }

    const img = path.match(/^\/api\/image\/([a-f0-9]{16,64})$/);
    if (img && req.method === "GET") {
      const im = this.images.get(img[1]);
      if (!im) return json(res, 404, { error: "image not available" });
      res.writeHead(200, { "content-type": im.mimeType, "content-length": im.buf.length, "cache-control": "private, max-age=86400, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
      res.end(im.buf);
      return;
    }

    if (path === "/api/file" && req.method === "GET") {
      const r = await this.readProjectFile(url.searchParams.get("sid") ?? "", url.searchParams.get("path") ?? "");
      return json(res, r.status, r.body);
    }

    // --- publisher ingest (other pi processes on this machine) ---
    if (path === "/ingest/subscribe" && req.method === "GET") {
      const ownerId = url.searchParams.get("owner");
      if (!ownerId) return json(res, 400, { error: "owner required" });
      sseHeaders(res);
      this.attachOwner(ownerId, (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`), res);
      res.write(`event: ready\ndata: {}\n\n`);
      req.on("close", () => {
        if (this.owners.get(ownerId)?.res === res) this.detachOwner(ownerId);
      });
      return;
    }

    if (path === "/ingest/events" && req.method === "POST") {
      let body: { owner: string; events: SessionEvent[] };
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { error: "bad json" });
      }
      if (!this.owners.has(body.owner)) return json(res, 409, { error: "subscribe first" });
      for (const ev of body.events ?? []) this.ingest(body.owner, ev);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: "not found" });
  }
}
