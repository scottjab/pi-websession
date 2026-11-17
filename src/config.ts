import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";

export const APP_ID = "pi-websession";

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

/**
 * Addresses the hub listens on. Always 127.0.0.1 (publishers in other pi
 * processes connect there). Plus the public bind:
 *   PI_WEBSESSION_HOST unset / "tailscale"  -> tailscale IP if present
 *   "local"                                  -> loopback only
 *   "all"                                    -> 0.0.0.0
 *   anything else                            -> that address
 */
export function bindHosts(): { hosts: string[]; publicHost?: string; warning?: string } {
  const pref = (process.env.PI_WEBSESSION_HOST || "tailscale").trim();
  if (pref === "local") return { hosts: ["127.0.0.1"] };
  if (pref === "all") return { hosts: ["0.0.0.0"], publicHost: tailscaleIPv4() };
  if (pref === "tailscale") {
    const ts = tailscaleIPv4();
    if (!ts) return { hosts: ["127.0.0.1"], warning: "No Tailscale address found, listening on 127.0.0.1 only" };
    return { hosts: ["127.0.0.1", ts], publicHost: ts };
  }
  return { hosts: pref === "127.0.0.1" ? [pref] : ["127.0.0.1", pref], publicHost: pref };
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

/** Opt-in debug log: PI_WEBSESSION_DEBUG=1 writes to <dataDir>/debug.log */
export function debug(...parts: unknown[]): void {
  if (!process.env.PI_WEBSESSION_DEBUG) return;
  try {
    const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
    appendFileSync(join(dataDir(), "debug.log"), `${new Date().toISOString()} [${process.pid}] ${line}\n`);
  } catch {}
}
