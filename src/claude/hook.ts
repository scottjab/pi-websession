// Claude Code hook entry: `node hook.ts <Event>` reads the hook input on stdin.
// Also `node hook.ts cli <session_id> [args]` for the /web command fallback.
//
// Hooks run for every Claude Code session, so the common path (session not
// shared) has to be cheap: one existsSync and out.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { bindHosts, readShares, removeShare, rotateToken, setShare, shareUrl } from "../config.ts";
import {
  bridgeAlive,
  claim,
  claimRootCarry,
  claudeShareKey,
  clearInbox,
  clearQuestion,
  ensureSessionDir,
  findClaudePid,
  pushEvent,
  questionFile,
  readQuestion,
  sessionDir,
  sessionShared,
  writeCarry,
  type InboxItem,
} from "./state.ts";
import type { AskQuestion } from "../protocol.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Stop the idle waiter a little before the timeout in hooks.json (86400s) kills it. */
const WAIT_MAX_MS = 86_000 * 1000;
const WAIT_POLL_MS = 400;

function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj));
}

async function readStdin(): Promise<any> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const controlOn = (sid: string) => !!readShares()[claudeShareKey(sid)]?.control;

// ---------------------------------------------------------------------------
// Bridge lifecycle
// ---------------------------------------------------------------------------

interface SessionInfo {
  transcript?: string;
  cwd?: string;
  claudePid?: number;
}

function writeInfo(sid: string, info: SessionInfo): void {
  const file = join(ensureSessionDir(sid), "info.json");
  let prev: SessionInfo = {};
  try {
    prev = JSON.parse(readFileSync(file, "utf8"));
  } catch {}
  const next = { ...prev, ...Object.fromEntries(Object.entries(info).filter(([, v]) => v !== undefined)) };
  writeFileSync(file, JSON.stringify(next), { mode: 0o600 });
}

function startBridge(sid: string): void {
  if (bridgeAlive(sid)) return;
  const child = spawn(process.execPath, [join(HERE, "bridge.ts"), sid], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
}

/** Claude Code's transcript for a session id, when the hook input didn't say. */
function findTranscript(sid: string): string | undefined {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, `${sid}.jsonl`);
      if (existsSync(f)) return f;
    }
  } catch {}
  return undefined;
}

// ---------------------------------------------------------------------------
// /web
// ---------------------------------------------------------------------------

const USAGE = "Usage: /web [on|off|control|nocontrol|url|status|rotate]";

async function webCommand(sid: string, args: string, info: SessionInfo): Promise<string> {
  const sub = args.trim().toLowerCase() || "on";
  const key = claudeShareKey(sid);
  const existing = readShares()[key];
  const enable = (control: boolean) => {
    setShare(key, { control, enabledAt: existing?.enabledAt ?? new Date().toISOString(), sessionId: sid });
    writeInfo(sid, { ...info, transcript: info.transcript ?? findTranscript(sid), claudePid: info.claudePid ?? findClaudePid() });
    startBridge(sid);
  };
  switch (sub) {
    case "on": {
      enable(!!existing?.control);
      const w = bindHosts().warning;
      return `Sharing this session (view only${existing?.control ? " + control" : ""}). Open:\n${await shareUrl()}${w ? `\n⚠ ${w}` : ""}\nRun /web control to allow prompting from the browser.`;
    }
    case "control":
      enable(true);
      return `Web control on. Anyone with the URL + token can send prompts to this session and its subagents, and stop them.\n${await shareUrl()}`;
    case "nocontrol":
      if (!existing) return "This session isn't shared.";
      setShare(key, { ...existing, control: false });
      clearInbox(sid);
      return "Web control off (still sharing, view only).";
    case "off":
      removeShare(key);
      try {
        rmSync(sessionDir(sid), { recursive: true, force: true });
      } catch {}
      return "Web sharing off for this session.";
    case "url":
      return await shareUrl();
    case "rotate":
      rotateToken();
      return `New token. Restart other sharing processes so they pick it up.\n${await shareUrl()}`;
    case "status":
      return [`this session: ${existing ? "shared" : "not shared"}${existing?.control ? " (control on)" : ""}`, `bridge: ${bridgeAlive(sid) ? "running" : "not running"}`, `url: ${await shareUrl()}`].join("\n");
    default:
      return USAGE;
  }
}

// ---------------------------------------------------------------------------
// Control delivery
// ---------------------------------------------------------------------------

const STOP_NOTE = "The user pressed stop in the web UI. Stop working on this now: don't call any more tools. End your turn with one short line saying you stopped.";

const WEB_RE = /^\s*\/(?:pi-websession:)?web(?:\s+([\s\S]*))?$/;

const forAgent = (agentId: string | undefined) => (it: InboxItem) => (it.agentId || undefined) === (agentId || undefined);

function framePrompts(items: InboxItem[]): string {
  const direct = items.filter((i) => !i.relay && (i.text ?? "").trim());
  const relays = items.filter((i) => i.relay && (i.text ?? "").trim());
  const parts: string[] = [];
  if (direct.length) {
    const texts = direct.map((i) => i.text!.trim());
    const body = texts.length === 1 ? texts[0] : texts.map((t, i) => `${i + 1}. ${t}`).join("\n\n");
    parts.push(`The user sent ${texts.length === 1 ? "this message" : "these messages"} from the pi-websession web UI. Treat it as their next prompt:\n\n${body}`);
  }
  for (const r of relays) {
    const who = r.relay!.name ? `the subagent "${r.relay!.name}" (agent id ${r.relay!.agentId})` : `subagent ${r.relay!.agentId}`;
    parts.push(`The user sent a message from the pi-websession web UI for ${who}. Pass it on with SendMessage (to: "${r.relay!.agentId}"), word for word, then carry on. If that subagent has already finished, tell the user instead.\n\n${r.text!.trim()}`);
  }
  return parts.join("\n\n---\n\n");
}

const deliveredText = (it: InboxItem) => (it.relay ? `→ ${it.relay.name ?? it.relay.agentId}: ${it.text ?? ""}` : (it.text ?? ""));

/** An abort queued for this thread: stop the turn at this tool boundary. */
function takeAbort(sid: string, agentId: string | undefined): boolean {
  const aborts = claim(sid, (it) => it.kind === "abort" && forAgent(agentId)(it));
  if (!aborts.length) return false;
  pushEvent(sid, { t: "aborted", agentId });
  return true;
}

/** Steering prompts for this thread, delivered next to the tool result. */
function takeSteer(sid: string, agentId: string | undefined): string | undefined {
  if (!controlOn(sid)) return undefined;
  const items = claim(sid, (it) => it.kind === "prompt" && forAgent(agentId)(it) && (it.mode !== "followUp" || !!it.relay));
  if (!items.length) return undefined;
  for (const it of items) pushEvent(sid, { t: "delivered", text: deliveredText(it), mode: "steer", agentId });
  return framePrompts(items);
}

/**
 * The asyncRewake Stop hook: wait in the background until the web sends a
 * prompt, then exit 2 so Claude Code wakes the session with it. A newer
 * waiter, or a prompt typed in the terminal, retires this one.
 */
async function waitForPrompt(sid: string): Promise<number> {
  const file = join(sessionDir(sid), "waiter");
  const me = randomBytes(6).toString("hex");
  writeFileSync(file, `${me} ${process.pid}`, { mode: 0o600 });
  const until = Date.now() + WAIT_MAX_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    let cur = "";
    try {
      cur = readFileSync(file, "utf8");
    } catch {
      return 0; // sharing turned off
    }
    if (cur.split(" ")[0] !== me) return 0;
    if (!controlOn(sid)) continue;
    const items = claim(sid, (it) => it.kind === "prompt" && !it.agentId);
    // An abort while idle has nothing to stop.
    claim(sid, (it) => it.kind === "abort" && !it.agentId);
    if (!items.length) continue;
    writeFileSync(file, "busy", { mode: 0o600 });
    for (const it of items) pushEvent(sid, { t: "delivered", text: deliveredText(it), mode: "idle" });
    pushEvent(sid, { t: "status", s: "running" });
    process.stderr.write(framePrompts(items));
    return 2;
  }
  return 0;
}

/**
 * PermissionRequest for AskUserQuestion. The terminal dialog shows while this
 * runs, so it races the local user: a web answer comes back as allow +
 * updatedInput.answers; an answer in the terminal clears the question file
 * (PostToolUse) and this quits without output. Claude Code ignores a hook
 * that's still running once the dialog is answered.
 */
async function waitForAnswer(sid: string, agentId: string | undefined, toolInput: any): Promise<number> {
  const questions: AskQuestion[] = (Array.isArray(toolInput?.questions) ? toolInput.questions : [])
    .filter((q: any) => q && typeof q.question === "string")
    .map((q: any) => ({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      options: (Array.isArray(q.options) ? q.options : []).filter((o: any) => typeof o?.label === "string").map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : undefined })),
      multiSelect: !!q.multiSelect,
    }));
  if (!questions.length) return 0;
  const id = randomBytes(6).toString("hex");
  const file = questionFile(sid, agentId);
  writeFileSync(file, JSON.stringify({ id, questions }), { mode: 0o600 });
  pushEvent(sid, { t: "ask", id, questions, agentId });
  const until = Date.now() + WAIT_MAX_MS;
  try {
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
      if (readQuestion(sid, agentId)?.id !== id) return 0; // answered in the terminal, or a newer question
      if (!controlOn(sid)) continue;
      if (takeAbort(sid, agentId)) {
        out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: STOP_NOTE } } });
        return 0;
      }
      const got = claim(sid, (it) => it.kind === "answer" && it.qid === id && forAgent(agentId)(it));
      const answers = got.at(-1)?.answers;
      if (!answers || typeof answers !== "object") continue;
      out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { ...toolInput, answers } } } });
      return 0;
    }
    return 0;
  } finally {
    clearQuestion(sid, agentId, id);
    claim(sid, (it) => it.kind === "answer" && it.qid === id); // late duplicates
    pushEvent(sid, { t: "ask_done", id, agentId });
  }
}

function retireWaiter(sid: string): void {
  try {
    writeFileSync(join(sessionDir(sid), "waiter"), "busy", { mode: 0o600 });
  } catch {}
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const event = process.argv[2] ?? "";

  if (event === "cli") {
    const sid = process.argv[3] ?? "";
    if (!sid || sid.includes("CLAUDE_SESSION_ID")) {
      console.log("Couldn't tell which session this is.");
      return 0;
    }
    console.log(await webCommand(sid, process.argv.slice(4).join(" "), { claudePid: findClaudePid() }));
    return 0;
  }

  const input = await readStdin();
  const sid: string = typeof input.session_id === "string" ? input.session_id : "";
  if (!sid) return 0;
  const agentId: string | undefined = input.agent_id || undefined;
  const info: SessionInfo = { transcript: input.transcript_path, cwd: input.cwd };

  if (event === "UserPromptSubmit") {
    const m = WEB_RE.exec(String(input.prompt ?? ""));
    if (m) {
      const msg = await webCommand(sid, m[1] ?? "", { ...info, claudePid: findClaudePid() });
      // Done here, deterministically; the user sees the result straight from the hook.
      // The prompt still goes through, so the turn ends with a Stop and the idle waiter starts.
      out({
        systemMessage: msg,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: `pi-websession already handled this /web command and showed the user this result:\n\n${msg}\n\nReply with one short line (for example "Done."). Don't repeat the result and don't run any tools.`,
        },
      });
      if (sessionShared(sid)) retireWaiter(sid);
      return 0;
    }
  }

  if (event === "SessionStart") {
    const claudePid = findClaudePid();
    // `/clear` keeps sharing on: SessionEnd left a note for this claude process.
    if (input.source === "clear" && claudePid) {
      const carried = claimRootCarry(claudePid);
      if (carried) setShare(claudeShareKey(sid), { control: carried.control, enabledAt: new Date().toISOString(), sessionId: sid });
    }
    if (!readShares()[claudeShareKey(sid)]) return 0;
    writeInfo(sid, { ...info, claudePid });
    startBridge(sid);
    return 0;
  }

  if (event === "SessionStartWait") {
    // A resumed (or /clear-carried) shared session hasn't had a turn end yet, so
    // nothing would wait for web prompts. Listen from the start. The SessionStart
    // hook runs alongside this one; give it a moment to set the session up.
    await new Promise((r) => setTimeout(r, 1500));
    if (!sessionShared(sid)) return 0;
    return await waitForPrompt(sid);
  }

  if (!sessionShared(sid)) return 0;

  switch (event) {
    case "UserPromptSubmit": {
      retireWaiter(sid);
      clearQuestion(sid);
      pushEvent(sid, { t: "status", s: "running" });
      if (!bridgeAlive(sid) && readShares()[claudeShareKey(sid)]) startBridge(sid);
      // Web prompts that were waiting for the session to stop ride along with this one.
      const queued = controlOn(sid) ? claim(sid, (it) => it.kind === "prompt" && !it.agentId) : [];
      claim(sid, (it) => it.kind === "abort" && !it.agentId);
      if (queued.length) {
        for (const it of queued) pushEvent(sid, { t: "delivered", text: deliveredText(it), mode: "steer" });
        out({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: framePrompts(queued).replace("Treat it as their next prompt", "Handle it too, after the prompt they just typed") } });
      }
      return 0;
    }
    // Abort denies the tool and tells Claude to wrap up, rather than `continue: false`:
    // a hard stop skips the Stop hook, and then nothing waits for the next web prompt.
    case "PreToolUse":
      if (takeAbort(sid, agentId)) {
        out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: STOP_NOTE } });
      }
      return 0;
    case "PermissionRequest":
      if (input.tool_name !== "AskUserQuestion") return 0;
      return await waitForAnswer(sid, agentId, input.tool_input);
    case "PostToolUse":
    case "PostToolUseFailure": {
      if (input.tool_name === "AskUserQuestion") clearQuestion(sid, agentId);
      if (takeAbort(sid, agentId)) {
        out({ hookSpecificOutput: { hookEventName: event, additionalContext: STOP_NOTE } });
        return 0;
      }
      const ctx = takeSteer(sid, agentId);
      if (!agentId) pushEvent(sid, { t: "status", s: "running" });
      if (ctx) out({ hookSpecificOutput: { hookEventName: event, additionalContext: ctx } });
      return 0;
    }
    case "Notification": {
      const kind = String(input.notification_type ?? "");
      if (kind === "permission_prompt" || kind === "elicitation_dialog") pushEvent(sid, { t: "status", s: "waiting_ui", agentId });
      return 0;
    }
    case "Stop":
      if (agentId) return 0; // a subagent's turn ending isn't the session going idle
      clearQuestion(sid);
      pushEvent(sid, { t: "status", s: "idle" });
      return await waitForPrompt(sid);
    case "SubagentStart":
      if (input.agent_id) pushEvent(sid, { t: "subagent", agentId: input.agent_id, agentType: input.agent_type, done: false });
      return 0;
    case "SubagentStop":
      if (input.agent_id) pushEvent(sid, { t: "subagent", agentId: input.agent_id, agentType: input.agent_type, done: true, path: input.agent_transcript_path });
      return 0;
    case "PreCompact":
      pushEvent(sid, { t: "compact", on: true, reason: input.trigger === "auto" ? "auto" : "manual" });
      return 0;
    case "PostCompact":
      pushEvent(sid, { t: "compact", on: false });
      return 0;
    case "SessionEnd": {
      retireWaiter(sid);
      clearQuestion(sid);
      pushEvent(sid, { t: "end", reason: input.reason });
      const entry = readShares()[claudeShareKey(sid)];
      const claudePid = findClaudePid();
      if (input.reason === "clear" && entry && claudePid) writeCarry(claudePid, { control: !!entry.control });
      return 0;
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  () => process.exit(0), // never break the user's session over a web view
);
