/**
 * core.ts — pure Node data layer for the Claude Session Monitor.
 *
 * No `vscode` import lives here on purpose: this module is unit-testable on its
 * own (see verify.ts) and is consumed by extension.ts for the UI.
 *
 * Data sources, merged per session id:
 *   1. ~/.claude/session-monitor/<id>.json  — live state written by hook.py
 *      (working / idle / waiting / ended) plus the Notification message.
 *   2. ~/.claude/projects/.../<id>.jsonl    — the transcript; its TAIL gives the
 *      session title (ai-title), the newest CONVERSATIONAL activity, the session
 *      entrypoint, and "limited" detection (isApiErrorMessage + 429).
 *
 * Only interactive sessions are shown. The discriminator is `entrypoint`:
 *   claude-vscode / cli = real tabs;  sdk-cli / sdk-py = claude-mem observers
 *   and SDK subagents (filtered out).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const HOME = os.homedir();
export const MONITOR_DIR = path.join(HOME, ".claude", "session-monitor");
export const PROJECTS_DIR = path.join(HOME, ".claude", "projects");

const MAX_TAIL = 512 * 1024; // bytes of transcript tail to read
const MAX_TAIL_GROW = 4 * 1024 * 1024; // grown window when a huge last line hides the conv line
const STALE_SECONDS = 120;

export const DEFAULT_ENTRYPOINTS = ["claude-vscode", "cli"];
const EXCLUDED_DIR_HINTS = ["observer-sessions", "claude-mem"];

export type Bucket = "limited" | "attention" | "working" | "ended" | "unknown";

export type ConvKind =
  | "end_turn"
  | "tool_use"
  | "tool_result"
  | "user_text"
  | "assistant_other"
  | "api_error"
  | "none";

export interface HookStatus {
  session_id: string;
  state: string; // working | idle | waiting | ended | unknown
  event?: string;
  ts: number; // epoch seconds
  cwd?: string;
  transcript_path?: string;
  permission_mode?: string;
  message?: string;
  notif_type?: string;
  prompt?: string;
  source?: string;
  stop_reason?: string;
  reason?: string;
  pid?: number;
}

export interface LimitInfo {
  kind: "session" | "rate" | "error";
  text: string;
  resetText?: string;
  status?: number;
}

export interface TxInfo {
  title?: string;
  lastPrompt?: string;
  entrypoint?: string;
  convTs: number; // epoch seconds of newest user/assistant line
  convKind: ConvKind;
  convType?: "user" | "assistant";
  limit?: LimitInfo; // set only when convKind === "api_error" AND status 429
  activityTs: number; // newest ts across all lines (incl. hook/meta attachments)
  mtimeMs: number;
  sizeBytes: number;
  cwd?: string;
}

export interface SessionView {
  sessionId: string;
  title: string;
  bucket: Bucket;
  sub: string; // short status label
  detail: string; // tree row description
  tooltip: string;
  cwd?: string;
  cwdLabel?: string;
  transcriptPath?: string;
  lastActivityMs: number;
  resetText?: string;
  permissionMode?: string;
  notifMessage?: string;
  entrypoint?: string;
  pid?: number;
  stale: boolean;
}

export const BUCKET_ORDER: Record<Bucket, number> = {
  limited: 0,
  attention: 1,
  working: 2,
  ended: 3,
  unknown: 4,
};

// ---------------------------------------------------------------------------
// Hook status files
// ---------------------------------------------------------------------------

export function readHookStatuses(): Map<string, HookStatus> {
  const map = new Map<string, HookStatus>();
  let files: string[];
  try {
    files = fs.readdirSync(MONITOR_DIR);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = fs.readFileSync(path.join(MONITOR_DIR, f), "utf8");
      const obj = JSON.parse(raw) as HookStatus;
      if (obj && obj.session_id) map.set(obj.session_id, obj);
    } catch {
      // ignore unreadable/partial files
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Transcript tail parsing
// ---------------------------------------------------------------------------

function readTail(file: string, maxBytes: number): { text: string; partialFirst: boolean } {
  const fd = fs.openSync(file, "r");
  try {
    const stat = fs.fstatSync(fd);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return { text: "", partialFirst: false };
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString("utf8"), partialFirst: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function toEpochSeconds(iso: unknown): number {
  if (typeof iso !== "string") return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}

function extractText(obj: any): string {
  const content = obj?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block.text === "string") return block.text;
    }
  }
  return "";
}

export function classifyLimit(text: string, status?: number): LimitInfo | null {
  if (!text) return null;
  if (/hit your session limit/i.test(text)) {
    const m = text.match(/resets\s+([^()]+?)(?:\s*\(|$)/i);
    return { kind: "session", text, resetText: m ? m[1].trim() : undefined, status };
  }
  if (/temporarily limiting|rate limited|not your usage limit/i.test(text)) {
    return { kind: "rate", text, status };
  }
  return null;
}

/** Classify one user/assistant transcript line. */
function classifyConvLine(obj: any): {
  kind: ConvKind;
  ctype: "user" | "assistant";
  limit?: LimitInfo;
  errText?: string;
} {
  if (obj.type === "assistant") {
    if (obj.isApiErrorMessage === true) {
      const text = extractText(obj);
      // Limits are specifically apiErrorStatus 429. A 529/500/etc. that happens
      // to contain "rate limited" in its text is NOT a usage/session limit.
      const limit =
        obj.apiErrorStatus === 429 ? (classifyLimit(text, obj.apiErrorStatus) ?? undefined) : undefined;
      return { kind: "api_error", ctype: "assistant", limit, errText: text };
    }
    const msg = obj.message || {};
    const sr = msg.stop_reason;
    if (sr === "end_turn" || sr === "stop_sequence") return { kind: "end_turn", ctype: "assistant" };
    if (sr === "tool_use") return { kind: "tool_use", ctype: "assistant" };
    if (Array.isArray(msg.content) && msg.content.some((b: any) => b?.type === "tool_use"))
      return { kind: "tool_use", ctype: "assistant" };
    return { kind: "assistant_other", ctype: "assistant" };
  }
  // user
  const content = obj?.message?.content;
  if (Array.isArray(content) && content.some((b: any) => b?.type === "tool_result"))
    return { kind: "tool_result", ctype: "user" };
  return { kind: "user_text", ctype: "user" };
}

/** Parse a single tail window of `maxBytes`. */
function parseWindow(file: string, stat: fs.Stats, maxBytes: number): TxInfo {
  const info: TxInfo = {
    convTs: 0,
    convKind: "none",
    activityTs: 0,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };

  let text = "";
  let partialFirst = false;
  try {
    const r = readTail(file, maxBytes);
    text = r.text;
    partialFirst = r.partialFirst;
  } catch {
    return info;
  }

  const lines = text.split("\n");
  if (partialFirst && lines.length) lines.shift(); // drop incomplete leading line

  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      continue;
    }
    const type = obj.type;

    if (type === "ai-title" && typeof obj.aiTitle === "string" && obj.aiTitle.trim()) {
      info.title = obj.aiTitle.trim();
      continue;
    }
    if (type === "last-prompt" && typeof obj.lastPrompt === "string" && obj.lastPrompt.trim()) {
      info.lastPrompt = obj.lastPrompt.trim();
      continue;
    }

    if (obj.cwd && !info.cwd) info.cwd = obj.cwd;
    // entrypoint is carried on user/assistant/system/attachment lines; read from any.
    if (obj.entrypoint && !info.entrypoint) info.entrypoint = obj.entrypoint;

    const ts = toEpochSeconds(obj.timestamp);
    if (ts <= 0) continue;
    if (ts > info.activityTs) info.activityTs = ts;

    if (type === "user" || type === "assistant") {
      if (ts >= info.convTs) {
        info.convTs = ts;
        const c = classifyConvLine(obj);
        info.convKind = c.kind;
        info.convType = c.ctype;
        info.limit = c.kind === "api_error" ? c.limit : undefined;
      }
    }
  }

  return info;
}

/**
 * Parse the tail of a transcript file. `prev` lets the caller skip re-parsing
 * unchanged files (cache by mtime + size). If a single line larger than the
 * tail window hides the newest conversational line, the window is grown once.
 */
export function parseTranscriptTail(file: string, prev?: TxInfo): TxInfo {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return prev ?? { convTs: 0, convKind: "none", activityTs: 0, mtimeMs: 0, sizeBytes: 0 };
  }
  if (prev && prev.mtimeMs === stat.mtimeMs && prev.sizeBytes === stat.size) {
    return prev; // unchanged
  }

  let info = parseWindow(file, stat, MAX_TAIL);
  if (info.convKind === "none" && stat.size > MAX_TAIL) {
    // The newest conversational line was probably bigger than the window.
    info = parseWindow(file, stat, Math.min(stat.size, MAX_TAIL_GROW));
  }
  return info;
}

// ---------------------------------------------------------------------------
// State resolution
// ---------------------------------------------------------------------------

export interface ResolveOpts {
  now: number; // epoch seconds
  txPath?: string; // fallback transcript path (when no hook file)
}

function resolve(
  sessionId: string,
  hook: HookStatus | undefined,
  tx: TxInfo | undefined,
  opts: ResolveOpts,
): SessionView {
  const now = opts.now;
  const hookTs = hook?.ts ?? 0;
  const convTs = tx?.convTs ?? 0;
  const mtimeS = tx ? tx.mtimeMs / 1000 : 0;
  const lastActivity = Math.max(hookTs, convTs, tx?.activityTs ?? 0, mtimeS);

  const title =
    tx?.title || hook?.prompt || tx?.lastPrompt || `session ${sessionId.slice(0, 8)}`;
  const cwd = hook?.cwd || tx?.cwd;
  const cwdLabel = cwd ? path.basename(cwd) : undefined;
  const transcriptPath = hook?.transcript_path || opts.txPath;
  const entrypoint = tx?.entrypoint;

  let bucket: Bucket = "unknown";
  let sub = "bilinmiyor";
  let resetText: string | undefined;
  let stale = false;

  const applyWorking = () => {
    bucket = "working";
    stale = now - lastActivity > STALE_SECONDS;
    sub = stale ? "working (stalled?)" : "working";
  };

  // 1) "limited" wins only when the api-error is at least as new as the newest
  //    hook event (a resumed session writes a newer hook event and stays out).
  if (tx?.limit && (tx.limit.kind === "session" || tx.limit.kind === "rate") && convTs >= hookTs) {
    bucket = "limited";
    if (tx.limit.kind === "session") {
      sub = "session limit";
      resetText = tx.limit.resetText;
    } else {
      sub = "rate limited";
    }
  }

  // 2) hook is the newest signal -> trust its state.
  if (bucket === "unknown" && hook && hookTs >= convTs) {
    switch (hook.state) {
      case "working":
        applyWorking();
        break;
      case "waiting":
        bucket = "attention";
        sub = "waiting for you";
        break;
      case "idle":
        bucket = "attention";
        sub = "your turn";
        break;
      case "ended":
        bucket = "ended";
        sub = "ended";
        break;
      default:
        break;
    }
  }

  // 3) derive from the newest conversational line.
  if (bucket === "unknown") {
    switch (tx?.convKind) {
      case "tool_use":
      case "tool_result":
      case "user_text":
      case "assistant_other":
        applyWorking();
        break;
      case "end_turn":
        bucket = "attention";
        sub = "your turn";
        break;
      case "api_error":
        bucket = "attention";
        sub = "API error";
        break;
      default:
        if (hook?.state === "ended") {
          bucket = "ended";
          sub = "ended";
        }
        break;
    }
  }

  const ageStr = lastActivity ? humanizeAge(now - lastActivity) : "";
  const parts: string[] = [];
  if (resetText) parts.push(`reset ${formatReset(resetText, now)}`);
  if (ageStr) parts.push(ageStr);
  if (cwdLabel) parts.push(cwdLabel);
  const detail = parts.join(" · ");

  const tipLines = [
    title,
    `status: ${sub}`,
    cwd ? `cwd: ${cwd}` : "",
    entrypoint ? `source: ${entrypoint}` : "",
    hook?.permission_mode ? `mode: ${hook.permission_mode}` : "",
    hook?.message ? `notification: ${hook.message}` : "",
    resetText ? `limit reset: ${formatReset(resetText, now)}` : "",
    lastActivity ? `last activity: ${ageStr} ago` : "",
    `id: ${sessionId}`,
  ].filter(Boolean);

  return {
    sessionId,
    title,
    bucket,
    sub,
    detail,
    tooltip: tipLines.join("\n"),
    cwd,
    cwdLabel,
    transcriptPath,
    lastActivityMs: lastActivity * 1000,
    resetText,
    permissionMode: hook?.permission_mode,
    notifMessage: hook?.message,
    entrypoint,
    pid: hook?.pid,
    stale,
  };
}

export function humanizeAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Parse a limit reset clock like "1:50pm" / "1:50am" / "13:50" to epoch sec. */
export function parseResetToEpoch(resetText: string, nowSec: number): number | undefined {
  const m = resetText.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!m) return undefined;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return undefined;
  const now = new Date(nowSec * 1000);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
  let t = d.getTime() / 1000;
  if (t < nowSec - 60) t += 24 * 3600; // already passed -> assume next day
  return t;
}

/** "1:50pm (12dk kaldı)" style live countdown; falls back to the raw text. */
export function formatReset(resetText: string, nowSec: number): string {
  const t = parseResetToEpoch(resetText, nowSec);
  if (!t) return resetText;
  const remain = t - nowSec;
  if (remain <= 0) return `${resetText} (now)`;
  return `${resetText} (${humanizeAge(remain)} left)`;
}

// ---------------------------------------------------------------------------
// Recent transcript discovery (bootstrap + ongoing)
// ---------------------------------------------------------------------------

export interface RecentTranscript {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

function dirExcluded(name: string): boolean {
  return EXCLUDED_DIR_HINTS.some((h) => name.includes(h));
}

/** Claude Code encodes a cwd as the project dir name (slashes/dots -> dashes). */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Scan ~/.claude/projects for transcripts modified within `maxAgeMs`.
 * Skips claude-mem/observer dirs. Stat-only; cheap at ~30s cadence.
 */
export function findRecentTranscripts(
  maxAgeMs: number,
  limit: number,
  now: number,
  onlyCwd?: string,
): RecentTranscript[] {
  const out: RecentTranscript[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  const cutoff = now - maxAgeMs / 1000;
  const wantDir = onlyCwd ? encodeProjectDir(onlyCwd) : undefined;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    if (dirExcluded(d.name)) continue;
    if (wantDir && d.name !== wantDir) continue;
    const dirPath = path.join(PROJECTS_DIR, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(dirPath, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs / 1000 >= cutoff) {
          out.push({ sessionId: f.replace(/\.jsonl$/, ""), path: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // ignore
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Top-level collection
// ---------------------------------------------------------------------------

export interface CollectOpts {
  now: number; // epoch seconds
  extraTranscripts?: RecentTranscript[];
  txCache?: Map<string, TxInfo>;
  hideEndedOlderThanSec?: number;
  maxAgeSec?: number;
  allowedEntrypoints?: string[]; // default DEFAULT_ENTRYPOINTS; [] = allow all
  workspaceCwd?: string; // when set, only sessions under this cwd
}

function entrypointAllowed(ep: string | undefined, allowed: string[]): boolean {
  if (allowed.length === 0) return true; // explicit "allow all"
  if (!ep) return true; // unknown -> show (benefit of the doubt)
  return allowed.includes(ep);
}

export function collectSessions(opts: CollectOpts): SessionView[] {
  const now = opts.now;
  const hooks = readHookStatuses();
  const txCache = opts.txCache ?? new Map<string, TxInfo>();
  const allowed = opts.allowedEntrypoints ?? DEFAULT_ENTRYPOINTS;

  const candidates = new Map<string, string | undefined>();
  for (const [sid, h] of hooks) candidates.set(sid, h.transcript_path);
  for (const rt of opts.extraTranscripts ?? []) {
    if (!candidates.has(rt.sessionId) || !candidates.get(rt.sessionId))
      candidates.set(rt.sessionId, rt.path);
  }

  const views: SessionView[] = [];
  for (const [sid, txPath] of candidates) {
    let tx: TxInfo | undefined;
    if (txPath) {
      const prev = txCache.get(txPath);
      tx = parseTranscriptTail(txPath, prev);
      txCache.set(txPath, tx);
    }
    const hook = hooks.get(sid);

    // Filter out observer / SDK-subagent sessions.
    if (!entrypointAllowed(tx?.entrypoint, allowed)) continue;
    const cwd = hook?.cwd || tx?.cwd;
    if (cwd && dirExcluded(cwd)) continue;

    const view = resolve(sid, hook, tx, { now, txPath });
    views.push(view);
  }

  const maxAge = opts.maxAgeSec ?? 6 * 3600;
  const hideEnded = opts.hideEndedOlderThanSec ?? 30 * 60;
  const wsCwd = opts.workspaceCwd;

  const filtered = views.filter((v) => {
    if (wsCwd && v.cwd !== wsCwd) return false;
    const ageSec = v.lastActivityMs ? now - v.lastActivityMs / 1000 : Infinity;
    if (v.bucket === "ended" && ageSec > hideEnded) return false;
    if (ageSec > maxAge) return false;
    return true;
  });

  filtered.sort((a, b) => {
    const bd = BUCKET_ORDER[a.bucket] - BUCKET_ORDER[b.bucket];
    if (bd !== 0) return bd;
    return b.lastActivityMs - a.lastActivityMs;
  });

  return filtered;
}

export interface BucketCounts {
  limited: number;
  attention: number;
  working: number;
  ended: number;
  unknown: number;
}

export function countBuckets(views: SessionView[]): BucketCounts {
  const c: BucketCounts = { limited: 0, attention: 0, working: 0, ended: 0, unknown: 0 };
  for (const v of views) c[v.bucket]++;
  return c;
}

/** Delete monitor json files older than maxAgeMs (keeps the dir tidy). */
export function cleanupMonitorFiles(maxAgeMs: number, now: number): number {
  let removed = 0;
  let files: string[];
  try {
    files = fs.readdirSync(MONITOR_DIR);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(MONITOR_DIR, f);
    try {
      const st = fs.statSync(full);
      if (now * 1000 - st.mtimeMs > maxAgeMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

/**
 * Delete only status files for sessions that have ENDED, or that are stale
 * beyond `staleMs`. Live working/waiting sessions are kept (their only
 * "waiting"/Notification signal must survive a manual cleanup).
 */
export function cleanupEndedMonitorFiles(now: number, staleMs = 12 * 3600 * 1000): number {
  let removed = 0;
  let files: string[];
  try {
    files = fs.readdirSync(MONITOR_DIR);
  } catch {
    return 0;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const full = path.join(MONITOR_DIR, f);
    try {
      const st = fs.statSync(full);
      let ended = false;
      try {
        const obj = JSON.parse(fs.readFileSync(full, "utf8")) as HookStatus;
        ended = obj.state === "ended";
      } catch {
        ended = true; // unreadable -> safe to drop
      }
      if (ended || now * 1000 - st.mtimeMs > staleMs) {
        fs.unlinkSync(full);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Rate-limit budget (written by statusline.sh from Claude Code's rate_limits)
// ---------------------------------------------------------------------------

export const LIMITS_FILE = path.join(MONITOR_DIR, "limits.json");
export const LIMITS_HISTORY = path.join(MONITOR_DIR, "limits-history.jsonl");

/** Raw shape written by statusline.sh. Utilization may be 0-1 or 0-100. */
export interface RawLimits {
  fh?: number | null;
  fh_reset?: number | string | null;
  sd?: number | null;
  sd_reset?: number | string | null;
  sds?: number | null;
  sds_reset?: number | string | null;
  model?: string;
  ts?: number;
}

export function readLimits(): RawLimits | undefined {
  try {
    return JSON.parse(fs.readFileSync(LIMITS_FILE, "utf8")) as RawLimits;
  } catch {
    return undefined;
  }
}

export function readLimitsHistory(maxPoints = 240): RawLimits[] {
  let text = "";
  let partialFirst = false;
  try {
    const r = readTail(LIMITS_HISTORY, 256 * 1024);
    text = r.text;
    partialFirst = r.partialFirst;
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (partialFirst && lines.length) lines.shift();
  const out: RawLimits[] = [];
  for (const ln of lines) {
    const s = ln.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as RawLimits);
    } catch {
      // ignore
    }
  }
  return out.slice(-maxPoints);
}

export function pruneLimitsHistory(maxLines = 3000): void {
  try {
    const lines = fs.readFileSync(LIMITS_HISTORY, "utf8").split("\n").filter((l) => l.trim());
    if (lines.length > maxLines) {
      fs.writeFileSync(LIMITS_HISTORY, lines.slice(-maxLines).join("\n") + "\n");
    }
  } catch {
    // ignore
  }
}
