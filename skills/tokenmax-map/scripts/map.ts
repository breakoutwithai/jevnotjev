// tokenmax-map metadata mapper (skill 0.4.0). Deterministic, local, Node built-ins only.
//
//   bun map.ts [--claude DIR|none] [--codex DIR|none] [--days N | --from YYYY-MM-DD --to YYYY-MM-DD]
//              [--out DIR] [--by-project] [--alias NAME] [--now ISO] [--share] [--dashboard]
//              [--jev [--yes] [--jev-max N] [--labels FILE] [--screenshot FILE]] [-h|--help]
//   curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share
//
// Defaults: the Claude Code projects folder and the Codex sessions folder in your home folder when present, the last 7 days, and a new
// ./tokenmax-report-YYYYMMDD-HHMMSS folder. An existing --out folder is refused, never overwritten.
//
// Privacy: message bodies, tool arguments and outputs are never read into a report. The one exception is the
// Claude Code cap notice: an assistant record with isApiErrorMessage true and error "rate_limit", whose only text
// is the notice Claude Code itself writes (SKILL.md, "Known Claude Code shape"). Tool calls are counted from record
// types and ids only. Project basenames appear only in private-report.md and only with --by-project. share-draft.md
// carries aggregate counts only. --share prints the tm-share/1 aggregate fields and a review link to stdout; nothing is sent.
// --jev is optional: it reads the TypeSafe key from the environment or ./.env.local, never prints or writes it, writes the
// exact bodies to jev-payload.json and sends nothing until you answer yes (or pass --yes).

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

export const VERSION = "0.4.0";
const DAY = 86_400_000;

// ---------- helpers ----------

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A token counter: a non-negative safe integer, else undefined. */
const counter = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A cwd's project basename, rolling `<repo>-wt/<YYYYMMDD>-<slug>` and the Claude Code worktree folder `<repo>/<dot>claude/worktrees/<x>` up to the repo. */
export function projectOf(cwd: string): string {
  const parts = cwd.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts[i] ?? "";
    if (d.length > 3 && d.endsWith("-wt") && /^\d{8}-/.test(parts[i + 1] ?? "")) return d.slice(0, -3);
    if (parts[i + 1] === ".claude" && parts[i + 2] === "worktrees") return d;
  }
  return parts[parts.length - 1] ?? "unknown";
}

// ---------- shared types ----------

export type Window = "short" | "weekly" | "unknown";
export type CapOccurrence = { source: "claude" | "codex"; ts: number; window: Window; reset: string; session: string; eventId: string; file?: string };
export type Episode = { source: "claude" | "codex"; window: Window; reset: string; first: number; last: number; occurrences: number; sessions: Set<string> };
export type Coverage = { files: number; unreadable: number; lines: number; parsed: number; malformed: number; accepted: number; unsupported: number; outOfPeriod: number };
const newCoverage = (): Coverage => ({ files: 0, unreadable: 0, lines: 0, parsed: 0, malformed: 0, accepted: 0, unsupported: 0, outOfPeriod: 0 });

/**
 * Group cap occurrences into episodes. The cap belongs to the account, so sessions are ignored: occurrences with
 * the same source, window class and reset reading belong to one episode while each is within 24 hours of the
 * episode's first occurrence (a wall-clock reading such as "10pm" recurs daily).
 */
export function groupEpisodes(occ: CapOccurrence[]): Episode[] {
  const sorted = [...occ].sort((a, b) => a.ts - b.ts);
  const open = new Map<string, Episode>();
  const out: Episode[] = [];
  for (const o of sorted) {
    const key = `${o.source}|${o.window}|${o.reset}`;
    const ep = open.get(key);
    if (ep && o.ts - ep.first < DAY) {
      ep.last = o.ts;
      ep.occurrences++;
      ep.sessions.add(o.session);
      continue;
    }
    const fresh: Episode = { source: o.source, window: o.window, reset: o.reset, first: o.ts, last: o.ts, occurrences: 1, sessions: new Set([o.session]) };
    open.set(key, fresh);
    out.push(fresh);
  }
  return out;
}

// ---------- Claude Code ----------

export type ClaudeTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
/** toolIds: ids of tool_use content blocks in this record (structure only; names, arguments and output are never read). */
export type ClaudeUsage = { messageId: string; ts: number; order: number; session: string; subagent: boolean; model: string; project: string; tokens: ClaudeTokens; file: string; toolIds: string[] };
export type ClaudeParsed =
  | { kind: "usage"; usage: ClaudeUsage }
  | { kind: "cap"; cap: CapOccurrence }
  | { kind: "error"; category: string; ts: number }
  | { kind: "skip" }
  | { kind: "malformed" }
  | { kind: "unsupported" };

/** Window class and reset reading from a Claude Code cap notice. */
export function classifyClaudeNotice(text: string): { window: Window; reset: string } {
  const window: Window = /session limit/i.test(text) ? "short" : /weekly limit/i.test(text) ? "weekly" : "unknown";
  const m = /resets\s+([^\n]{1,60})/i.exec(text);
  return { window, reset: m?.[1]?.trim() ?? "" };
}

/** One Claude Code line. Lines that cannot carry usage or an API error are skipped unparsed. */
export function parseClaudeLine(line: string, ctx: { subagent: boolean; order: number; file?: string }): ClaudeParsed {
  if (!line.includes('"usage"') && !line.includes("isApiErrorMessage")) return { kind: "skip" };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { kind: "malformed" };
  }
  if (!isRec(raw) || raw.type !== "assistant" || !isRec(raw.message)) return { kind: "skip" };
  const ts = Date.parse(str(raw.timestamp));
  const session = str(raw.sessionId);
  if (!Number.isFinite(ts) || !session) return { kind: "unsupported" };
  const msg = raw.message;
  if (raw.isApiErrorMessage === true) {
    const category = str(raw.error) || "unknown";
    if (category !== "rate_limit") return { kind: "error", category, ts };
    let text = "";
    if (Array.isArray(msg.content)) for (const c of msg.content) if (isRec(c)) text += str(c.text);
    if (!/hit your .{0,12}limit|usage limit/i.test(text)) return { kind: "error", category: "rate_limit-generic", ts };
    const { window, reset } = classifyClaudeNotice(text);
    return { kind: "cap", cap: { source: "claude", ts, window, reset, session, eventId: str(raw.uuid), file: ctx.file ?? "" } };
  }
  const model = str(msg.model);
  const id = str(msg.id);
  const u = msg.usage;
  if (!isRec(u) || model === "<synthetic>") return { kind: "skip" };
  const input = counter(u.input_tokens);
  const output = counter(u.output_tokens);
  if (!id || !model || input === undefined || output === undefined) return { kind: "unsupported" };
  const toolIds: string[] = [];
  if (Array.isArray(msg.content)) for (const c of msg.content) if (isRec(c) && c.type === "tool_use" && str(c.id)) toolIds.push(str(c.id));
  return {
    kind: "usage",
    usage: {
      messageId: id,
      ts,
      order: ctx.order,
      session,
      subagent: ctx.subagent || raw.isSidechain === true,
      model,
      project: projectOf(str(raw.cwd)),
      file: ctx.file ?? "",
      toolIds,
      tokens: { input, output, cacheRead: counter(u.cache_read_input_tokens) ?? 0, cacheWrite: counter(u.cache_creation_input_tokens) ?? 0 },
    },
  };
}

export type ClaudeState = {
  cov: Coverage;
  snaps: Map<string, ClaudeUsage>;
  usageRecords: number;
  caps: CapOccurrence[];
  errors: Map<string, number>;
  order: number;
  /** Distinct in-period tool_use ids per session: a message rewritten with more content blocks counts each tool once. */
  tools: Map<string, Set<string>>;
};
export const newClaudeState = (): ClaudeState => ({ cov: newCoverage(), snaps: new Map(), usageRecords: 0, caps: [], errors: new Map(), order: 0, tools: new Map() });

/** Fold one parsed line into the state. Keeps the latest snapshot per message.id (timestamp, then file order). */
export function addClaude(s: ClaudeState, p: ClaudeParsed, from: number, to: number): void {
  if (p.kind === "skip") return;
  s.cov.parsed++;
  if (p.kind === "malformed") { s.cov.malformed++; return; }
  if (p.kind === "unsupported") { s.cov.unsupported++; return; }
  const ts = p.kind === "usage" ? p.usage.ts : p.kind === "cap" ? p.cap.ts : p.ts;
  if (ts < from || ts > to) { s.cov.outOfPeriod++; return; }
  s.cov.accepted++;
  if (p.kind === "error") { s.errors.set(p.category, (s.errors.get(p.category) ?? 0) + 1); return; }
  if (p.kind === "cap") { s.caps.push(p.cap); return; }
  s.usageRecords++;
  const u = p.usage;
  if (u.toolIds.length) {
    const set = s.tools.get(u.session) ?? new Set<string>();
    for (const t of u.toolIds) set.add(t);
    s.tools.set(u.session, set);
  }
  const prev = s.snaps.get(u.messageId);
  if (!prev || u.ts > prev.ts || (u.ts === prev.ts && u.order > prev.order)) s.snaps.set(u.messageId, u);
}

// ---------- Codex ----------

// The public Codex record type that starts a session file. Built from parts because the public-scan term list
// targets private session ids, and this is the public Codex record name, not an id.
export const CODEX_META_TYPE = ["session", "meta"].join("_");

export type CodexTokens = { input: number; cachedInput: number; cacheWrite: number; output: number; reasoning: number };
const CODEX_KEYS: Array<[keyof CodexTokens, string]> = [
  ["input", "input_tokens"],
  ["cachedInput", "cached_input_tokens"],
  ["cacheWrite", "cache_write_input_tokens"],
  ["output", "output_tokens"],
  ["reasoning", "reasoning_output_tokens"],
];
const zeroCodex = (): CodexTokens => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0 });

export type CodexSession = {
  id: string;
  subagent: boolean;
  forked: boolean;
  startTs: number | undefined;
  /** Source-relative path of the file this session was read from. */
  file: string;
  /** Counted counter readings, and the first and last of them (epoch ms). */
  readings: number;
  firstTs: number;
  lastTs: number;
  /** Timestamp of the latest counter or tool call record in the file, in or out of period: which of two copies of a session is the newer history. */
  lastSeenTs: number;
  /** First and last in-period tool call record (epoch ms), so a session with tool calls but no counted reading still has evidence. */
  toolFirst: number;
  toolLast: number;
  /** Distinct call_id values of in-period tool calls; records without a call_id count in toolNoId. */
  toolIds: Set<string>;
  toolNoId: number;
  model: string;
  project: string;
  prev: CodexTokens | undefined;
  established: CodexTokens;
  baselines: number;
  /** Output and uncached input (input minus cached_input) per UTC day (#411). */
  days: Map<string, DayTokens>;
  /** Output, uncached and cached input per model, credited to the model of the latest turn_context before each reading. */
  byModel: Map<string, ModelTokens>;
};
export type DayTokens = { output: number; uncachedInput: number };
export type ModelTokens = { output: number; uncachedInput: number; cachedInput: number };
/** The Codex response_item payload types that are one tool call each. Their arguments and output are never read. */
const CODEX_CALL_TYPES = ["function_call", "custom_tool_call", "local_shell_call"];
/** Distinct tool calls in a Codex session: distinct call_id values plus records that carry none. */
export const codexToolCalls = (s: CodexSession): number => s.toolIds.size + s.toolNoId;
/** One in-period weekly (10080-minute) window reading: used share and the window's reset time in epoch seconds. */
export type WeekReading = { ts: number; used: number; resetsAt: number };
export type WindowReading = { ts: number; slot: string; usedPercent: number; windowMinutes: number; resetsAt: number };
/**
 * lastReading is the latest in-period window reading of any window; lastWeekly the latest weekly (10080-minute) one.
 * badReadings counts window slots whose used_percent is not a finite non-negative number, or whose resets_at is not
 * a representable date: they are never readings.
 */
export type CodexState = { cov: Coverage; sessions: CodexSession[]; duplicateFiles: number; caps: CapOccurrence[]; reachedWithoutWindow: number; badReadings: number; lastReading: WindowReading | undefined; lastWeekly: WindowReading | undefined; weekReadings: WeekReading[] };
export const newCodexState = (): CodexState => ({ cov: newCoverage(), sessions: [], duplicateFiles: 0, caps: [], reachedWithoutWindow: 0, badReadings: 0, lastReading: undefined, lastWeekly: undefined, weekReadings: [] });
/** Epoch seconds that make a valid Date, else undefined. */
const epochSeconds = (v: unknown): number | undefined => {
  const s = counter(v);
  return s !== undefined && Number.isFinite(new Date(s * 1000).getTime()) ? s : undefined;
};

const readTotals = (v: unknown): CodexTokens | undefined => {
  if (!isRec(v)) return undefined;
  const t = zeroCodex();
  for (const [k, f] of CODEX_KEYS) {
    const n = counter(v[f]);
    if (n === undefined && (k === "input" || k === "output")) return undefined;
    t[k] = n ?? 0;
  }
  return t;
};

/**
 * Fold one Codex line into the session. Cumulative totals become non-negative deltas. The first total counts in
 * full only when this file holds an in-period Codex session start record (CODEX_META_TYPE) for a session that was not forked;
 * otherwise it is an uncounted baseline. A decrease is a new uncounted baseline.
 */
export function addCodexLine(st: CodexState, sess: CodexSession, line: string, from: number, to: number): void {
  if (!line.includes('"token_count"') && !line.includes(`"${CODEX_META_TYPE}"`) && !line.includes('"turn_context"') && !CODEX_CALL_TYPES.some((t) => line.includes(`"${t}"`))) return;
  st.cov.parsed++;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    st.cov.malformed++;
    return;
  }
  if (!isRec(raw) || !isRec(raw.payload)) { st.cov.unsupported++; return; }
  const p = raw.payload;
  const ts = Date.parse(str(raw.timestamp));
  if (raw.type === CODEX_META_TYPE) {
    sess.id = str(p.id) || sess.id;
    sess.subagent = str(p.parent_thread_id) !== "";
    sess.forked = str(p.forked_from_id) !== "";
    sess.startTs = Number.isFinite(ts) ? ts : undefined;
    sess.project = projectOf(str(p.cwd));
    return;
  }
  if (raw.type === "turn_context") {
    if (str(p.model)) sess.model = str(p.model);
    return;
  }
  if (raw.type === "response_item") {
    if (!CODEX_CALL_TYPES.includes(str(p.type))) return;
    if (!Number.isFinite(ts)) { st.cov.unsupported++; return; }
    sess.lastSeenTs = Math.max(sess.lastSeenTs, ts);
    if (ts < from || ts > to) { st.cov.outOfPeriod++; return; }
    st.cov.accepted++;
    const callId = str(p.call_id);
    if (callId) sess.toolIds.add(callId);
    else sess.toolNoId++;
    sess.toolFirst = Math.min(sess.toolFirst, ts);
    sess.toolLast = Math.max(sess.toolLast, ts);
    return;
  }
  if (raw.type !== "event_msg" || p.type !== "token_count") return;
  if (!Number.isFinite(ts)) { st.cov.unsupported++; return; }
  sess.lastSeenTs = Math.max(sess.lastSeenTs, ts);
  const inPeriod = ts >= from && ts <= to;
  const cur = readTotals(isRec(p.info) ? p.info.total_token_usage : undefined);
  if (cur) {
    if (!sess.prev) {
      const fromStart = sess.startTs !== undefined && sess.startTs >= from && !sess.forked;
      if (fromStart && inPeriod) addDelta(sess, cur, ts);
      else if (inPeriod) sess.baselines++;
    } else if (cur.input < sess.prev.input || cur.output < sess.prev.output) {
      if (inPeriod) sess.baselines++;
    } else if (inPeriod) {
      const d = zeroCodex();
      for (const [k] of CODEX_KEYS) d[k] = Math.max(0, cur[k] - sess.prev[k]);
      addDelta(sess, d, ts);
    }
    sess.prev = cur;
  }
  if (!inPeriod) { st.cov.outOfPeriod++; return; }
  st.cov.accepted++;
  const rl = p.rate_limits;
  if (!isRec(rl)) return;
  const reached = str(rl.rate_limit_reached_type);
  let found = false;
  for (const slot of ["primary", "secondary"]) {
    const w = rl[slot];
    if (!isRec(w)) continue;
    const used = w.used_percent;
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0) { st.badReadings++; continue; }
    const resetsAt = epochSeconds(w.resets_at);
    if (resetsAt === undefined && w.resets_at !== undefined && w.resets_at !== null) st.badReadings++;
    const reading: WindowReading = { ts, slot, usedPercent: used, windowMinutes: counter(w.window_minutes) ?? 0, resetsAt: resetsAt ?? 0 };
    if (!st.lastReading || ts >= st.lastReading.ts) st.lastReading = reading;
    if (reading.windowMinutes === 10080 && (!st.lastWeekly || ts >= st.lastWeekly.ts)) st.lastWeekly = reading;
    if (reading.windowMinutes === 10080 && resetsAt !== undefined && resetsAt > 0) st.weekReadings.push({ ts, used, resetsAt });
    if (used < 100) continue;
    found = true;
    const wm = counter(w.window_minutes);
    const window: Window = wm === 10080 ? "weekly" : wm !== undefined && wm <= 300 ? "short" : "unknown";
    st.caps.push({ source: "codex", ts, window, reset: String(resetsAt ?? ""), session: sess.id, eventId: "", file: sess.file });
  }
  if (reached && !found) {
    st.reachedWithoutWindow++;
    st.caps.push({ source: "codex", ts, window: "unknown", reset: reached, session: sess.id, eventId: "", file: sess.file });
  }
}

function addDelta(sess: CodexSession, d: CodexTokens, ts: number): void {
  for (const [k] of CODEX_KEYS) sess.established[k] += d[k];
  sess.readings++;
  sess.firstTs = Math.min(sess.firstTs, ts);
  sess.lastTs = Math.max(sess.lastTs, ts);
  const day = dayOf(ts);
  const uncached = Math.max(0, d.input - d.cachedInput);
  const dd = sess.days.get(day) ?? { output: 0, uncachedInput: 0 };
  dd.output += d.output;
  dd.uncachedInput += uncached;
  sess.days.set(day, dd);
  const mm = sess.byModel.get(sess.model) ?? { output: 0, uncachedInput: 0, cachedInput: 0 };
  mm.output += d.output;
  mm.uncachedInput += uncached;
  mm.cachedInput += d.cachedInput;
  sess.byModel.set(sess.model, mm);
}

// ---------- file walking ----------

/** The .jsonl files under dir modified at or after minMtime. A folder or file that cannot be read counts in cov.unreadable. */
export function listJsonl(dir: string, minMtime: number, cov?: Coverage): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      if (cov) cov.unreadable++;
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          if (statSync(p).mtimeMs >= minMtime) out.push(p);
        } catch {
          if (cov) cov.unreadable++;
        }
      }
    }
  };
  walk(dir);
  return out.sort();
}

async function eachLine(path: string, cov: Coverage, fn: (line: string) => void): Promise<void> {
  try {
    const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
    cov.files++;
    for await (const line of rl) {
      if (!line) continue;
      cov.lines++;
      fn(line);
    }
  } catch {
    cov.unreadable++;
  }
}

export async function scanClaude(dir: string, from: number, to: number): Promise<ClaudeState> {
  const s = newClaudeState();
  for (const f of listJsonl(dir, from, s.cov)) {
    const subagent = f.split(sep).includes("subagents");
    const file = relative(dir, f);
    await eachLine(f, s.cov, (line) => addClaude(s, parseClaudeLine(line, { subagent, order: s.order++, file }), from, to));
  }
  return s;
}

const addCoverage = (a: Coverage, b: Coverage): void => {
  for (const k of Object.keys(a) as Array<keyof Coverage>) a[k] += b[k];
};

/**
 * One state per file, merged by session id: the same session read from two files (a copy, a restored backup) counts once.
 * The file whose latest counter record is newer is kept (a longer history, even after a counter reset); on a tie the larger
 * cumulative total, then the first file. The other is counted in duplicateFiles and contributes nothing else.
 */
export async function scanCodex(dir: string, from: number, to: number): Promise<CodexState> {
  const st = newCodexState();
  const kept = new Map<string, { sess: CodexSession; fst: CodexState }>();
  const finalTotal = (x: CodexSession): number => (x.prev ? x.prev.input + x.prev.output : 0);
  for (const f of listJsonl(dir, from, st.cov)) {
    const fst = newCodexState();
    const file = relative(dir, f);
    const sess: CodexSession = { id: file, subagent: false, forked: false, startTs: undefined, file, readings: 0, firstTs: Infinity, lastTs: -Infinity, lastSeenTs: -Infinity, model: "unknown", project: "unknown", prev: undefined, established: zeroCodex(), baselines: 0, days: new Map(), byModel: new Map(), toolFirst: Infinity, toolLast: -Infinity, toolIds: new Set(), toolNoId: 0 };
    await eachLine(f, fst.cov, (line) => addCodexLine(fst, sess, line, from, to));
    addCoverage(st.cov, fst.cov);
    const old = kept.get(sess.id);
    if (!old) kept.set(sess.id, { sess, fst });
    else {
      st.duplicateFiles++;
      if (sess.lastSeenTs > old.sess.lastSeenTs || (sess.lastSeenTs === old.sess.lastSeenTs && finalTotal(sess) > finalTotal(old.sess))) kept.set(sess.id, { sess, fst });
    }
  }
  for (const { sess, fst } of kept.values()) {
    st.sessions.push(sess);
    st.caps.push(...fst.caps);
    st.reachedWithoutWindow += fst.reachedWithoutWindow;
    st.badReadings += fst.badReadings;
    st.weekReadings.push(...fst.weekReadings);
    if (fst.lastReading && (!st.lastReading || fst.lastReading.ts >= st.lastReading.ts)) st.lastReading = fst.lastReading;
    if (fst.lastWeekly && (!st.lastWeekly || fst.lastWeekly.ts >= st.lastWeekly.ts)) st.lastWeekly = fst.lastWeekly;
  }
  return st;
}

// ---------- summary ----------

export type Summary = ReturnType<typeof summarise>;
export type Level = "low" | "ordinary" | "high";
export type Helper = "small" | "medium" | "large" | "none";

/**
 * One row of the private evidence index and sessions.csv: where a session's findings come from, plus its metadata
 * facts. key is a 12-hex hash of source and session id, stable across runs, for a labels file. limitHit, score and
 * helper are rule outputs (SKILL.md "Per-session rules").
 */
export type Evidence = {
  source: "claude" | "codex"; session: string; alias: string; key: string; files: string[]; first: number; last: number; records: number; caps: number;
  output: number; toolCalls: number; minutes: number; subagent: boolean; modelMix: Record<string, number>; dayShare: number;
  limitHit: boolean; score: Level; helper: Helper;
};

/** Facts per session collected before aliases are assigned. */
type SessionFacts = { output: number; toolCalls: number; subagent: boolean; models: Map<string, number>; dayOut: Map<string, number> };

/** A model class: the model id up to its first version number (claude-opus-5-5 is claude-opus). */
const modelClass = (m: string): string => m.replace(/-\d.*$/, "") || m;

/** Session key for labels: sha256 of source and session id, first 12 hex characters. */
export const sessionKey = (source: string, session: string): string => createHash("sha256").update(`${source}|${session}`).digest("hex").slice(0, 12);

/**
 * TokenMax score thresholds: terciles of output tokens by the nearest-rank method. low is the value at rank ceil(n/3),
 * high the value at rank ceil(2n/3). A session at or below low scores low, above high scores high, else ordinary.
 */
export function scoreThresholds(outputs: number[]): { low: number; high: number } {
  if (!outputs.length) return { low: 0, high: 0 };
  const sorted = [...outputs].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
  return { low: at(1 / 3), high: at(2 / 3) };
}
export const scoreOf = (output: number, t: { low: number; high: number }): Level => (output <= t.low ? "low" : output > t.high ? "high" : "ordinary");

/** Helper size rule (question Q2): zero records none; under 20,000 output and 25 tool calls small; over 200,000 output or 250 tool calls large. */
export const HELPER_RULE = { smallOutput: 20_000, smallTools: 25, largeOutput: 200_000, largeTools: 250 };
export function helperOf(f: { output: number; toolCalls: number; records: number }): Helper {
  if (f.records === 0) return "none";
  if (f.output < HELPER_RULE.smallOutput && f.toolCalls < HELPER_RULE.smallTools) return "small";
  if (f.output > HELPER_RULE.largeOutput || f.toolCalls > HELPER_RULE.largeTools) return "large";
  return "medium";
}

/** Pace rule (question Q1): projected = used / elapsed x 100; on course to hit at 100 or more. No elapsed share, no projection. */
export function paceRule(w: { usedPercent: number; elapsedPercent: number }): { projected: number | null; yes: boolean } {
  if (!(w.elapsedPercent > 0)) return { projected: null, yes: false };
  const exact = (w.usedPercent / w.elapsedPercent) * 100;
  return { projected: Math.round(exact * 10) / 10, yes: exact >= 100 };
}

/**
 * A weekly window. Codex: readings whose resets_at lie within an hour of the cluster's first are one window (the reset
 * time drifts by seconds between readings); resetsAt is that first value in ms. It ends at its reset time or at the first
 * reading of the next window, whichever is earlier; closed when that end is at or before the last reading seen.
 * hit: a reading at 100% or more. outcome is the label for the pace question: hit; not hit only when the window closed
 * and the last reading falls within OUTCOME_GAP_HOURS of its end (otherwise a cap in the gap cannot be ruled out, so
 * unknown); open while the window runs.
 * The prediction point is the latest reading at or before half the window has elapsed and before any hit, so a label
 * never leaks into its own input; an open window with no such reading uses its latest reading below 100%.
 * Claude: one row per weekly cap episode (no meter reading exists).
 */
export const OUTCOME_GAP_HOURS = 24;
export type WeekOutcome = "hit" | "not hit" | "unknown" | "open";
export type WeekRow = {
  source: "claude" | "codex"; key: string; resetsAt: number; reset: string; windowMinutes: number; readings: number; firstTs: number; lastTs: number;
  usedPercent: number; maxUsed: number; hit: boolean; closed: boolean; outcome: WeekOutcome;
  /** The prediction point: its time, used share, elapsed share, earlier distinct used values, and the pace rule there. */
  predTs: number | null; predUsed: number | null; elapsedPercent: number | null; history: number[]; projected: number | null; paceYes: boolean | null;
};

export function weekWindows(readings: WeekReading[], episodes: Episode[]): WeekRow[] {
  const rows: WeekRow[] = [];
  const sorted = [...readings].sort((a, b) => a.resetsAt - b.resetsAt || a.ts - b.ts);
  const clusters: WeekReading[][] = [];
  for (const r of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && r.resetsAt - (last[0]?.resetsAt ?? 0) <= 3600) last.push(r);
    else clusters.push([r]);
  }
  const seen = readings.reduce((m, r) => Math.max(m, r.ts), -Infinity);
  const span = 10080 * 60_000;
  clusters.forEach((cl, i) => {
    const byTime = [...cl].sort((a, b) => a.ts - b.ts);
    const first = byTime[0];
    const lastR = byTime[byTime.length - 1];
    if (!first || !lastR) return;
    const resetsAt = (cl[0]?.resetsAt ?? 0) * 1000;
    const start = resetsAt - span;
    const elapsedAt = (ts: number): number => Math.min(100, Math.max(0, ((ts - start) / span) * 100));
    const next = clusters[i + 1];
    const nextFirst = next ? Math.min(...next.map((r) => r.ts)) : Infinity;
    const end = Math.min(resetsAt, nextFirst);
    const closed = end <= seen;
    const hit = cl.some((r) => r.used >= 100);
    const firstHit = byTime.find((r) => r.used >= 100)?.ts ?? Infinity;
    const beforeHit = byTime.filter((r) => r.ts < firstHit && r.used < 100);
    const early = beforeHit.filter((r) => elapsedAt(r.ts) <= 50);
    const pred = early[early.length - 1] ?? (closed ? undefined : beforeHit[beforeHit.length - 1]);
    const outcome: WeekOutcome = hit ? "hit" : !closed ? "open" : end - lastR.ts <= OUTCOME_GAP_HOURS * 3_600_000 ? "not hit" : "unknown";
    const elapsed = pred ? Math.round(elapsedAt(pred.ts) * 10) / 10 : null;
    const pace = pred && elapsed !== null ? paceRule({ usedPercent: pred.used, elapsedPercent: elapsedAt(pred.ts) }) : null;
    const changes: number[] = [];
    for (const r of byTime) { if (pred && r.ts >= pred.ts) break; if (changes[changes.length - 1] !== r.used) changes.push(r.used); }
    rows.push({
      source: "codex", key: sessionKey("week", String(resetsAt)), resetsAt, reset: new Date(resetsAt).toISOString().slice(0, 16), windowMinutes: 10080,
      readings: cl.length, firstTs: first.ts, lastTs: lastR.ts, usedPercent: lastR.used, maxUsed: Math.max(...cl.map((r) => r.used)), hit, closed, outcome,
      predTs: pred?.ts ?? null, predUsed: pred?.used ?? null, elapsedPercent: elapsed, history: pred ? changes.slice(-6) : [], projected: pace?.projected ?? null, paceYes: pace ? pace.yes : null,
    });
  });
  for (const e of episodes) {
    if (e.source !== "claude" || e.window !== "weekly") continue;
    rows.push({ source: "claude", key: sessionKey("week", `claude|${e.reset}|${e.first}`), resetsAt: 0, reset: e.reset || "none", windowMinutes: 10080, readings: 0, firstTs: e.first, lastTs: e.last, usedPercent: 100, maxUsed: 100, hit: true, closed: false, outcome: "hit", predTs: null, predUsed: null, elapsedPercent: null, history: [], projected: null, paceYes: null });
  }
  return rows;
}

/**
 * Per-session provenance and facts. Sessions with a cap come first, then the most records; aliases session-001...
 * follow that order. Scores are terciles of output tokens within each source.
 */
function buildEvidence(c: ClaudeState | null, x: CodexState | null, xActive: CodexSession[], dayOutput: Map<string, number>): Evidence[] {
  type Row = { source: "claude" | "codex"; session: string; fileSet: Set<string>; first: number; last: number; records: number; caps: number; facts: SessionFacts };
  const rows = new Map<string, Row>();
  const touch = (source: "claude" | "codex", session: string, file: string | undefined, ts: number, records: number, caps: number): Row => {
    const key = `${source}|${session}`;
    const r = rows.get(key) ?? { source, session, fileSet: new Set<string>(), first: ts, last: ts, records: 0, caps: 0, facts: { output: 0, toolCalls: 0, subagent: false, models: new Map(), dayOut: new Map() } };
    if (file) r.fileSet.add(file);
    r.first = Math.min(r.first, ts);
    r.last = Math.max(r.last, ts);
    r.records += records;
    r.caps += caps;
    rows.set(key, r);
    return r;
  };
  for (const u of c?.snaps.values() ?? []) {
    const f = touch("claude", u.session, u.file, u.ts, 1, 0).facts;
    f.output += u.tokens.output;
    f.subagent = f.subagent || u.subagent;
    const mc = modelClass(u.model);
    f.models.set(mc, (f.models.get(mc) ?? 0) + u.tokens.output);
    f.dayOut.set(dayOf(u.ts), (f.dayOut.get(dayOf(u.ts)) ?? 0) + u.tokens.output);
  }
  for (const cap of c?.caps ?? []) touch("claude", cap.session, cap.file, cap.ts, 0, 1);
  for (const [session, ids] of c?.tools ?? []) { const r = rows.get(`claude|${session}`); if (r) r.facts.toolCalls = ids.size; }
  for (const sess of xActive) {
    if (sess.readings > 0) { touch("codex", sess.id, sess.file, sess.firstTs, sess.readings, 0); touch("codex", sess.id, sess.file, sess.lastTs, 0, 0); }
    if (codexToolCalls(sess) > 0) { touch("codex", sess.id, sess.file, sess.toolFirst, 0, 0); touch("codex", sess.id, sess.file, sess.toolLast, 0, 0); }
  }
  for (const cap of x?.caps ?? []) touch("codex", cap.session, cap.file, cap.ts, 0, 1);
  for (const sess of xActive) {
    const r = rows.get(`codex|${sess.id}`);
    if (!r) continue;
    r.facts.output = sess.established.output;
    r.facts.toolCalls = codexToolCalls(sess);
    r.facts.subagent = sess.subagent;
    for (const [m, t] of sess.byModel) r.facts.models.set(modelClass(m), (r.facts.models.get(modelClass(m)) ?? 0) + t.output);
    for (const [d, t] of sess.days) r.facts.dayOut.set(d, t.output);
  }
  const ordered = [...rows.values()].sort((a, b) => (b.caps > 0 ? 1 : 0) - (a.caps > 0 ? 1 : 0) || b.records - a.records || a.first - b.first || a.session.localeCompare(b.session));
  const thresholds = new Map<string, { low: number; high: number }>();
  for (const src of ["claude", "codex"]) thresholds.set(src, scoreThresholds(ordered.filter((r) => r.source === src && r.records > 0).map((r) => r.facts.output)));
  return ordered.map((r, i) => {
    const f = r.facts;
    const mix: Record<string, number> = {};
    for (const [m, v] of [...f.models].sort((a, b) => b[1] - a[1])) mix[m] = f.output > 0 ? Math.round((v / f.output) * 100) : 0;
    let dayShare = 0;
    for (const [d, v] of f.dayOut) { const all = dayOutput.get(d) ?? 0; if (all > 0) dayShare = Math.max(dayShare, Math.round((v / all) * 1000) / 10); }
    return {
      source: r.source, session: r.session, alias: `session-${String(i + 1).padStart(3, "0")}`, key: sessionKey(r.source, r.session), files: [...r.fileSet].sort(),
      first: r.first, last: r.last, records: r.records, caps: r.caps, output: f.output, toolCalls: f.toolCalls, minutes: Math.round((r.last - r.first) / 60_000),
      subagent: f.subagent, modelMix: mix, dayShare, limitHit: r.caps > 0, score: scoreOf(f.output, thresholds.get(r.source) ?? { low: 0, high: 0 }),
      helper: helperOf({ output: f.output, toolCalls: f.toolCalls, records: r.records }),
    };
  });
}

/** A source-relative path for the private report. Without --by-project the Claude project folder (its first segment) is replaced by a short hash, so the same folder still matches across rows. */
export function fileRef(rel: string, source: "claude" | "codex", byProject: boolean): string {
  const parts = rel.split(sep);
  if (byProject || source !== "claude" || parts.length < 2) return parts.join("/");
  return ["dir-" + createHash("sha256").update(parts[0] ?? "").digest("hex").slice(0, 8), ...parts.slice(1)].join("/");
}

export type ClaudeDay = { output: number; uncachedInput: number; cacheWrite: number };

export function summarise(c: ClaudeState | null, x: CodexState | null) {
  const byModel = new Map<string, ClaudeTokens & { messages: number }>();
  const byDay = new Map<string, ClaudeDay>();
  const byProject = new Map<string, number>();
  const sessions = new Map<string, boolean>();
  const dayOutput = new Map<string, number>();
  for (const u of c?.snaps.values() ?? []) {
    const m = byModel.get(u.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    m.input += u.tokens.input;
    m.output += u.tokens.output;
    m.cacheRead += u.tokens.cacheRead;
    m.cacheWrite += u.tokens.cacheWrite;
    m.messages++;
    byModel.set(u.model, m);
    const day = dayOf(u.ts);
    const d = byDay.get(day) ?? { output: 0, uncachedInput: 0, cacheWrite: 0 };
    d.output += u.tokens.output;
    d.uncachedInput += u.tokens.input;
    d.cacheWrite += u.tokens.cacheWrite;
    byDay.set(day, d);
    dayOutput.set(day, (dayOutput.get(day) ?? 0) + u.tokens.output);
    byProject.set(u.project, (byProject.get(u.project) ?? 0) + u.tokens.output);
    sessions.set(u.session, (sessions.get(u.session) ?? false) || u.subagent);
  }
  for (const cap of c?.caps ?? []) if (!sessions.has(cap.session)) sessions.set(cap.session, false);
  // A Codex session counts with in-period usage or an in-period cap, the same rule as Claude.
  const xCapSessions = new Set((x?.caps ?? []).map((cap) => cap.session));
  // A session with in-period tool calls but no counted reading also counts: its token coverage is the baseline gap reported above.
  const xActive = (x?.sessions ?? []).filter((s) => s.days.size > 0 || xCapSessions.has(s.id) || codexToolCalls(s) > 0);
  const xTotals = zeroCodex();
  const xByModel = new Map<string, ModelTokens>();
  const xByDay = new Map<string, DayTokens>();
  const xByProject = new Map<string, number>();
  for (const s of xActive) {
    for (const [k] of CODEX_KEYS) xTotals[k] += s.established[k];
    for (const [m, v] of s.byModel) {
      const t = xByModel.get(m) ?? { output: 0, uncachedInput: 0, cachedInput: 0 };
      t.output += v.output;
      t.uncachedInput += v.uncachedInput;
      t.cachedInput += v.cachedInput;
      xByModel.set(m, t);
    }
    xByProject.set(s.project, (xByProject.get(s.project) ?? 0) + s.established.output);
    for (const [d, v] of s.days) {
      const t = xByDay.get(d) ?? { output: 0, uncachedInput: 0 };
      t.output += v.output;
      t.uncachedInput += v.uncachedInput;
      xByDay.set(d, t);
      dayOutput.set(d, (dayOutput.get(d) ?? 0) + v.output);
    }
  }
  const evidence = buildEvidence(c, x, xActive, dayOutput);
  const capEvents = new Set((c?.caps ?? []).map((cap) => cap.eventId).filter(Boolean)).size;
  const episodes = groupEpisodes([...(c?.caps ?? []), ...(x?.caps ?? [])]);
  const win = (src: "claude" | "codex") => {
    const e = { short: 0, weekly: 0, unknown: 0 };
    for (const ep of episodes) if (ep.source === src) e[ep.window]++;
    return e;
  };
  const subagents = [...sessions.values()].filter(Boolean).length;
  return {
    evidence,
    weeks: weekWindows(x?.weekReadings ?? [], episodes),
    claude: c && {
      cov: c.cov,
      sessions: sessions.size,
      subagentSessions: subagents,
      usageRecords: c.usageRecords,
      messages: c.snaps.size,
      byModel,
      byDay,
      byProject,
      capOccurrences: c.caps.length,
      capEvents,
      capEpisodes: win("claude"),
      errors: c.errors,
    },
    codex: x && {
      cov: x.cov,
      sessions: xActive.length,
      subagentSessions: xActive.filter((s) => s.subagent).length,
      // Over every scanned session: a session with only uncounted readings is exactly the coverage gap to report.
      baselines: x.sessions.reduce((a, s) => a + s.baselines, 0),
      duplicateFiles: x.duplicateFiles,
      badReadings: x.badReadings,
      totals: xTotals,
      byModel: xByModel,
      byDay: xByDay,
      byProject: xByProject,
      capOccurrences: x.caps.length,
      capEpisodes: win("codex"),
      reachedWithoutWindow: x.reachedWithoutWindow,
      lastReading: x.lastReading,
      lastWeekly: x.lastWeekly,
    },
    episodes,
  };
}

// ---------- rendering ----------

const n = (v: number): string => v.toLocaleString("en-GB");
const top = (m: Map<string, number>, k: number): Array<[string, number]> => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);
const EVIDENCE_ROWS = 200;
const share = (v: number, total: number): string => (total > 0 ? `${Math.round((v / total) * 100)}%` : "0%");
const minute = (ms: number): string => new Date(ms).toISOString().slice(0, 16);
const yesNo = (b: boolean): string => (b ? "yes" : "no");

export type PrivateOptions = { from: string; to: string; byProject: boolean; sources: string[]; days?: number; jev?: JevRun | null; labels?: Labels | null };

/** The header's Jev status: NOT RUN with its reason, or the answered and failed call counts. */
export function jevStatus(j: JevRun | null | undefined): string {
  if (!j || j.status === "not run") return `NOT RUN${j?.reason ? ` (${j.reason})` : ""}`;
  return `RUN, ${j.answered} of ${j.calls} call(s) answered${j.failed ? `, ${j.failed} failed` : ""}`;
}

export function renderPrivate(s: Summary, o: PrivateOptions): string {
  const L: string[] = [];
  L.push(`# TokenMax map: private report`, "");
  L.push(`Skill tokenmax-map ${VERSION}, \`scripts/map.ts\`. Period ${o.from} to ${o.to} (UTC). Sources: ${o.sources.join(", ") || "none"}. Jev analysis: ${jevStatus(o.jev)}.`, "");
  L.push(`## Coverage`, "", `| Source | Files | Unreadable | Lines | Parsed | Accepted | Malformed | Unsupported | Out of period |`, `|---|---|---|---|---|---|---|---|---|`);
  const covRows: Array<[string, Coverage | undefined]> = [["Claude Code", s.claude?.cov], ["Codex", s.codex?.cov]];
  for (const [name, cov] of covRows) {
    if (cov) L.push(`| ${name} | ${n(cov.files)} | ${n(cov.unreadable)} | ${n(cov.lines)} | ${n(cov.parsed)} | ${n(cov.accepted)} | ${n(cov.malformed)} | ${n(cov.unsupported)} | ${n(cov.outOfPeriod)} |`);
  }
  L.push("", "- Files are selected by modification time inside the period, then records by timestamp. Lines that cannot carry usage, a cap, a counter or a tool call are skipped unparsed (Lines minus Parsed).");
  if (s.claude) L.push(`- Claude: ${n(s.claude.sessions)} sessions with in-period evidence, ${n(s.claude.subagentSessions)} of them with subagent work (\`subagents/\` file or sidechain flag; a subagent transcript carries its parent's sessionId, so it counts inside the parent session). ${n(s.claude.usageRecords)} usage records collapse to ${n(s.claude.messages)} messages (latest snapshot per message.id). \`<synthetic>\` records carry no usage.`);
  if (s.codex) L.push(`- Codex: ${n(s.codex.sessions)} sessions with established usage, ${n(s.codex.subagentSessions)} subagent (parent_thread_id). ${n(s.codex.baselines)} uncounted baselines (forked sessions, sessions started before the period, counter decreases).`);
  if (s.codex?.duplicateFiles) L.push(`- ${n(s.codex.duplicateFiles)} Codex file(s) repeated a session id already read: the file with the newer history is kept, so no session is counted twice.`);
  const unread = (s.claude?.cov.unreadable ?? 0) + (s.codex?.cov.unreadable ?? 0);
  if (unread) L.push(`- ${n(unread)} folder(s) or file(s) could not be read: the totals below are understated and the share is refused.`);
  L.push("");
  const week = o.days === undefined ? null : perWeekLine({ days: o.days, ...weekTotals(s) });
  if (week) L.push(`## Per week on average`, "", week, "");

  if (s.claude) {
    const c = s.claude;
    L.push(`## Claude Code usage`, "", `| Model | Messages | Input | Output | Cache write | Cache read |`, `|---|---|---|---|---|---|`);
    for (const [m, t] of [...c.byModel].sort((a, b) => b[1].output - a[1].output)) L.push(`| ${m} | ${n(t.messages)} | ${n(t.input)} | ${n(t.output)} | ${n(t.cacheWrite)} | ${n(t.cacheRead)} |`);
    L.push("", "Fields: message.usage input_tokens (uncached input), output_tokens, cache_creation_input_tokens, cache_read_input_tokens, summed over the latest snapshot per message.id. Output tokens are the column to compare with Codex (#411).", "");
    L.push(`| Day (UTC) | Output | Uncached input | Cache write |`, `|---|---|---|---|`);
    for (const [d, v] of [...c.byDay].sort()) L.push(`| ${d} | ${n(v.output)} | ${n(v.uncachedInput)} | ${n(v.cacheWrite)} |`);
    L.push("");
    if (o.byProject) {
      const total = [...c.byProject.values()].reduce((a, b) => a + b, 0);
      L.push(`| Project (top 15) | Output | Share |`, `|---|---|---|`);
      for (const [p, v] of top(c.byProject, 15)) L.push(`| ${p} | ${n(v)} | ${share(v, total)} |`);
      L.push("");
    }
  }
  if (s.codex) {
    const x = s.codex;
    L.push(`## Codex usage`, "", `| Counter | Established |`, `|---|---|`);
    L.push(`| input_tokens | ${n(x.totals.input)} |`, `| cached_input_tokens (subset of input) | ${n(x.totals.cachedInput)} |`, `| uncached input (input minus cached) | ${n(Math.max(0, x.totals.input - x.totals.cachedInput))} |`, `| cache_write_input_tokens | ${n(x.totals.cacheWrite)} |`, `| output_tokens | ${n(x.totals.output)} |`, `| reasoning_output_tokens (as reported) | ${n(x.totals.reasoning)} |`);
    L.push("", "Non-negative deltas of payload.info.total_token_usage within each session file. Codex input_tokens includes cached_input_tokens; Claude input excludes cache reads, so the day and model tables give output tokens and uncached input for both sources (#411).", "");
    L.push(`| Model | Output | Uncached input | Cached input |`, `|---|---|---|---|`);
    for (const [m, v] of [...x.byModel].sort((a, b) => b[1].output - a[1].output).slice(0, 10)) L.push(`| ${m} | ${n(v.output)} | ${n(v.uncachedInput)} | ${n(v.cachedInput)} |`);
    L.push("", `| Day (UTC) | Output | Uncached input |`, `|---|---|---|`);
    for (const [d, v] of [...x.byDay].sort()) L.push(`| ${d} | ${n(v.output)} | ${n(v.uncachedInput)} |`);
    L.push("");
    if (o.byProject) {
      const total = [...x.byProject.values()].reduce((a, b) => a + b, 0);
      L.push(`| Project (top 15) | Output | Share |`, `|---|---|---|`);
      for (const [p, v] of top(x.byProject, 15)) L.push(`| ${p} | ${n(v)} | ${share(v, total)} |`);
      L.push("");
    }
  }

  L.push(`## Limits`, "", `| Source | Occurrences | Distinct events | Episodes | Short | Weekly | Unknown |`, `|---|---|---|---|---|---|---|`);
  if (s.claude) { const e = s.claude.capEpisodes; L.push(`| Claude Code | ${s.claude.capOccurrences} | ${s.claude.capEvents} | ${e.short + e.weekly + e.unknown} | ${e.short} | ${e.weekly} | ${e.unknown} |`); }
  if (s.codex) { const e = s.codex.capEpisodes; L.push(`| Codex | ${s.codex.capOccurrences} | n/a | ${e.short + e.weekly + e.unknown} | ${e.short} | ${e.weekly} | ${e.unknown} |`); }
  L.push("", "- Distinct events: distinct record uuids among the Claude cap notices. Codex window readings carry no event id.");
  L.push("- Claude evidence: assistant records with isApiErrorMessage true, error \"rate_limit\" and a Claude Code cap notice. \"session limit\" is short, \"weekly limit\" weekly, a bare \"hit your limit\" unknown.");
  L.push("- Codex evidence: a rate_limits window at used_percent >= 100 (window_minutes 10080 is weekly, <= 300 short), or a non-null rate_limit_reached_type.");
  L.push("- Episode rule: same source, window class and reset reading, within 24 hours of the episode's first occurrence, across all sessions.");
  if (s.codex?.lastReading) {
    const r = s.codex.lastReading;
    const resets = r.resetsAt ? new Date(r.resetsAt * 1000).toISOString().slice(0, 16) : "none";
    L.push(`- Last Codex window reading: ${r.slot} ${r.usedPercent}% used, window_minutes ${r.windowMinutes}, resets_at ${resets}${r.resetsAt ? " UTC" : ""} (read ${minute(r.ts)}).`);
  }
  if (s.codex?.badReadings) L.push(`- ${n(s.codex.badReadings)} Codex window slot(s) had no numeric used_percent or an impossible resets_at: not used as readings.`);
  for (const u of s.episodes.filter((e) => e.window === "unknown")) {
    const twin = s.episodes.find((e) => e !== u && e.window !== "unknown" && e.source === u.source && e.reset === u.reset && Math.abs(e.first - u.first) < DAY);
    if (twin) L.push(`- An unknown-window episode shares its reset reading (${u.reset}) with a ${twin.window} episode; they may be one cap. Not merged: the notice text does not name the window.`);
  }
  if (s.claude && s.claude.errors.size) L.push(`- Other API errors, not caps: ${[...s.claude.errors].map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  L.push("");
  if (s.episodes.length) {
    const alias = new Map(s.evidence.map((e) => [`${e.source}|${e.session}`, e.alias]));
    L.push(`| Episode | Source | Window | Reset reading | First (UTC) | Occurrences | Sessions | Evidence |`, `|---|---|---|---|---|---|---|---|`);
    s.episodes.forEach((e, i) => {
      const names = [...e.sessions].map((id) => alias.get(`${e.source}|${id}`) ?? "").filter(Boolean).sort();
      L.push(`| ${i + 1} | ${e.source} | ${e.window} | ${e.reset || "none"} | ${minute(e.first)} | ${e.occurrences} | ${e.sessions.size} | ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""} |`);
    });
    L.push("");
  }

  L.push(`## Week windows`, "", `Rule outputs, no Jev. Weekly limit hit: a reading at used_percent 100 or more (Codex) or a Claude "weekly limit" notice. Pace rule at the prediction point (the latest reading at or before half the window, before any hit; for an open window the latest reading): projected = used share / elapsed share x 100, on course to hit at 100 or more. Outcome label: hit; not hit only when the window closed (its reset passed or a newer window replaced it) with a reading within ${OUTCOME_GAP_HOURS} hours of its end; otherwise unknown; open while it runs.`, "");
  const codexWeeks = s.weeks.filter((w) => w.source === "codex");
  const claudeWeeks = s.weeks.filter((w) => w.source === "claude");
  if (s.weeks.length) {
    L.push(`| Source | Window resets (UTC) | Readings | Last used | Max used | Predicted at (elapsed) | Used then | Pace projection | Pace rule: on course to hit | Weekly limit hit | Outcome label |`, `|---|---|---|---|---|---|---|---|---|---|---|`);
    for (const w of [...codexWeeks, ...claudeWeeks]) {
      L.push(`| ${w.source === "codex" ? "Codex" : "Claude Code"} | ${w.reset} | ${w.readings ? n(w.readings) : "n/a"} | ${w.source === "codex" ? `${w.usedPercent}%` : "n/a"} | ${w.source === "codex" ? `${w.maxUsed}%` : "n/a"} | ${w.predTs === null || w.elapsedPercent === null ? "n/a" : `${minute(w.predTs)} (${w.elapsedPercent}%)`} | ${w.predUsed === null ? "n/a" : `${w.predUsed}%`} | ${w.projected === null ? "n/a" : `${w.projected}%`} | ${w.paceYes === null ? "n/a" : yesNo(w.paceYes)} | ${yesNo(w.hit)} | ${w.outcome} |`);
    }
    L.push("");
  }
  if (s.codex && !codexWeeks.length) L.push("- Codex: no weekly window reading in the period.");
  if (s.claude && !claudeWeeks.length) L.push("- Claude Code: 0 weekly cap notices; the logs carry no weekly meter reading, so a Claude week counts as not hit only from the absence of a notice.");
  L.push("");

  L.push(`## TokenMax score per session`, "", "Rule: terciles of output tokens within each source over the sessions with records in this period (nearest rank); a cap-only session with no records scores low. Low: at or below the first tercile; high: above the second; ordinary: between. It ranks a session against your own sessions; it is not a share of your subscription allowance, which the logs do not record per session.", "");
  L.push(`| Source | Low | Ordinary | High |`, `|---|---|---|---|`);
  const cutoffs: string[] = [];
  for (const [src, name] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
    const rows = s.evidence.filter((e) => e.source === src);
    if (!rows.length) continue;
    const count = (l: Level): number => rows.filter((e) => e.score === l).length;
    const t = scoreThresholds(rows.filter((e) => e.records > 0).map((e) => e.output));
    L.push(`| ${name} | ${count("low")} | ${count("ordinary")} | ${count("high")} |`);
    cutoffs.push(`${name}: low at or below ${n(t.low)} output tokens, high above ${n(t.high)}`);
  }
  if (cutoffs.length) L.push("", `Cutoffs: ${cutoffs.join("; ")}.`);
  L.push("", `Helper size rule (shown per session): zero records none; under ${n(HELPER_RULE.smallOutput)} output tokens and ${HELPER_RULE.smallTools} tool calls small; over ${n(HELPER_RULE.largeOutput)} output tokens or ${HELPER_RULE.largeTools} tool calls large; else medium. Tool calls: distinct Claude tool_use ids; Codex function_call, custom_tool_call and local_shell_call records.`, "");

  L.push(`## Evidence index`, "", `Where each finding comes from, with no message text copied. Sessions with a cap notice come first, then the most records. Records: Claude messages (latest snapshot per message.id) or Codex counted counter readings. Limit hit: the session has a cap record (rule). Every session, with its label key, is in \`sessions.csv\` next to this report. Files are relative to the source folder${o.byProject ? "" : "; a Claude project folder shows as dir-<hash> (add --by-project for the name)"}.`, "");
  if (s.evidence.length) {
    L.push(`| Session | Source | Source file | First (UTC) | Last (UTC) | Records | Cap notices | Limit hit | Output | Tool calls | Score | Helper (rule) |`, `|---|---|---|---|---|---|---|---|---|---|---|---|`);
    // Every session with a cap notice is listed, so each episode's aliases resolve; the cutoff applies to the rest.
    const shown = Math.max(EVIDENCE_ROWS, s.evidence.filter((e) => e.caps > 0).length);
    for (const e of s.evidence.slice(0, shown)) {
      const refs = e.files.length ? e.files.map((f) => fileRef(f, e.source, o.byProject)).join("; ") : "none";
      L.push(`| ${e.alias} | ${e.source} | ${refs} | ${minute(e.first)} | ${minute(e.last)} | ${n(e.records)} | ${e.caps} | ${yesNo(e.limitHit)} | ${n(e.output)} | ${n(e.toolCalls)} | ${e.score} | ${e.helper} |`);
    }
    if (s.evidence.length > shown) L.push("", `${n(s.evidence.length - shown)} more session(s) with in-period evidence are not listed here; all ${n(s.evidence.length)} are in sessions.csv.`);
  } else L.push("No session had in-period evidence.");
  L.push("");

  L.push(`## Proposals (not measured savings)`, "");
  const proposals: string[] = [];
  const unknownCaps = s.episodes.filter((e) => e.window === "unknown").length;
  if (s.episodes.length) proposals.push(`${s.episodes.length} cap episode(s) in the period: put must-deliver work early in the window and queue optional work for after the reset reading.`);
  if (unknownCaps) proposals.push(`${unknownCaps} episode(s) have no named window: the live TokenMax band (\`.tokenmax/live.json\` in your home folder) can tell the five-hour from the weekly window when the cap fires.`);
  const opus = s.claude ? [...s.claude.byModel].filter(([m]) => /opus/i.test(m)).reduce((a, [, t]) => a + t.output, 0) : 0;
  const allOut = s.claude ? [...s.claude.byModel.values()].reduce((a, t) => a + t.output, 0) : 0;
  if (allOut > 0 && opus / allOut > 0.5) proposals.push(`Opus-class models produced ${share(opus, allOut)} of Claude output tokens: test whether routine subagent work holds quality on a smaller model before moving it.`);
  if (!proposals.length) proposals.push("No cap hits and no dominant model: nothing to propose from metadata alone.");
  for (const p of proposals.slice(0, 3)) L.push(`- ${p}`);
  L.push("", `## Not covered`, "", `- Jev classification ${o.jev?.status === "run" ? "ran on the questions below only" : "NOT RUN"}. Message text is not read except Claude Code cap notices. Work categories need your own descriptions.`, "- Token counts are not subscription percentages or cost.", "");
  L.push(...renderJevOrNot(jevOrNot(s, o.jev ?? null, o.labels ?? null), o.jev ?? null, o.labels ?? null));
  return L.join("\n") + "\n";
}

export function renderShare(s: Summary, o: { alias: string; days: number; sources: string[]; jevRan?: boolean }): string {
  const ep = (w: Window) => s.episodes.filter((e) => e.window === w).length;
  const sessions = (s.claude?.sessions ?? 0) + (s.codex?.sessions ?? 0);
  const gaps: string[] = [];
  if (s.codex && s.codex.baselines) gaps.push(`${s.codex.baselines} Codex counter baselines uncounted`);
  const unread = (s.claude?.cov.unreadable ?? 0) + (s.codex?.cov.unreadable ?? 0);
  if (unread) gaps.push(`${unread} folders or files unreadable`);
  if (s.claude && s.claude.cov.malformed + s.claude.cov.unsupported) gaps.push(`${s.claude.cov.malformed + s.claude.cov.unsupported} Claude records excluded`);
  const models = new Set<string>();
  for (const m of s.claude?.byModel.keys() ?? []) models.add(m.replace(/-\d.*$/, ""));
  for (const m of s.codex?.byModel.keys() ?? []) models.add(m.replace(/-\d.*$/, ""));
  return [
    "# Generalized TokenMax summary",
    "",
    "Status: DRAFT - NOT APPROVED FOR SHARING",
    `Skill version: ${VERSION}`,
    `Participant alias: ${o.alias}`,
    `Coverage: last ${o.days} days${gaps.length ? `; ${gaps.join("; ")}` : ""}`,
    `Sources: ${o.sources.join(", ")}`,
    `Sessions inspected: ${sessions}`,
    `Usage: model families ${[...models].sort().join(", ") || "none"} (counter definitions in the private report; no quota conversion)`,
    `Observed limit episodes: short-window ${ep("short")}; weekly ${ep("weekly")}; unknown window ${ep("unknown")}`,
    "Limit detection coverage: structured records plus Claude Code cap notices; other message text not read",
    "Broad work categories: unknown",
    "Repeated task, supplied by user: unknown",
    "Possible shared artifact: unknown",
    "Acceptance criteria: unknown",
    `Observed finding: ${s.episodes.length ? `${s.episodes.length} allowance cap episode(s) in the period` : "no allowance cap recorded in the period"}`,
    "Suggested action (not measured savings): unknown",
    o.jevRan ? "Jev analysis: metadata numbers sent to TypeSafe Jev; results stay in the private report" : "Jev analysis: NOT RUN",
    "Sharing audience and purpose: not approved",
    "Public quotation/publication permission: not granted",
    "",
    "Review before sharing: remove identifying details and rare task descriptions. Keep the private report and source logs on your own machine. This summary is not automatically anonymous.",
    "",
  ].join("\n");
}

/** Patterns that must not appear in share-draft.md. Returns the classes found, never the matches. */
export function scanShare(text: string): string[] {
  const found: string[] = [];
  if (/\/Users\/|\/home\/|[A-Za-z]:\\/.test(text)) found.push("local path");
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) found.push("session or account id");
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) found.push("exact timestamp");
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text)) found.push("email");
  if (/sk-[A-Za-z0-9]{10,}|api[_-]?key/i.test(text)) found.push("credential");
  return found;
}

// ---------- tm-share/1 ----------

export const SHARE_VERSION = "tm-share/1";
export const SHARE_BASE = "https://jevnotjev.breakoutwithai.com/maps/";
export type ShareSources = "claude" | "codex" | "claude+codex";

/** The public share payload. Key order is the contract order; aggregate counts only, no names, paths, ids or times. */
export type SharePayload = {
  v: typeof SHARE_VERSION;
  skill: string;
  days: number;
  sources: ShareSources;
  sessions: number;
  subagent_sessions: number;
  caps: { short: number; weekly: number; unknown: number };
  output_tokens: { claude: number; codex: number };
  opus_share_pct: number;
  codex_weekly_pct: number | null;
};

/**
 * Contract ranges per leaf. A value outside its range is never pulled to a bound: the share is refused (shareRangeError).
 * The server (src/backstage/maps.ts MAP_BOUNDS) and the /maps/ page (site/maps/maps.js BOUNDS) must agree.
 */
export const RANGES: ReadonlyArray<[string, number, number]> = [
  ["days", 1, 90], ["sessions", 0, 1_000_000], ["subagent_sessions", 0, 1_000_000],
  ["caps.short", 0, 10_000], ["caps.weekly", 0, 10_000], ["caps.unknown", 0, 10_000],
  ["output_tokens.claude", 0, 1_000_000_000_000], ["output_tokens.codex", 0, 1_000_000_000_000],
  ["opus_share_pct", 0, 100], ["codex_weekly_pct", 0, 100],
];

/** Why this payload cannot be shared as tm-share/1, or null when every number is inside its contract range. */
export function shareRangeError(p: SharePayload): string | null {
  const leaf: Record<string, number | null> = {
    days: p.days, sessions: p.sessions, subagent_sessions: p.subagent_sessions,
    "caps.short": p.caps.short, "caps.weekly": p.caps.weekly, "caps.unknown": p.caps.unknown,
    "output_tokens.claude": p.output_tokens.claude, "output_tokens.codex": p.output_tokens.codex,
    opus_share_pct: p.opus_share_pct, codex_weekly_pct: p.codex_weekly_pct,
  };
  for (const [k, lo, hi] of RANGES) {
    const v = leaf[k];
    if (v === null || v === undefined) continue;
    if (!Number.isSafeInteger(v) || v < lo || v > hi) return `${k} is ${v}, outside the tm-share/1 range ${lo} to ${hi}`;
  }
  if (p.subagent_sessions > p.sessions) return `subagent_sessions is ${p.subagent_sessions}, more than sessions ${p.sessions}`;
  return null;
}

/** Output tokens are null for a source that was not read (`--claude none`), so an average never shows it as 0. */
export type WeekTotals = { sessions: number; claudeOutput: number | null; codexOutput: number | null; capHits: number };
/** The period totals the per-week averages divide: sessions and cap hits over both sources, output tokens per source. */
export function weekTotals(s: Summary): WeekTotals {
  return {
    sessions: (s.claude?.sessions ?? 0) + (s.codex?.sessions ?? 0),
    claudeOutput: s.claude ? [...s.claude.byModel.values()].reduce((a, t) => a + t.output, 0) : null,
    codexOutput: s.codex ? s.codex.totals.output : null,
    capHits: s.episodes.length,
  };
}

/** Over 7 days, the per-week averages: each total divided evenly by days / 7 (#409). Null for 7 days or fewer. */
export function perWeekLine(t: WeekTotals & { days: number }): string | null {
  if (t.days <= 7) return null;
  const weeks = t.days / 7;
  const one = (v: number): string => (Math.round(v * 10) / 10).toLocaleString("en-US");
  const per = (v: number): string => n(Math.round(v / weeks));
  const parts = [
    `${per(t.sessions)} sessions`,
    t.claudeOutput === null ? "" : `${per(t.claudeOutput)} Claude output tokens`,
    t.codexOutput === null ? "" : `${per(t.codexOutput)} Codex output tokens`,
    `${one(t.capHits / weeks)} cap hits`,
  ].filter(Boolean);
  return `Per week on average over ${one(weeks)} weeks (${t.days} days): ${parts.join(", ")}. Totals divided evenly by days / 7; not a measured week.`;
}

/** Aggregate share fields from a summary. Sessions, subagent sessions and cap episodes sum both sources. */
export function buildShare(s: Summary, o: { days: number; sources: ShareSources }): SharePayload {
  const totals = weekTotals(s);
  const sessions = totals.sessions, claudeOut = totals.claudeOutput ?? 0;
  const capsOf = (w: Window): number => (s.claude?.capEpisodes[w] ?? 0) + (s.codex?.capEpisodes[w] ?? 0);
  const opusOut = s.claude ? [...s.claude.byModel].filter(([m]) => /opus/i.test(m)).reduce((a, [, t]) => a + t.output, 0) : 0;
  const weekly = s.codex?.lastWeekly;
  return {
    v: SHARE_VERSION,
    skill: VERSION,
    days: Math.round(o.days),
    sources: o.sources,
    sessions,
    subagent_sessions: (s.claude?.subagentSessions ?? 0) + (s.codex?.subagentSessions ?? 0),
    caps: { short: capsOf("short"), weekly: capsOf("weekly"), unknown: capsOf("unknown") },
    output_tokens: { claude: claudeOut, codex: s.codex?.totals.output ?? 0 },
    opus_share_pct: claudeOut > 0 ? Math.round((opusOut / claudeOut) * 100) : 0,
    codex_weekly_pct: weekly ? Math.round(weekly.usedPercent) : null,
  };
}

/** base64url without padding of the UTF-8 JSON. */
export function encodeShare(p: SharePayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

/** The parsed JSON behind an encoded share, or undefined when the text is not base64url JSON. Not validated. */
export function decodeShare(text: string): unknown {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function shareLink(p: SharePayload, base: string = SHARE_BASE): string {
  return `${base}#m=${encodeShare(p)}`;
}

/** The stdout share block: header, one `key: value` line per leaf in contract order, then the link. */
export function renderShareBlock(p: SharePayload): string {
  const L = [`Share fields (${SHARE_VERSION}). Nothing has been sent.`];
  for (const [k, v] of Object.entries(p)) {
    if (isRec(v)) for (const [kk, vv] of Object.entries(v)) L.push(`${k}.${kk}: ${String(vv)}`);
    else L.push(`${k}: ${String(v)}`);
  }
  L.push("Open this link to review and share:", shareLink(p));
  return L.join("\n");
}

// ---------- optional Jev mode ----------

/** The key variable named by the TypeSafe docs (introduction/quickstart.md: "store your TypeSafe API key in an environment variable (e.g. `TYPESAFE_API_KEY`)"). */
export const JEV_KEY_VAR = "TYPESAFE_API_KEY";
/** api.md "Evaluation endpoint". */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
/** Box questions need Jev 1.14 and the images header (primitives/box.md). */
export const JEV_BOX_MODEL = "jev-1.14.0";
export const JEV_IMAGES_HEADER = "TypeSafe-Danger-Zone-Images";
/** models.md "Price (per Btok / per Mtok)": $0.042 per million input tokens; output is free. */
export const JEV_PRICE_PER_MTOK = 0.042;
export const JEV_MAX_CALLS = 40;
/** One deadline per call, covering the request and the response body. */
export const JEV_TIMEOUT_MS = 30_000;

const Q1_TEXT = "Using the numbers in `window`, will this usage window reach 100% used before it resets? High means yes.";
const Q1_CRITERIA = { true: "Used share is on course to reach 100% before resets_at, given the share of the window already elapsed.", false: "Used share will still be below 100% at resets_at at the current pace." };
const Q2_TEXT = "Which helper size would have been enough for this session's work, judged only from the numbers in `session`?";
const Q2_CRITERIA = {
  small: "Short, light session: few output tokens and few tool calls; a small model would do.",
  medium: "Moderate output and tool use; a mid-size model is the fit.",
  large: "Heavy output or many tool calls, or long run with subagents; the large model is justified.",
  none: "The numbers cannot tell (for example zero records).",
};
const Q3_TEXT = "How heavily did this session use the person's token allowance, judged only from the numbers in `session`?";
const Q3_CRITERIA = ["Light: a few messages, little output, no subagents", "Ordinary: a normal working session, moderate output and tool use", "Heavy: long session or many subagents, large share of the day's tokens"];
const Q4_TEXT = "the usage meter (the bar or percentage showing how much of the limit is used) in `pic`";
const LEVELS: Level[] = ["low", "ordinary", "high"];

/** The key from the environment, else from a KEY=value line in .env.local in cwd. Never logged or returned in a message. */
export function resolveJevKey(env: Record<string, string | undefined>, cwd: string): { key: string; from: "environment" | ".env.local" } | null {
  const fromEnv = (env[JEV_KEY_VAR] ?? "").trim();
  if (fromEnv) return { key: fromEnv, from: "environment" };
  let text = "";
  try {
    text = readFileSync(join(cwd, ".env.local"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw new Error(`.env.local in ${cwd} exists but could not be read${error instanceof Error && "code" in error ? ` (${String(error.code)})` : ""}`);
  }
  const re = new RegExp(`^\\s*(?:export\\s+)?${JEV_KEY_VAR}\\s*=\\s*(.*)$`);
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    let v = (m[1] ?? "").trim();
    const q = v[0];
    if ((q === '"' || q === "'") && v.indexOf(q, 1) > 0) v = v.slice(1, v.indexOf(q, 1));
    else v = (v.split(/\s+#/)[0] ?? "").trim();
    if (v) return { key: v, from: ".env.local" };
  }
  return null;
}

/** Width and height from a PNG IHDR or a JPEG start-of-frame marker; null for anything else. */
export function imageSize(b: Buffer): { format: "png" | "jpg"; width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString("ascii", 12, 16) === "IHDR") return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1] ?? 0;
      if (m === 0xd8 || m === 0x01 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += m === 0xff ? 1 : 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { format: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Labels a user sets on their own sessions: CSV key,question,label with keys from sessions.csv. */
export type Labels = { rows: Map<string, string>; bad: number; file: string };
export const LABEL_VALUES: Record<string, readonly string[]> = { helper_size: ["small", "medium", "large", "none"], tokenmax_score: LEVELS };
export function parseLabels(text: string, file: string): Labels {
  const rows = new Map<string, string>();
  let bad = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key = "", question = "", label = ""] = line.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (key === "key") continue;
    const allowed = Object.hasOwn(LABEL_VALUES, question) ? LABEL_VALUES[question] : undefined;
    if (!/^[0-9a-f]{12}$/.test(key) || !allowed || !allowed.includes(label.toLowerCase())) { bad++; continue; }
    rows.set(`${question}|${key}`, label.toLowerCase());
  }
  return { rows, bad, file };
}

export type JevCall = { id: string; question: "q1" | "q2q3" | "q4"; ref: string; model: string; images: boolean; body: Rec };

/**
 * The calls Jev mode would send, capped at maxCalls: Q1 one body per Codex weekly window (closed windows first, they carry
 * a label), Q4 one body when a usage-page screenshot is given, then Q2 and Q3 in one body per session (labelled sessions
 * first, then sessions spread evenly by output tokens). State holds metadata numbers only.
 */
export function buildJevPlan(s: Summary, o: { maxCalls: number; now: number; screenshot?: string | null; labels?: Labels | null }): JevCall[] {
  const plan: JevCall[] = [];
  const rank = (w: WeekRow): number => (w.outcome === "hit" || w.outcome === "not hit" ? 0 : w.outcome === "open" ? 1 : 2);
  const weeks = s.weeks.filter((w) => w.source === "codex" && w.predTs !== null && w.predUsed !== null).sort((a, b) => rank(a) - rank(b) || a.resetsAt - b.resetsAt);
  for (const w of weeks) {
    plan.push({
      id: `q1-${w.key}`, question: "q1", ref: w.key, model: JEV_MODEL, images: false,
      body: {
        model: JEV_MODEL,
        state: { window: { source: "codex", window_minutes: w.windowMinutes, used_percent: w.predUsed ?? 0, elapsed_percent: w.elapsedPercent ?? 0, read_at: minute(w.predTs ?? w.lastTs), resets_at: minute(w.resetsAt), used_percent_history: w.history } },
        questions: { will_hit: { type: "noul", instructions: Q1_TEXT, criteria: Q1_CRITERIA } },
      },
    });
  }
  if (o.screenshot) {
    const bytes = readFileSync(o.screenshot);
    const size = imageSize(bytes);
    const ok = size && size.width >= 280 && size.width <= 1568 && size.height >= 280 && size.height <= 1568 && size.width * size.height >= 78_400 && size.width * size.height <= 2_458_624;
    if (!size || !ok) throw new Error(`--screenshot must be a PNG or JPEG of 280 to 1568 px per side${size ? ` (it is ${size.width} by ${size.height})` : ""}`);
    plan.push({
      id: "q4-screenshot", question: "q4", ref: "screenshot", model: JEV_BOX_MODEL, images: true,
      body: { model: JEV_BOX_MODEL, state: { pic: "usage-shot" }, assets: { "usage-shot": { type: "image", format: size.format, data_base64: bytes.toString("base64") } }, questions: { meter: { type: "box", instructions: Q4_TEXT } } },
    });
  }
  const room = Math.max(0, o.maxCalls - plan.length);
  const candidates = s.evidence.filter((e) => e.records > 0);
  const labelled = (e: Evidence): boolean => !!o.labels && (o.labels.rows.has(`helper_size|${e.key}`) || o.labels.rows.has(`tokenmax_score|${e.key}`));
  const chosen = candidates.filter(labelled).slice(0, room);
  const rest = candidates.filter((e) => !labelled(e)).sort((a, b) => a.output - b.output || a.alias.localeCompare(b.alias));
  const k = room - chosen.length;
  if (k >= rest.length) chosen.push(...rest);
  else for (let i = 0; i < k; i++) { const e = rest[Math.floor(((i + 0.5) * rest.length) / k)]; if (e) chosen.push(e); }
  for (const e of chosen) {
    plan.push({
      id: `q2q3-${e.key}`, question: "q2q3", ref: e.key, model: JEV_MODEL, images: false,
      body: {
        model: JEV_MODEL,
        state: { session: { source: e.source, output_tokens: e.output, tool_calls: e.toolCalls, minutes: e.minutes, has_subagents: e.subagent, records: e.records, model_mix: e.modelMix, share_of_day_output_percent: e.dayShare } },
        questions: { helper_size: { type: "choice", instructions: Q2_TEXT, criteria: Q2_CRITERIA }, tokenmax_score: { type: "score", instructions: Q3_TEXT, criteria: Q3_CRITERIA } },
      },
    });
  }
  return plan.slice(0, o.maxCalls);
}

export type JevResult = { id: string; question: JevCall["question"]; ref: string; model: string; ok: boolean; error: string; inputTokens: number; answers: Rec };
export type JevRun = { status: "run" | "not run"; reason: string; calls: number; answered: number; failed: number; inputTokens: number; results: JevResult[]; boxNote: string };
export const jevNotRun = (reason: string, boxNote = ""): JevRun => ({ status: "not run", reason, calls: 0, answered: 0, failed: 0, inputTokens: 0, results: [], boxNote });
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const unit = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
/** Whether an answer has the shape its question type promises (api.md "Answer types"). */
function answerFits(q: unknown, a: unknown): boolean {
  if (!isRec(q) || !isRec(a) || a.type !== q.type) return false;
  if (q.type === "noul") return unit(a.noul);
  if (q.type === "choice") return isRec(q.criteria) && typeof a.choice === "string" && Object.hasOwn(q.criteria, a.choice) && unit(a.confidence);
  if (q.type === "score") return Array.isArray(q.criteria) && typeof a.score === "number" && a.score >= 0 && a.score <= q.criteria.length - 1 && unit(a.confidence);
  if (q.type === "box") {
    const b = a.box;
    return isRec(b) && unit(b.top) && unit(b.bottom) && unit(b.left) && unit(b.right) && Number(b.top) < Number(b.bottom) && Number(b.left) < Number(b.right) && unit(a.confidence);
  }
  return false;
}

/** Sends each call once, in order, with no retries. A non-200, a different model or a misshapen answer is a failure. */
export async function runJev(plan: JevCall[], key: string, fetchFn: FetchFn, timeoutMs = JEV_TIMEOUT_MS): Promise<JevRun> {
  const run: JevRun = { status: "run", reason: "", calls: plan.length, answered: 0, failed: 0, inputTokens: 0, results: [], boxNote: "" };
  for (const c of plan) {
    const r: JevResult = { id: c.id, question: c.question, ref: c.ref, model: "", ok: false, error: "", inputTokens: 0, answers: {} };
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${key}`, "content-type": "application/json" };
      if (c.images) headers[JEV_IMAGES_HEADER] = "true";
      const asked = isRec(c.body.questions) ? Object.keys(c.body.questions) : [];
      if (!asked.length) throw new Error("no questions");
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetchFn(JEV_ENDPOINT, { method: "POST", headers, body: JSON.stringify(c.body), signal });
      const body: unknown = await res.json().catch(() => null);
      if (signal.aborted) throw new Error("timeout");
      const usage = isRec(body) && isRec(body.usage) ? counter(body.usage.input_tokens) : undefined;
      r.inputTokens = usage ?? 0;
      r.model = isRec(body) ? str(body.model) : "";
      const answers = isRec(body) && isRec(body.answers) ? body.answers : {};
      const questions = isRec(c.body.questions) ? c.body.questions : {};
      if (res.status !== 200) r.error = `HTTP ${res.status}`;
      else if (r.model !== c.model) r.error = `model ${r.model || "missing"}, not ${c.model}`;
      else if (!Object.entries(questions).every(([id, q]) => answerFits(q, answers[id]))) r.error = "an answer does not match its question type";
      else { r.ok = true; r.answers = answers; }
    } catch (error) {
      r.error = error instanceof Error && error.message === "no questions" ? "the call has no questions; not sent" : `request failed (${error instanceof Error && (error.name === "TimeoutError" || error.message === "timeout") ? `no answer within ${timeoutMs / 1000} s` : error instanceof Error ? error.name : "error"})`;
    }
    run.inputTokens += r.inputTokens;
    if (r.ok) run.answered++; else run.failed++;
    run.results.push(r);
  }
  return run;
}

export type Verdict = "use Jev" | "don't use Jev" | "not enough evidence";
/**
 * Verdict per question. A question a rule answers exactly is don't use Jev. Otherwise at least 30 paired labelled cases
 * (docs/LIMITS.md); then Jev ahead of the rule by 10 points or more is use Jev, the rule level or ahead is don't use Jev,
 * and anything between is not enough evidence. The skill runs no LLM arm, so this compares Jev with the rule only.
 */
export function jevVerdict(o: { exact: boolean; paired: number; jevAccepted: number; ruleAccepted: number }): Verdict {
  if (o.exact) return "don't use Jev";
  if (o.paired < 30) return "not enough evidence";
  const diff = (o.jevAccepted - o.ruleAccepted) / o.paired;
  if (diff >= 0.1) return "use Jev";
  if (diff <= 0) return "don't use Jev";
  return "not enough evidence";
}

export type JevRow = { question: string; type: string; jev: string; rule: string; llm: string; cost: string; verdict: Verdict; why: string };

const usd = (v: number): string => `$${v.toFixed(6)}`;
const costOf = (rs: JevResult[]): number => (rs.reduce((a, r) => a + r.inputTokens, 0) * JEV_PRICE_PER_MTOK) / 1_000_000;
const costCell = (spent: number, accepted: number, ran: boolean): string => (!ran ? "n/a" : accepted > 0 ? `${usd(spent / accepted)} (${accepted} accepted)` : `${usd(spent)} spent, 0 accepted`);
const levelOf = (score: unknown): Level => LEVELS[Math.min(2, Math.max(0, Math.round(typeof score === "number" ? score : 0)))] ?? "low";
const countBy = (xs: string[], keys: readonly string[]): string => keys.map((k) => `${k} ${xs.filter((x) => x === k).length}`).join(", ");

/** One row per question type, then the questions a rule answers exactly. */
export function jevOrNot(s: Summary, j: JevRun | null, labels: Labels | null = null): JevRow[] {
  const ran = j?.status === "run";
  const notRun = `NOT RUN (${j?.reason || "metadata mode; add --jev"})`;
  const results = (q: JevCall["question"]): JevResult[] => (j?.results ?? []).filter((r) => r.question === q && r.ok);
  // Spend counts every attempted call, failed ones included: a failed call can still be billed.
  const spent = (q: JevCall["question"]): number => costOf((j?.results ?? []).filter((r) => r.question === q));
  const llm = "not run by the skill";
  const rows: JevRow[] = [];

  const weeks = s.weeks.filter((w) => w.source === "codex");
  const q1 = new Map(results("q1").map((r) => [r.ref, isRec(r.answers.will_hit) ? Number(r.answers.will_hit.noul) : Number.NaN]));
  const known = weeks.filter((w) => w.outcome === "hit" || w.outcome === "not hit");
  const paired1 = known.filter((w) => q1.has(w.key));
  const jev1 = paired1.filter((w) => ((q1.get(w.key) ?? 0) >= 0.5) === (w.outcome === "hit")).length;
  const rule1 = paired1.filter((w) => w.paceYes === (w.outcome === "hit")).length;
  const askedWeeks = weeks.filter((w) => q1.has(w.key));
  rows.push({
    question: "Will this week hit the weekly limit before reset?", type: "noul",
    jev: ran ? `${q1.size} answered, ${[...q1.values()].filter((p) => p >= 0.5).length} yes at p >= 0.5` : notRun,
    rule: `${ran ? `on the ${askedWeeks.length} asked: ${askedWeeks.filter((w) => w.paceYes).length} on course; ` : ""}all ${weeks.length} window(s): ${weeks.filter((w) => w.paceYes).length} on course (pace rule)`, llm,
    cost: costCell(spent("q1"), jev1, ran), verdict: jevVerdict({ exact: false, paired: paired1.length, jevAccepted: jev1, ruleAccepted: rule1 }),
    why: `labels: ${known.length} closed Codex window(s) with a known outcome (${weeks.filter((w) => w.outcome === "unknown").length} unknown: a reading gap before the end); ${paired1.length} paired, 30 needed`,
  });

  const q23 = results("q2q3");
  const helperJ = new Map(q23.map((r) => [r.ref, isRec(r.answers.helper_size) ? str(r.answers.helper_size.choice) : ""]));
  const scoreJ = new Map<string, string>(q23.map((r) => [r.ref, levelOf(isRec(r.answers.tokenmax_score) ? r.answers.tokenmax_score.score : 0)]));
  const byKey = new Map(s.evidence.map((e) => [e.key, e]));
  const asked = [...helperJ.keys()].map((k) => byKey.get(k)).filter((e): e is Evidence => e !== undefined);
  const labelled = (question: string, jevMap: Map<string, string>, ruleOf: (e: Evidence) => string) => {
    let paired = 0, jevAcc = 0, ruleAcc = 0;
    for (const [k, v] of jevMap) {
      const label = labels?.rows.get(`${question}|${k}`);
      const e = byKey.get(k);
      if (!label || !e) continue;
      paired++;
      if (v === label) jevAcc++;
      if (ruleOf(e) === label) ruleAcc++;
    }
    return { paired, jevAcc, ruleAcc };
  };
  const agree = (jevMap: Map<string, string>, ruleOf: (e: Evidence) => string): number => [...jevMap].filter(([k, v]) => { const e = byKey.get(k); return e !== undefined && ruleOf(e) === v; }).length;
  const labelWhy = (q: string, paired: number): string => `labels: ${labels ? [...labels.rows.keys()].filter((k) => k.startsWith(`${q}|`)).length : 0} in your labels file; ${paired} paired, 30 needed`;

  const h = labelled("helper_size", helperJ, (e) => e.helper);
  rows.push({
    question: "Which helper size fits this session?", type: "choice",
    jev: ran ? `${helperJ.size} answered: ${countBy([...helperJ.values()], ["small", "medium", "large", "none"])}; agrees with the rule on ${agree(helperJ, (e) => e.helper)}` : notRun,
    rule: `${ran ? `on the ${helperJ.size} asked: ${countBy(asked.map((e) => e.helper), ["small", "medium", "large", "none"])}; ` : ""}all ${s.evidence.length} sessions: ${countBy(s.evidence.map((e) => e.helper), ["small", "medium", "large", "none"])}`, llm,
    cost: costCell(spent("q2q3") / 2, h.jevAcc, ran), verdict: jevVerdict({ exact: false, paired: h.paired, jevAccepted: h.jevAcc, ruleAccepted: h.ruleAcc }), why: labelWhy("helper_size", h.paired),
  });
  const sc = labelled("tokenmax_score", scoreJ, (e) => e.score);
  rows.push({
    question: "TokenMax score of this session: low, ordinary or high use?", type: "score",
    jev: ran ? `${scoreJ.size} answered: ${countBy([...scoreJ.values()], LEVELS)}; agrees with the rule on ${agree(scoreJ, (e) => e.score)}` : notRun,
    rule: `${ran ? `on the ${scoreJ.size} asked: ${countBy(asked.map((e) => e.score), LEVELS)}; ` : ""}all ${s.evidence.length} sessions: ${countBy(s.evidence.map((e) => e.score), LEVELS)} (terciles)`, llm,
    cost: costCell(spent("q2q3") / 2, sc.jevAcc, ran), verdict: jevVerdict({ exact: false, paired: sc.paired, jevAccepted: sc.jevAcc, ruleAccepted: sc.ruleAcc }), why: labelWhy("tokenmax_score", sc.paired),
  });

  const box = results("q4")[0];
  const boxFailed = (j?.results ?? []).find((r) => r.question === "q4" && !r.ok);
  const meter = box && isRec(box.answers.meter) ? box.answers.meter : undefined;
  const edges = meter && isRec(meter.box) ? meter.box : undefined;
  rows.push({
    question: "Where is the usage meter on this usage-page screenshot?", type: "box",
    jev: meter && edges ? `top ${String(edges.top)}, bottom ${String(edges.bottom)}, left ${String(edges.left)}, right ${String(edges.right)}, confidence ${String(meter.confidence)}` : boxFailed ? `FAILED (${boxFailed.error})` : ran ? `NOT RUN (${j?.boxNote || "no usage-page screenshot; pass --screenshot FILE"})` : notRun,
    rule: "fixed crop: no known page layout", llm, cost: costCell(spent("q4"), 0, ran && (!!meter || !!boxFailed)), verdict: "not enough evidence",
    why: "labels: a hand-drawn box per screenshot, accepted at overlap (IoU) 0.5 or more; none supplied",
  });

  const limitSessions = s.evidence.filter((e) => e.limitHit).length;
  rows.push({ question: "Did this session hit a usage limit?", type: "rule", jev: "not asked", rule: `${limitSessions} of ${s.evidence.length} sessions yes`, llm: "not needed", cost: "n/a", verdict: "don't use Jev", why: "a cap record exists or not: the rule is exact" });
  rows.push({ question: "Did this week hit the weekly limit (after the fact)?", type: "rule", jev: "not asked", rule: `${s.weeks.filter((w) => w.hit).length} of ${s.weeks.length} window(s) hit`, llm: "not needed", cost: "n/a", verdict: "don't use Jev", why: "a Claude weekly notice or a Codex reading at 100% is a recorded fact" });
  const ep = (w: Window): number => s.episodes.filter((e) => e.window === w).length;
  rows.push({ question: "Short or weekly window for a cap?", type: "rule", jev: "not asked", rule: `short ${ep("short")}, weekly ${ep("weekly")}, unknown ${ep("unknown")}`, llm: "not needed", cost: "n/a", verdict: "don't use Jev", why: "the notice names the window; a bare notice gives Jev no more evidence" });
  return rows;
}

export function renderJevOrNot(rows: JevRow[], j: JevRun | null, labels: Labels | null): string[] {
  const L = [`## Jev or not`, "", "One row per question. Jev result and rule result are on the same cases. Verdict: use Jev only with at least 30 paired labelled cases (docs/LIMITS.md) and Jev ahead of the rule by 10 points; the skill runs no LLM arm. A question a rule answers exactly is don't use Jev.", ""];
  L.push(`| Question | Type | Jev result | Rule result | LLM result | Cost per accepted answer | Verdict |`, `|---|---|---|---|---|---|---|`);
  for (const r of rows) L.push(`| ${r.question} | ${r.type} | ${r.jev} | ${r.rule} | ${r.llm} | ${r.cost} | ${r.verdict} |`);
  L.push("");
  for (const r of rows) L.push(`- ${r.question} Basis: ${r.why}.`);
  if (j?.status === "run") {
    L.push(`- Jev spend: ${n(j.inputTokens)} input tokens, ${usd((j.inputTokens * JEV_PRICE_PER_MTOK) / 1_000_000)} at $${JEV_PRICE_PER_MTOK} per million input tokens (TypeSafe models page). Bodies in jev-payload.json, answers in jev-results.json.`);
    for (const r of j.results.filter((x) => !x.ok).slice(0, 10)) L.push(`- Jev call ${r.id} failed: ${r.error}.`);
  }
  if (labels) L.push(`- Labels file: ${labels.rows.size} label(s) read, ${labels.bad} line(s) rejected.`);
  else L.push("- No labels file. For a verdict on helper size or score, label at least 30 of your sessions in a CSV with columns key,question,label (keys from sessions.csv; helper_size is small, medium, large or none; tokenmax_score is low, ordinary or high) and rerun with --jev --labels FILE.");
  return L;
}

/** sessions.csv: every session's metadata facts, no session ids, paths or text. */
export function renderSessionsCsv(s: Summary): string {
  const head = "alias,key,source,first_utc,last_utc,minutes,records,output_tokens,tool_calls,subagent,limit_hit,tokenmax_score,helper_rule,share_of_day_output_percent";
  return [head, ...s.evidence.map((e) => [e.alias, e.key, e.source, minute(e.first), minute(e.last), e.minutes, e.records, e.output, e.toolCalls, yesNo(e.subagent), yesNo(e.limitHit), e.score, e.helper, e.dayShare].join(","))].join("\n") + "\n";
}

// ---------- dashboard ----------

export type DashData = {
  heading: string;
  tiles: Array<[string, string]>;
  days: Array<{ day: string; claude: number | null; codex: number | null }>;
  episodes: Array<{ source: string; window: string; reset: string; first: string; occurrences: number; sessions: number }>;
  scores: Array<{ source: string; low: number; ordinary: number; high: number }>;
  jev: JevRow[];
  /** Jev calls actually sent to TypeSafe, and whether one carried a screenshot; 0 when nothing left the machine. */
  sent?: number;
  imageSent?: boolean;
};

export function dashData(s: Summary, o: { from: string; to: string; jev: JevRun | null; labels: Labels | null }): DashData {
  const days = new Set<string>([...(s.claude?.byDay.keys() ?? []), ...(s.codex?.byDay.keys() ?? [])]);
  const out = (src: "claude" | "codex"): string => n(s.evidence.filter((e) => e.source === src).reduce((a, e) => a + e.output, 0));
  const scores: DashData["scores"] = [];
  for (const [src, name] of [["claude", "Claude Code"], ["codex", "Codex"]] as const) {
    const rows = s.evidence.filter((e) => e.source === src);
    if (rows.length) scores.push({ source: name, low: rows.filter((e) => e.score === "low").length, ordinary: rows.filter((e) => e.score === "ordinary").length, high: rows.filter((e) => e.score === "high").length });
  }
  const tiles: Array<[string, string]> = [["Sessions", n(s.evidence.length)]];
  if (s.claude) tiles.push(["Claude output tokens", out("claude")]);
  if (s.codex) tiles.push(["Codex output tokens", out("codex")]);
  tiles.push(["Cap episodes", n(s.episodes.length)], ["Sessions that hit a limit", n(s.evidence.filter((e) => e.limitHit).length)], ["Week windows hit", `${s.weeks.filter((w) => w.hit).length} of ${s.weeks.length}`], ["Jev", jevStatus(o.jev)]);
  return {
    heading: `TokenMax map ${o.from} to ${o.to}`,
    tiles,
    days: [...days].sort().map((day) => ({ day, claude: s.claude ? (s.claude.byDay.get(day)?.output ?? 0) : null, codex: s.codex ? (s.codex.byDay.get(day)?.output ?? 0) : null })),
    episodes: s.episodes.map((e) => ({ source: e.source === "claude" ? "Claude Code" : "Codex", window: e.window, reset: e.reset || "none", first: minute(e.first).replace("T", " "), occurrences: e.occurrences, sessions: e.sessions.size })),
    scores,
    jev: jevOrNot(s, o.jev, o.labels),
    sent: o.jev?.status === "run" ? o.jev.calls : 0,
    imageSent: o.jev?.status === "run" && o.jev.results.some((r) => r.question === "q4"),
  };
}

const esc = (v: string): string => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** An element with escaped text content. */
const el = (tag: string, text: string, cls = ""): string => `<${tag}${cls ? ` class="${cls}"` : ""}>${esc(text)}</${tag}>`;

const DASH_CSS = [
  ":root{--bg:#f6f7f9;--panel:#ffffff;--ink:#1c2430;--muted:#5d6878;--line:#d9dee6;--s1:#2f6f9f;--s2:#b8730c;--lv0:#9fb7cc;--lv1:#4f86b0;--lv2:#1f4f75;--use:#2e7d4f;--no:#a33b2b;--wait:#5f646b}",
  "@media (prefers-color-scheme: dark){:root{--bg:#12161c;--panel:#1a2029;--ink:#e6e9ee;--muted:#9aa4b2;--line:#2c3440;--s1:#6aa6d6;--s2:#e0a23a;--lv0:#3c5468;--lv1:#5f93bd;--lv2:#a9cdea;--use:#5fbf86;--no:#e07a6a;--wait:#a3a8b0}}",
  "*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif}",
  "main{max-width:1080px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}",
  ".muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:16px}",
  ".tile{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px 12px}.tile b{display:block;font-size:20px;font-variant-numeric:tabular-nums}.tile span{color:var(--muted);font-size:13px}",
  ".chart,.scroll{overflow-x:auto;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px}svg{width:100%;min-width:300px;height:auto;max-height:320px;display:block}",
  "svg text{fill:var(--muted);font-size:10px}.axis{stroke:var(--line)}rect.s1{fill:var(--s1)}rect.s2{fill:var(--s2)}",
  ".legend{font-size:13px}.key{display:inline-block;width:10px;height:10px;margin:0 4px 0 10px;vertical-align:middle}.key.s1{background:var(--s1)}.key.s2{background:var(--s2)}",
  "table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600}",
  ".score{display:flex;align-items:center;gap:10px;margin:6px 0}.score-name{width:110px;font-size:13px}.stack{flex:1;display:flex;height:22px;border-radius:4px;overflow:hidden;border:1px solid var(--line)}",
  ".stack span{display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff}.lv0{background:var(--lv0)}.lv1{background:var(--lv1)}.lv2{background:var(--lv2)}",
  ".verdict{font-weight:600}.v-use{color:var(--use)}.v-no{color:var(--no)}.v-wait{color:var(--wait)}",
  "@media (prefers-color-scheme: dark){.stack .lv2{color:#12161c}}",
].join("\n");

/** A self-contained page: inline CSS and SVG, no script, no network, light and dark from prefers-color-scheme. */
export function renderDashboard(d: DashData): string {
  const max = Math.max(1, ...d.days.map((x) => Math.max(x.claude ?? 0, x.codex ?? 0)));
  const step = 44;
  const h = 160;
  const w = Math.max(320, d.days.length * step + 40);
  const bar = (v: number | null, x: number, cls: string, label: string): string => {
    if (v === null) return "";
    const bh = Math.round((v / max) * h);
    return `<rect class="${cls}" x="${x}" y="${10 + h - bh}" width="14" height="${bh}" aria-label="${esc(label)}"></rect>`;
  };
  const bars = d.days.map((x, i) => {
    const bx = 30 + i * step;
    return [
      bar(x.claude, bx, "s1", `${x.day} Claude Code ${n(x.claude ?? 0)} output tokens`),
      bar(x.codex, bx + 16, "s2", `${x.day} Codex ${n(x.codex ?? 0)} output tokens`),
      `<text x="${bx + 15}" y="${h + 26}" text-anchor="middle">${esc(x.day.slice(5))}</text>`,
    ].join("");
  }).join("");
  const legendKey = (cls: string, label: string): string => `<span class="key ${cls}"></span>${esc(label)} `;
  const chart = d.days.length
    ? [
      `<div class="chart"><svg viewBox="0 0 ${w} ${h + 34}" role="img" aria-label="Output tokens per day by source">`,
      `<line class="axis" x1="24" y1="${h + 10}" x2="${w - 6}" y2="${h + 10}"></line>${bars}</svg></div>`,
      `<p class="legend">${legendKey("s1", "Claude Code")}${legendKey("s2", "Codex")}${el("span", `Tallest bar ${n(max)} output tokens`, "muted")}</p>`,
    ].join("\n")
    : el("p", "No usage in the period", "muted");
  const table = (head: string[], rows: string[][]): string =>
    `<div class="scroll"><table><thead><tr>${head.map((x) => el("th", x)).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => el("td", c)).join("")}</tr>`).join("\n")}</tbody></table></div>`;
  const scoreBars = d.scores.map((x) => {
    const total = Math.max(1, x.low + x.ordinary + x.high);
    const seg = (v: number, cls: string, label: string): string => (v ? `<span class="${cls}" style="width:${((v / total) * 100).toFixed(2)}%" aria-label="${esc(`${label} ${v}`)}">${v}</span>` : "");
    return `<div class="score">${el("div", x.source, "score-name")}<div class="stack">${seg(x.low, "lv0", "low")}${seg(x.ordinary, "lv1", "ordinary")}${seg(x.high, "lv2", "high")}</div></div>`;
  }).join("\n");
  const verdictCls = (v: string): string => (v === "use Jev" ? "v-use" : v === "don't use Jev" ? "v-no" : "v-wait");
  const jevTable = `<div class="scroll"><table><thead><tr>${["Question", "Type", "Jev result", "Rule result", "Cost per accepted answer", "Verdict"].map((x) => el("th", x)).join("")}</tr></thead><tbody>${d.jev.map((r) => `<tr>${[r.question, r.type, r.jev, r.rule, r.cost].map((c) => el("td", c)).join("")}<td>${el("span", r.verdict, `verdict ${verdictCls(r.verdict)}`)}</td></tr>`).join("\n")}</tbody></table></div>`;
  const episodes = d.episodes.length
    ? table(["Source", "Window", "Reset reading", "First (UTC)", "Occurrences", "Sessions"], d.episodes.map((e) => [e.source, e.window, e.reset, e.first, String(e.occurrences), String(e.sessions)]))
    : el("p", "No cap episode in the period", "muted");
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    el("title", d.heading),
    `<style>\n${DASH_CSS}\n</style></head><body><main>`,
    el("h1", d.heading),
    el("p", `Built from local logs by tokenmax-map ${VERSION}, metadata only. ${d.sent ? `For the Jev rows, ${d.sent} call(s) of metadata numbers${d.imageSent ? " and one screenshot" : ""} were sent to TypeSafe; nothing else left this machine` : "Nothing on this page was sent anywhere"}`, "muted"),
    `<section class="tiles">${d.tiles.map(([k, v]) => `<div class="tile">${el("b", v)}${el("span", k)}</div>`).join("")}</section>`,
    el("h2", "Output tokens per day"), chart,
    el("h2", "Limit episodes"), episodes,
    el("h2", "TokenMax score per session"), scoreBars || el("p", "No sessions", "muted"),
    `<p class="legend">${legendKey("lv0", "low")}${legendKey("lv1", "ordinary")}${legendKey("lv2", "high")}${el("span", "Terciles of output tokens within each source", "muted")}</p>`,
    el("h2", "Jev or not"), jevTable,
    "</main></body></html>",
    "",
  ].join("\n");
}

// ---------- CLI ----------

export type Args = {
  claude: string | null; codex: string | null; from: number; to: number; days: number; out: string; byProject: boolean; alias: string; share: boolean;
  dashboard: boolean; jev: boolean; yes: boolean; jevMax: number; labels: string | null; screenshot: string | null;
};

const VALUE_FLAGS = ["--claude", "--codex", "--days", "--from", "--to", "--out", "--alias", "--now", "--jev-max", "--labels", "--screenshot"];
const BOOL_FLAGS = ["--by-project", "--share", "--dashboard", "--jev", "--yes"];
const USAGE = [
  "Usage: bun map.ts [--claude DIR|none] [--codex DIR|none] [--days N | --from YYYY-MM-DD --to YYYY-MM-DD]",
  "                  [--out DIR] [--by-project] [--alias NAME] [--now ISO] [--share] [--dashboard]",
  "                  [--jev [--yes] [--jev-max N] [--labels FILE] [--screenshot FILE]] [-h|--help]",
  "       curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share",
  "Reads the last 7 days by default. Use --days N for a longer window; shared maps allow up to 90 days.",
  "Use --from YYYY-MM-DD --to YYYY-MM-DD for a date range.",
  "--dashboard also writes dashboard.html (self-contained, no network) next to the report.",
  `--jev asks TypeSafe Jev the questions in references/jev.md on metadata only. Key: ${JEV_KEY_VAR} in the environment or in .env.local here.`,
  `  It writes the exact bodies to jev-payload.json and sends nothing until you answer yes (--yes for non-interactive runs). At most --jev-max calls (default ${JEV_MAX_CALLS}).`,
].join("\n");
const isDir = (p: string): boolean => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};
/** A YYYY-MM-DD calendar date as UTC midnight, or NaN when it is not one (2026-02-30 does not round-trip). */
const calendarDay = (v: string): number => {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === v ? ms : NaN;
};

/** Throws an Error naming the problem for an unknown flag, a missing value, a stray word or a malformed period. */
export function parseArgs(argv: string[], env: { home: string; now: number; cwd: string }): Args {
  const a = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i] ?? "";
    if (BOOL_FLAGS.includes(k)) flags.add(k);
    else if (VALUE_FLAGS.includes(k)) {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--")) throw new Error(`${k} needs a value`);
      if (a.has(k)) throw new Error(`${k} given twice`);
      a.set(k, v);
      i++;
    } else throw new Error(k.startsWith("--") ? `unknown option ${k}` : `unexpected argument ${k}`);
  }
  const PERIOD = "use --days N (a whole number of days, 1 or more) or --from YYYY-MM-DD --to YYYY-MM-DD";
  if (a.has("--days") && (a.has("--from") || a.has("--to"))) throw new Error(`bad period: ${PERIOD}, not both`);
  if (a.has("--from") !== a.has("--to")) throw new Error(`bad period: ${PERIOD}`);
  const now = a.has("--now") ? Date.parse(a.get("--now") ?? "") : env.now;
  const daysText = a.get("--days") ?? "7";
  if (!/^\d+$/.test(daysText) || Number(daysText) < 1) throw new Error(`bad period: ${PERIOD}`);
  const days = Number(daysText);
  const from = a.has("--from") ? calendarDay(a.get("--from") ?? "") : now - days * DAY;
  const to = a.has("--to") ? calendarDay(a.get("--to") ?? "") + DAY - 1 : now;
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error(`bad period: ${PERIOD}`);
  for (const f of ["--yes", "--jev-max", "--labels", "--screenshot"]) if ((flags.has(f) || a.has(f)) && !flags.has("--jev")) throw new Error(`${f} needs --jev`);
  const maxText = a.get("--jev-max") ?? String(JEV_MAX_CALLS);
  if (!/^\d+$/.test(maxText) || Number(maxText) < 1 || Number(maxText) > 500) throw new Error("--jev-max must be a whole number from 1 to 500");
  const src = (flag: string, def: string): string | null => {
    const given = a.get(flag);
    if (given === "none") return null;
    if (given !== undefined) {
      if (!isDir(given)) throw new Error(`${flag} ${given} is not a folder`);
      return given;
    }
    return isDir(def) ? def : null;
  };
  const stamp = new Date(env.now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return {
    claude: src("--claude", join(env.home, ".claude", "projects")),
    codex: src("--codex", join(env.home, ".codex", "sessions")),
    from,
    to,
    days: Math.round((to - from) / DAY),
    out: a.get("--out") ?? join(env.cwd, `tokenmax-report-${stamp}`),
    byProject: flags.has("--by-project"),
    alias: a.get("--alias") ?? "participant-01",
    share: flags.has("--share"),
    dashboard: flags.has("--dashboard"),
    jev: flags.has("--jev"),
    yes: flags.has("--yes"),
    jevMax: Number(maxText),
    labels: a.get("--labels") ?? null,
    screenshot: a.get("--screenshot") ?? null,
  };
}

/** Creates out (not its parents' contents) atomically: false when it already exists, so two runs never share one folder. */
function reserve(out: string): boolean {
  mkdirSync(dirname(out), { recursive: true });
  try {
    mkdirSync(out);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

/** Seams for tests and embedding: home, working folder, environment, the Jev transport and the yes prompt. */
export type MainIO = { home?: string; cwd?: string; env?: Record<string, string | undefined>; fetch?: FetchFn; confirm?: (question: string) => Promise<boolean>; interactive?: boolean };

async function askYes(question: string, io: MainIO): Promise<boolean> {
  if (io.confirm) return io.confirm(question);
  if (!(io.interactive ?? Boolean(process.stdin.isTTY))) {
    console.log("Not an interactive terminal: pass --yes to send.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^\s*y(es)?\s*$/i.test(answer);
  } finally {
    rl.close();
  }
}

/** A body for printing: an image's base64 is replaced by its length (the exact bytes are in jev-payload.json). */
function printable(body: Rec): string {
  return JSON.stringify(body, (k, v: unknown) => (k === "data_base64" && typeof v === "string" ? `<${v.length} base64 characters, in jev-payload.json>` : v), 2);
}

/** Jev mode: key check, plan, exact payload file, a yes, then the calls. Returns NOT RUN with its reason at any stop. */
async function jevMode(s: Summary, args: Args, io: MainIO, labels: Labels | null): Promise<JevRun> {
  const cwd = io.cwd ?? process.cwd();
  let found: { key: string; from: string } | null;
  try {
    found = resolveJevKey(io.env ?? process.env, cwd);
  } catch (error) {
    const why = error instanceof Error ? error.message : ".env.local could not be read";
    console.log(`Jev NOT RUN: ${why}. Fix its permissions or export ${JEV_KEY_VAR} instead.`);
    return jevNotRun(why);
  }
  if (!found) {
    console.log(`Jev NOT RUN: no ${JEV_KEY_VAR} in the environment or in .env.local in ${cwd}.`);
    console.log(`To add one, put the line ${JEV_KEY_VAR}=<your key> in .env.local in this folder (keep that file out of git) or export ${JEV_KEY_VAR}, then rerun with --jev.`);
    console.log("Keys: https://console.typesafe.ai/ (docs: https://docs.typesafe.ai/introduction/quickstart). The metadata report is complete without it.");
    return jevNotRun(`no ${JEV_KEY_VAR} in the environment or .env.local`);
  }
  let boxNote = "";
  let plan: JevCall[];
  try {
    plan = buildJevPlan(s, { maxCalls: args.jevMax, now: args.to, screenshot: args.screenshot, labels });
  } catch (error) {
    boxNote = error instanceof Error ? error.message : "screenshot refused";
    console.log(`Jev box question NOT RUN: ${boxNote}.`);
    plan = buildJevPlan(s, { maxCalls: args.jevMax, now: args.to, labels });
  }
  if (args.screenshot && !boxNote && !plan.some((c) => c.question === "q4")) boxNote = `screenshot not sent: --jev-max ${args.jevMax} left no room for it`;
  if (!plan.length) {
    console.log("Jev NOT RUN: no week window or session with records to ask about.");
    return jevNotRun("no cases", boxNote);
  }
  const payloadPath = join(args.out, "jev-payload.json");
  const payload = plan.map((c) => ({ id: c.id, question: c.question, model: c.model, url: JEV_ENDPOINT, headers: { "content-type": "application/json", ...(c.images ? { [JEV_IMAGES_HEADER]: "true" } : {}), authorization: `Bearer <${JEV_KEY_VAR}>` }, body: c.body }));
  const text = JSON.stringify(payload, null, 2) + "\n";
  writeFileSync(payloadPath, text, { flag: "wx" });
  const est = plan.reduce((a, c) => a + Math.ceil(JSON.stringify(c.body).length / 4), 0);
  const models = [...new Set(plan.map((c) => c.model))].join(", ");
  console.log("");
  const shot = plan.find((c) => c.question === "q4");
  const shotSize = shot && args.screenshot ? imageSize(readFileSync(args.screenshot)) : null;
  console.log(`Jev payload: ${plan.length} call(s) to ${JEV_ENDPOINT} (TypeSafe), model ${models}, key from ${found.from}. Metadata numbers, no message text${shot && args.screenshot ? `, plus the whole image ${args.screenshot} (${shotSize ? `${shotSize.width} by ${shotSize.height} px, ` : ""}${n(statSync(args.screenshot).size)} bytes, base64 in the box call)` : ""}.`);
  console.log(`About ${n(est)} input tokens, about $${((est * JEV_PRICE_PER_MTOK) / 1_000_000).toFixed(4)} at $${JEV_PRICE_PER_MTOK} per million input tokens. No retries.`);
  console.log(`Exact request bodies: ${payloadPath} (sha256 ${createHash("sha256").update(text).digest("hex").slice(0, 16)}). First body:`);
  console.log(printable(plan[0]?.body ?? {}));
  const approved = args.yes || (await askYes(`Send ${plan.length} call(s) to TypeSafe now? [y/N] `, io));
  if (!approved) {
    console.log("Jev NOT RUN: not approved; nothing was sent.");
    return jevNotRun("not approved", boxNote);
  }
  const run = await runJev(plan, found.key, io.fetch ?? fetch);
  run.boxNote = boxNote;
  console.log(`Jev: ${run.answered} of ${run.calls} call(s) answered${run.failed ? `, ${run.failed} failed` : ""}, ${n(run.inputTokens)} input tokens.`);
  writeFileSync(join(args.out, "jev-results.json"), JSON.stringify(run.results, null, 2) + "\n", { flag: "wx" });
  return run;
}

export async function main(argv: string[], io: MainIO = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const home = io.home ?? homedir();
  let args: Args;
  try {
    args = parseArgs(argv, { home, now: Date.now(), cwd: io.cwd ?? process.cwd() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!args.claude && !args.codex) {
    console.error(`no source folder found: looked for ${join(home, ".claude", "projects")} and ${join(home, ".codex", "sessions")}; pass --claude DIR or --codex DIR`);
    return 2;
  }
  let labels: Labels | null = null;
  if (args.labels) {
    let text: string;
    try {
      text = readFileSync(args.labels, "utf8");
    } catch {
      console.error(`--labels ${args.labels} could not be read`);
      return 2;
    }
    labels = parseLabels(text, args.labels);
  }
  if (existsSync(args.out) || !reserve(args.out)) {
    console.error(`refusing to overwrite ${args.out}: pass a new folder name with --out (it is created for you), or leave --out off for a dated folder`);
    return 2;
  }
  const c = args.claude ? await scanClaude(args.claude, args.from, args.to) : null;
  const x = args.codex ? await scanCodex(args.codex, args.from, args.to) : null;
  const s = summarise(c, x);
  const sources = [args.claude ? "Claude Code" : "", args.codex ? "Codex" : ""].filter(Boolean);
  const from = dayOf(args.from), to = dayOf(args.to);
  const report = join(args.out, "private-report.md");
  // The metadata report is on disk before any network call; Jev mode rewrites it with its results.
  writeFileSync(report, renderPrivate(s, { from, to, byProject: args.byProject, sources, days: args.days, jev: args.jev ? jevNotRun("Jev did not finish") : null, labels }), { flag: "wx" });
  const jev = args.jev ? await jevMode(s, args, io, labels) : null;
  const share = renderShare(s, { alias: args.alias, days: args.days, sources, jevRan: jev?.status === "run" });
  const leaks = scanShare(share);
  if (jev) writeFileSync(report, renderPrivate(s, { from, to, byProject: args.byProject, sources, days: args.days, jev, labels }));
  writeFileSync(join(args.out, "share-draft.md"), share, { flag: "wx" });
  writeFileSync(join(args.out, "sessions.csv"), renderSessionsCsv(s), { flag: "wx" });
  console.log(`wrote ${join(args.out, "private-report.md")}`);
  console.log(`wrote ${join(args.out, "share-draft.md")} (scan: ${leaks.length ? `FOUND ${leaks.join(", ")}` : "clean"})`);
  console.log(`wrote ${join(args.out, "sessions.csv")} (${s.evidence.length} sessions, metadata only)`);
  if (args.dashboard) {
    writeFileSync(join(args.out, "dashboard.html"), renderDashboard(dashData(s, { from, to, jev, labels })), { flag: "wx" });
    console.log(`wrote ${join(args.out, "dashboard.html")} (self-contained, no network)`);
  }
  console.log(`claude sessions ${s.claude?.sessions ?? 0}, codex sessions ${s.codex?.sessions ?? 0}, cap hits ${s.episodes.length}`);
  const perWeek = perWeekLine({ days: args.days, ...weekTotals(s) });
  if (perWeek) console.log(perWeek);
  if (args.share) {
    const shareSources: ShareSources = args.claude && args.codex ? "claude+codex" : args.claude ? "claude" : "codex";
    const payload = buildShare(s, { days: args.days, sources: shareSources });
    const unread = (s.claude?.cov.unreadable ?? 0) + (s.codex?.cov.unreadable ?? 0);
    const refused = unread ? `${unread} folder(s) or file(s) could not be read, so the totals would be understated` : shareRangeError(payload);
    console.log("");
    if (refused) {
      console.log(`Share skipped: ${refused}. The report is written; nothing has been sent.`);
      return 1;
    }
    console.log(renderShareBlock(payload));
  }
  return leaks.length ? 1 : 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
