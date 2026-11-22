// Files the Claude Code hooks and the bridge share. One directory per shared
// Claude Code session: <dataDir>/claude/<session_id>/
//
//   inbox/     web commands waiting for a hook to pick them up (one file each)
//   events     hook -> bridge, one JSON object per line
//   bridge.pid the bridge process publishing this session
//   waiter     token of the newest idle waiter (the asyncRewake Stop hook)
//   question-<agent>.json  the AskUserQuestion a PermissionRequest hook is waiting on

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { dataDir } from "../config.ts";
import type { AskQuestion, AskState } from "../protocol.ts";

export function claudeRoot(): string {
  return join(dataDir(), "claude");
}

export function sessionDir(sid: string): string {
  // Session ids are uuids; anything else could walk out of the directory.
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sid)) throw new Error(`bad session id: ${sid}`);
  return join(claudeRoot(), sid);
}

export function ensureSessionDir(sid: string): string {
  const dir = sessionDir(sid);
  mkdirSync(join(dir, "inbox"), { recursive: true, mode: 0o700 });
  return dir;
}

/** Share key for a Claude Code session in shared-sessions.json. */
export function claudeShareKey(sid: string): string {
  return `claude:${sid}`;
}

// --- hook -> bridge events ---

export type HookEvent =
  | { t: "status"; s: "running" | "idle" | "waiting_ui"; agentId?: string }
  | { t: "delivered"; text: string; mode: "idle" | "steer"; agentId?: string }
  | { t: "compact"; on: boolean; reason?: "manual" | "auto" }
  | { t: "subagent"; agentId: string; agentType?: string; done: boolean; path?: string }
  | { t: "aborted"; agentId?: string }
  | { t: "ask"; id: string; questions: AskQuestion[]; agentId?: string }
  | { t: "ask_done"; id: string; agentId?: string }
  | { t: "end"; reason?: string };

export function pushEvent(sid: string, ev: HookEvent): void {
  try {
    appendFileSync(join(sessionDir(sid), "events"), JSON.stringify({ ...ev, at: Date.now() }) + "\n", { mode: 0o600 });
  } catch {}
}

// --- bridge -> hook commands ---

export interface InboxItem {
  kind: "prompt" | "abort" | "answer";
  text?: string;
  /** steer: next tool boundary. followUp: when the turn ends. */
  mode?: "steer" | "followUp";
  /** Subagent this is for. Unset means the main thread. */
  agentId?: string;
  /** A message for a subagent, delivered to the main thread to pass on with SendMessage. */
  relay?: { agentId: string; name?: string };
  /** For "answer": which question, and question text -> answer. */
  qid?: string;
  answers?: Record<string, string>;
  at: number;
}

export function enqueue(sid: string, item: InboxItem): void {
  const dir = join(ensureSessionDir(sid), "inbox");
  const name = `${String(item.at).padStart(15, "0")}-${randomBytes(4).toString("hex")}.json`;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(item), { mode: 0o600 });
  renameSync(tmp, join(dir, name));
}

/**
 * Take every queued item `want` accepts, oldest first. Claiming is a rename, so
 * two hooks racing for the same item can't both get it.
 */
export function claim(sid: string, want: (it: InboxItem) => boolean): InboxItem[] {
  const dir = join(sessionDir(sid), "inbox");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort();
  } catch {
    return [];
  }
  const out: InboxItem[] = [];
  for (const n of names) {
    const p = join(dir, n);
    let it: InboxItem;
    try {
      it = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    if (!want(it)) continue;
    const mine = `${p}.${process.pid}.claimed`;
    try {
      renameSync(p, mine);
    } catch {
      continue; // someone else got it
    }
    try {
      unlinkSync(mine);
    } catch {}
    out.push(it);
  }
  return out;
}

// --- the open AskUserQuestion, per thread ---

export function questionFile(sid: string, agentId?: string): string {
  const who = agentId && /^[A-Za-z0-9_-]{1,80}$/.test(agentId) ? agentId : "main";
  return join(sessionDir(sid), `question-${who}.json`);
}

export function readQuestion(sid: string, agentId?: string): AskState | undefined {
  try {
    const q = JSON.parse(readFileSync(questionFile(sid, agentId), "utf8"));
    return typeof q?.id === "string" && Array.isArray(q.questions) ? q : undefined;
  } catch {
    return undefined;
  }
}

/** Drop the open question (answered in the terminal, cancelled, or the turn moved on). Its waiting hook sees and quits. */
export function clearQuestion(sid: string, agentId?: string, id?: string): void {
  try {
    if (id && readQuestion(sid, agentId)?.id !== id) return;
    unlinkSync(questionFile(sid, agentId));
  } catch {}
}

export function clearInbox(sid: string): void {
  try {
    rmSync(join(sessionDir(sid), "inbox"), { recursive: true, force: true });
  } catch {}
}

// --- process bookkeeping ---

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

export function readPid(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function bridgeAlive(sid: string): boolean {
  return pidAlive(readPid(join(sessionDir(sid), "bridge.pid")));
}

export function sessionShared(sid: string): boolean {
  try {
    return existsSync(sessionDir(sid));
  } catch {
    return false;
  }
}

/**
 * The Claude Code process this hook runs under: the nearest ancestor whose
 * command line looks like claude. Linux only (/proc); undefined elsewhere.
 */
export function findClaudePid(start = process.ppid): number | undefined {
  let pid = start;
  for (let i = 0; i < 8 && pid > 1; i++) {
    let cmd = "";
    let stat = "";
    try {
      cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
      stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    } catch {
      return undefined;
    }
    // Only argv[0] and argv[1] (node running claude's cli.js), never the rest:
    // `sh -c "node .../src/claude/hook.ts"` mentions claude too.
    const [argv0 = "", argv1 = ""] = cmd.split(" ");
    const bin = argv0.split("/").pop() ?? "";
    if (bin === "claude" || /@anthropic-ai[\\/]claude-code[\\/]/.test(argv1)) return pid;
    // stat: "pid (comm) state ppid ..." where comm can hold spaces and parens.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    pid = Number(rest[1]);
  }
  return undefined;
}

// --- /clear: carry sharing over to the replacement session ---

function carryFile(claudePid: number): string {
  return join(claudeRoot(), `carry-${claudePid}.json`);
}

export function writeCarry(claudePid: number, c: { control: boolean }): void {
  try {
    mkdirSync(claudeRoot(), { recursive: true, mode: 0o700 });
    writeFileSync(carryFile(claudePid), JSON.stringify({ ...c, at: Date.now() }), { mode: 0o600 });
  } catch {}
}

/** The note SessionEnd(clear) left for this claude process, if fresh. Consumed. */
export function claimRootCarry(claudePid: number): { control: boolean } | undefined {
  const f = carryFile(claudePid);
  try {
    const c = JSON.parse(readFileSync(f, "utf8"));
    unlinkSync(f);
    return Date.now() - (c.at ?? 0) < 60_000 ? { control: !!c.control } : undefined;
  } catch {
    return undefined;
  }
}
