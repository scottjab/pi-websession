import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";

export const APP_ID = "pi-websession";

/**
 * Identifies this copy of the plugin: a hash of its source files. Differs after any update,
 * whatever the install (nix store path, git checkout, npm), so a hub can tell it's stale.
 */
export function computeBuild(): string {
  try {
    const h = createHash("sha256");
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
        else if (/\.(ts|html)$/.test(e.name)) h.update(`${rel}${e.name}\0`).update(readFileSync(p)).update("\0");
      }
    };
    walk(dirname(fileURLToPath(import.meta.url)), "");
    return h.digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

export const BUILD: string = computeBuild();

/** When this process started. On a hub handoff the newer process wins. */
export const PROCESS_STARTED = Math.round(Date.now() - process.uptime() * 1000);

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function dataDir(): string {
  const dir = process.env.PI_WEBSESSION_DIR || join(agentDir(), "websession");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function port(): number {
  const n = Number(process.env.PI_WEBSESSION_PORT || 7878);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : 7878;
}

/** Find this machine's Tailscale address (100.64.0.0/10 CGNAT range). */
export function tailscaleIPv4(): string | undefined {
  const ifaces = networkInterfaces();
  // Prefer the tailscale interface by name, then any CGNAT address.
  const ordered = Object.entries(ifaces).sort(([a], [b]) => Number(b.startsWith("tailscale")) - Number(a.startsWith("tailscale")));
  for (const [, addrs] of ordered) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const [o1, o2] = a.address.split(".").map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return undefined;
}

const VIRTUAL_IFACE = /^(lo|docker|br-|veth|virbr|vnet|tap|tun|wg|podman|cni|flannel|cali|vmnet|vboxnet|zt|utun|tailscale)/;

function isPrivateLan(addr: string): boolean {
  const [a, b] = addr.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Private IPv4 addresses on physical-looking interfaces (wifi/ethernet). Skips docker, VPN, VM bridges. */
export function lanIPv4s(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal && isPrivateLan(a.address)) out.push(a.address);
    }
  }
  return out;
}

export interface BindPlan {
  hosts: string[];
  /** Tailscale address, used for the share URL (via MagicDNS when available). */
  publicHost?: string;
  /** LAN addresses, shown as extra URLs. */
  lanHosts: string[];
  warning?: string;
}

/**
 * Addresses the hub listens on. Always 127.0.0.1 first (publishers in other pi
 * processes connect there). PI_WEBSESSION_HOST is a comma list of:
 *   tailscale  -> the 100.64/10 address, if present
 *   lan        -> private IPv4s on wifi/ethernet (not docker/VM/VPN bridges)
 *   local      -> loopback only
 *   all        -> 0.0.0.0
 *   an IP      -> that address
 * Default: "tailscale,lan".
 */
export function bindHosts(): BindPlan {
  const prefs = (process.env.PI_WEBSESSION_HOST || "tailscale,lan")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const plan: BindPlan = { hosts: ["127.0.0.1"], lanHosts: [] };
  const missing: string[] = [];
  const add = (h: string) => {
    if (!plan.hosts.includes(h)) plan.hosts.push(h);
  };
  for (const pref of prefs) {
    if (pref === "local") continue;
    if (pref === "all") {
      plan.hosts = ["0.0.0.0"];
      plan.publicHost = tailscaleIPv4();
      plan.lanHosts = lanIPv4s();
      return plan;
    }
    if (pref === "tailscale") {
      const ts = tailscaleIPv4();
      if (ts) {
        add(ts);
        plan.publicHost = ts;
      } else missing.push("Tailscale");
    } else if (pref === "lan") {
      const lan = lanIPv4s();
      if (lan.length) lan.forEach((h) => (add(h), plan.lanHosts.push(h)));
      else if (prefs.length === 1) missing.push("LAN");
    } else if (pref !== "127.0.0.1") {
      add(pref);
      plan.publicHost ??= pref;
    }
  }
  if (missing.length) plan.warning = `No ${missing.join(" or ")} address found`;
  return plan;
}

let dnsNameCache: Promise<string | undefined> | undefined;
/** MagicDNS name of this node, best effort. */
export function tailscaleDnsName(): Promise<string | undefined> {
  dnsNameCache ??= new Promise((resolve) => {
    execFile("tailscale", ["status", "--self", "--json"], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        const name = JSON.parse(stdout)?.Self?.DNSName as string | undefined;
        resolve(name ? name.replace(/\.$/, "") : undefined);
      } catch {
        resolve(undefined);
      }
    });
  });
  return dnsNameCache;
}

// ---------- Tailscale identity ----------

/** True for a Tailscale IPv4 (100.64.0.0/10), also in its IPv4-mapped IPv6 form. */
export function isTailscaleAddr(addr: string | undefined): boolean {
  if (!addr) return false;
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  const parts = v4.split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** Off with PI_WEBSESSION_TS_AUTH=off: then only the token gets you in. */
export function tailnetAuthEnabled(): boolean {
  return !/^(0|off|false|no)$/i.test(process.env.PI_WEBSESSION_TS_AUTH ?? "");
}

/** PI_WEBSESSION_TS_USERS: comma list of tailnet login names to let in. Unset: this node's owner. */
export function tailnetUsers(): string[] | undefined {
  const v = process.env.PI_WEBSESSION_TS_USERS;
  if (!v?.trim()) return undefined;
  return v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** `tailscale <cmd> --json [args]`. Flags go before positional args: Go's flag parser stops at the first one. */
function tailscaleJson(cmd: string, args: string[] = []): Promise<any> {
  return new Promise((resolve) => {
    execFile("tailscale", [cmd, "--json", ...args], { timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
}

let ownerCache: Promise<string | undefined> | undefined;
/** Login name of the user owning this node. Undefined for a tagged node (owned by its tags, not a person). */
export function tailscaleOwner(): Promise<string | undefined> {
  ownerCache ??= tailscaleJson("status", ["--self"]).then((st) => {
    const self = st?.Self;
    if (!self || self.Tags?.length) return undefined;
    const login = st.User?.[String(self.UserID)]?.LoginName;
    return typeof login === "string" ? login.toLowerCase() : undefined;
  });
  return ownerCache;
}

export interface TailnetPeer {
  /** Login name, undefined for tagged devices. */
  login?: string;
  node?: string;
}

/** Who is behind a tailnet address, per the local tailscaled. Undefined if it doesn't know the address. */
export async function tailscaleWhois(addr: string): Promise<TailnetPeer | undefined> {
  const ip = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  const w = await tailscaleJson("whois", [ip]);
  if (!w?.Node) return undefined;
  const tagged = !!w.Node.Tags?.length;
  const login = !tagged && typeof w.UserProfile?.LoginName === "string" ? w.UserProfile.LoginName.toLowerCase() : undefined;
  return { login, node: typeof w.Node.Name === "string" ? w.Node.Name.replace(/\.$/, "") : undefined };
}

const TOKEN_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // no l/o/0/1, easy to type on a phone

/** Shared secret for browsers and publishers. Persisted so phone bookmarks keep working. */
export function token(): string {
  if (process.env.PI_WEBSESSION_TOKEN) return process.env.PI_WEBSESSION_TOKEN;
  const file = join(dataDir(), "token");
  try {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 8) return t;
  } catch {}
  const bytes = randomBytes(12);
  let t = "";
  for (const b of bytes) t += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
  writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

export function rotateToken(): string {
  const file = join(dataDir(), "token");
  try {
    writeFileSync(file, "", { mode: 0o600 });
  } catch {}
  return token();
}

// ---------------------------------------------------------------------------
// Opt-in state, shared across pi processes (main TUI, background runners).
// Keyed by session file path, which is what child sessions record as
// `parentSession` in their header.
// ---------------------------------------------------------------------------

export interface ShareEntry {
  control: boolean;
  enabledAt: string;
  sessionId?: string;
}

type ShareState = Record<string, ShareEntry>;

function stateFile(): string {
  return join(dataDir(), "shared-sessions.json");
}

export function readShares(): ShareState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeShares(state: ShareState): void {
  const file = stateFile();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function setShare(key: string, entry: ShareEntry): void {
  const s = readShares();
  s[key] = entry;
  writeShares(s);
}

export function removeShare(key: string): void {
  const s = readShares();
  if (key in s) {
    delete s[key];
    writeShares(s);
  }
}

/** Read the header (first line) of a session file. */
export function readSessionHeader(file: string): { id?: string; parentSession?: string; cwd?: string } | undefined {
  if (!existsSync(file)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, n).toString("utf8").split("\n")[0];
    const h = JSON.parse(line);
    return h?.type === "session" ? h : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Walk up the parentSession chain from a session and return the first shared
 * ancestor (or the session itself). Used by subagent children to decide whether
 * the user opted the tree in.
 */
export function findSharedRoot(sessionFile: string | undefined, parentSession: string | undefined): { key: string; entry: ShareEntry } | undefined {
  const shares = readShares();
  if (sessionFile && shares[sessionFile]) return { key: sessionFile, entry: shares[sessionFile] };
  let cur = parentSession;
  const seen = new Set<string>();
  for (let depth = 0; cur && depth < 12 && !seen.has(cur); depth++) {
    seen.add(cur);
    if (shares[cur]) return { key: cur, entry: shares[cur] };
    cur = readSessionHeader(cur)?.parentSession;
  }
  return undefined;
}

/** The URLs to open: tailnet name (or IP) first, then LAN addresses. */
export async function shareUrl(): Promise<string> {
  const b = bindHosts();
  const dns = b.publicHost ? await tailscaleDnsName() : undefined;
  const host = dns ?? b.publicHost ?? b.lanHosts[0] ?? "127.0.0.1";
  const t = token();
  const lan = b.lanHosts.filter((h) => h !== host).map((h) => `http://${h}:${port()}/?t=${t}`);
  return [`http://${host}:${port()}/?t=${t}`, ...lan.map((u) => `${u} (LAN)`)].join("\n");
}

/** Opt-in debug log: PI_WEBSESSION_DEBUG=1 writes to <dataDir>/debug.log */
export function debug(...parts: unknown[]): void {
  if (!process.env.PI_WEBSESSION_DEBUG) return;
  try {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(join(dataDir(), "debug.log"), `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {}
}
