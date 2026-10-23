// tokenmax-map metadata mapper (skill 0.3.0). Deterministic, local, Node built-ins only.
//
//   bun map.ts [--claude DIR|none] [--codex DIR|none] [--days N | --from YYYY-MM-DD --to YYYY-MM-DD]
//              [--out DIR] [--by-project] [--alias NAME] [--now ISO] [--share] [-h|--help]
//   curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share
//
// Defaults: the Claude Code projects folder and the Codex sessions folder in your home folder when present, the last 7 days, and a new
// ./tokenmax-report-YYYYMMDD-HHMMSS folder. An existing --out folder is refused, never overwritten.
//
// Privacy: message bodies, tool arguments and outputs are never read into a report. The one exception is the
// Claude Code cap notice: an assistant record with isApiErrorMessage true and error "rate_limit", whose only text
// is the notice Claude Code itself writes (SKILL.md, "Known Claude Code shape"). Project basenames appear only in
// private-report.md and only with --by-project. share-draft.md carries aggregate counts only.
// --share prints the tm-share/1 aggregate fields and a review link to stdout; nothing is sent.

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline";

export const VERSION = "0.3.0";
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
export type ClaudeUsage = { messageId: string; ts: number; order: number; session: string; subagent: boolean; model: string; project: string; tokens: ClaudeTokens; file: string };
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
};
export const newClaudeState = (): ClaudeState => ({ cov: newCoverage(), snaps: new Map(), usageRecords: 0, caps: [], errors: new Map(), order: 0 });

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
  /** Timestamp of the latest counter record in the file, in or out of period: which of two copies of a session is the newer history. */
  lastSeenTs: number;
  model: string;
  project: string;
  prev: CodexTokens | undefined;
  established: CodexTokens;
  baselines: number;
  days: Map<string, number>;
  /** input + output per model, credited to the model of the latest turn_context before each reading. */
  byModel: Map<string, number>;
};
export type WindowReading = { ts: number; slot: string; usedPercent: number; windowMinutes: number; resetsAt: number };
/**
 * lastReading is the latest in-period window reading of any window; lastWeekly the latest weekly (10080-minute) one.
 * badReadings counts window slots whose used_percent is not a finite non-negative number, or whose resets_at is not
 * a representable date: they are never readings.
 */
export type CodexState = { cov: Coverage; sessions: CodexSession[]; duplicateFiles: number; caps: CapOccurrence[]; reachedWithoutWindow: number; badReadings: number; lastReading: WindowReading | undefined; lastWeekly: WindowReading | undefined };
export const newCodexState = (): CodexState => ({ cov: newCoverage(), sessions: [], duplicateFiles: 0, caps: [], reachedWithoutWindow: 0, badReadings: 0, lastReading: undefined, lastWeekly: undefined });
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
  if (!line.includes('"token_count"') && !line.includes(`"${CODEX_META_TYPE}"`) && !line.includes('"turn_context"')) return;
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
  sess.days.set(day, (sess.days.get(day) ?? 0) + d.input + d.output);
  sess.byModel.set(sess.model, (sess.byModel.get(sess.model) ?? 0) + d.input + d.output);
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
    const sess: CodexSession = { id: file, subagent: false, forked: false, startTs: undefined, file, readings: 0, firstTs: Infinity, lastTs: -Infinity, lastSeenTs: -Infinity, model: "unknown", project: "unknown", prev: undefined, established: zeroCodex(), baselines: 0, days: new Map(), byModel: new Map() };
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
    if (fst.lastReading && (!st.lastReading || fst.lastReading.ts >= st.lastReading.ts)) st.lastReading = fst.lastReading;
    if (fst.lastWeekly && (!st.lastWeekly || fst.lastWeekly.ts >= st.lastWeekly.ts)) st.lastWeekly = fst.lastWeekly;
  }
  return st;
}

// ---------- summary ----------

export type Summary = ReturnType<typeof summarise>;

/** One row of the private evidence index: where in the source logs a session's findings come from. */
export type Evidence = { source: "claude" | "codex"; session: string; alias: string; files: string[]; first: number; last: number; records: number; caps: number };

/**
 * Per-session provenance: source-relative files, first and last in-period record, counted records and cap notices.
 * Sessions with a cap come first, then the most records; aliases session-001... follow that order.
 */
function buildEvidence(c: ClaudeState | null, x: CodexState | null, xActive: CodexSession[]): Evidence[] {
  const rows = new Map<string, Omit<Evidence, "alias"> & { fileSet: Set<string> }>();
  const touch = (source: "claude" | "codex", session: string, file: string | undefined, ts: number, records: number, caps: number): void => {
    const key = `${source}|${session}`;
    const r = rows.get(key) ?? { source, session, files: [], fileSet: new Set<string>(), first: ts, last: ts, records: 0, caps: 0 };
    if (file) r.fileSet.add(file);
    r.first = Math.min(r.first, ts);
    r.last = Math.max(r.last, ts);
    r.records += records;
    r.caps += caps;
    rows.set(key, r);
  };
  for (const u of c?.snaps.values() ?? []) touch("claude", u.session, u.file, u.ts, 1, 0);
  for (const cap of c?.caps ?? []) touch("claude", cap.session, cap.file, cap.ts, 0, 1);
  for (const sess of xActive) if (sess.readings > 0) { touch("codex", sess.id, sess.file, sess.firstTs, sess.readings, 0); touch("codex", sess.id, sess.file, sess.lastTs, 0, 0); }
  for (const cap of x?.caps ?? []) touch("codex", cap.session, cap.file, cap.ts, 0, 1);
  const ordered = [...rows.values()].sort((a, b) => (b.caps > 0 ? 1 : 0) - (a.caps > 0 ? 1 : 0) || b.records - a.records || a.first - b.first || a.session.localeCompare(b.session));
  return ordered.map((r, i) => ({ source: r.source, session: r.session, alias: `session-${String(i + 1).padStart(3, "0")}`, files: [...r.fileSet].sort(), first: r.first, last: r.last, records: r.records, caps: r.caps }));
}

/** A source-relative path for the private report. Without --by-project the Claude project folder (its first segment) is replaced by a short hash, so the same folder still matches across rows. */
export function fileRef(rel: string, source: "claude" | "codex", byProject: boolean): string {
  const parts = rel.split(sep);
  if (byProject || source !== "claude" || parts.length < 2) return parts.join("/");
  return ["dir-" + createHash("sha256").update(parts[0] ?? "").digest("hex").slice(0, 8), ...parts.slice(1)].join("/");
}

export function summarise(c: ClaudeState | null, x: CodexState | null) {
  const byModel = new Map<string, ClaudeTokens & { messages: number }>();
  const byDay = new Map<string, number>();
  const byProject = new Map<string, number>();
  const sessions = new Map<string, boolean>();
  for (const u of c?.snaps.values() ?? []) {
    const m = byModel.get(u.model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    m.input += u.tokens.input;
    m.output += u.tokens.output;
    m.cacheRead += u.tokens.cacheRead;
    m.cacheWrite += u.tokens.cacheWrite;
    m.messages++;
    byModel.set(u.model, m);
    const t = u.tokens.input + u.tokens.output + u.tokens.cacheWrite;
    byDay.set(dayOf(u.ts), (byDay.get(dayOf(u.ts)) ?? 0) + t);
    byProject.set(u.project, (byProject.get(u.project) ?? 0) + t);
    sessions.set(u.session, (sessions.get(u.session) ?? false) || u.subagent);
  }
  for (const cap of c?.caps ?? []) if (!sessions.has(cap.session)) sessions.set(cap.session, false);
  // A Codex session counts with in-period usage or an in-period cap, the same rule as Claude.
  const xCapSessions = new Set((x?.caps ?? []).map((cap) => cap.session));
  const xActive = (x?.sessions ?? []).filter((s) => s.days.size > 0 || xCapSessions.has(s.id));
  const xTotals = zeroCodex();
  const xByModel = new Map<string, number>();
  const xByDay = new Map<string, number>();
  const xByProject = new Map<string, number>();
  for (const s of xActive) {
    for (const [k] of CODEX_KEYS) xTotals[k] += s.established[k];
    const t = s.established.input + s.established.output;
    for (const [m, v] of s.byModel) xByModel.set(m, (xByModel.get(m) ?? 0) + v);
    xByProject.set(s.project, (xByProject.get(s.project) ?? 0) + t);
    for (const [d, n] of s.days) xByDay.set(d, (xByDay.get(d) ?? 0) + n);
  }
  const evidence = buildEvidence(c, x, xActive);
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

export function renderPrivate(s: Summary, o: { from: string; to: string; byProject: boolean; sources: string[]; days?: number }): string {
  const L: string[] = [];
  L.push(`# TokenMax map: private report`, "");
  L.push(`Skill tokenmax-map ${VERSION}, metadata mode, \`scripts/map.ts\`. Period ${o.from} to ${o.to} (UTC). Sources: ${o.sources.join(", ") || "none"}. Jev analysis: NOT RUN.`, "");
  L.push(`## Coverage`, "", `| Source | Files | Unreadable | Lines | Parsed | Accepted | Malformed | Unsupported | Out of period |`, `|---|---|---|---|---|---|---|---|---|`);
  const covRows: Array<[string, Coverage | undefined]> = [["Claude Code", s.claude?.cov], ["Codex", s.codex?.cov]];
  for (const [name, cov] of covRows) {
    if (cov) L.push(`| ${name} | ${n(cov.files)} | ${n(cov.unreadable)} | ${n(cov.lines)} | ${n(cov.parsed)} | ${n(cov.accepted)} | ${n(cov.malformed)} | ${n(cov.unsupported)} | ${n(cov.outOfPeriod)} |`);
  }
  L.push("", "- Files are selected by modification time inside the period, then records by timestamp. Lines that cannot carry usage, a cap or a counter are skipped unparsed (Lines minus Parsed).");
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
    L.push("", "Fields: message.usage input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, summed over the latest snapshot per message.id. Day and project totals below use input + output + cache write; cache read is reported only in the model table.", "");
    L.push(`| Day (UTC) | Tokens |`, `|---|---|`);
    for (const [d, v] of [...c.byDay].sort()) L.push(`| ${d} | ${n(v)} |`);
    L.push("");
    if (o.byProject) {
      const total = [...c.byProject.values()].reduce((a, b) => a + b, 0);
      L.push(`| Project (top 15) | Tokens | Share |`, `|---|---|---|`);
      for (const [p, v] of top(c.byProject, 15)) L.push(`| ${p} | ${n(v)} | ${share(v, total)} |`);
      L.push("");
    }
  }
  if (s.codex) {
    const x = s.codex;
    L.push(`## Codex usage`, "", `| Counter | Established |`, `|---|---|`);
    L.push(`| input_tokens | ${n(x.totals.input)} |`, `| cached_input_tokens (subset of input) | ${n(x.totals.cachedInput)} |`, `| cache_write_input_tokens | ${n(x.totals.cacheWrite)} |`, `| output_tokens | ${n(x.totals.output)} |`, `| reasoning_output_tokens (as reported) | ${n(x.totals.reasoning)} |`);
    L.push("", "Non-negative deltas of payload.info.total_token_usage within each session file. Day, model and project totals use input + output.", "");
    L.push(`| Model | Tokens |`, `|---|---|`);
    for (const [m, v] of top(x.byModel, 10)) L.push(`| ${m} | ${n(v)} |`);
    L.push("", `| Day (UTC) | Tokens |`, `|---|---|`);
    for (const [d, v] of [...x.byDay].sort()) L.push(`| ${d} | ${n(v)} |`);
    L.push("");
    if (o.byProject) {
      const total = [...x.byProject.values()].reduce((a, b) => a + b, 0);
      L.push(`| Project (top 15) | Tokens | Share |`, `|---|---|---|`);
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
    L.push(`- Last Codex window reading: ${r.slot} ${r.usedPercent}% used, window_minutes ${r.windowMinutes}, resets_at ${resets}${r.resetsAt ? " UTC" : ""} (read ${new Date(r.ts).toISOString().slice(0, 16)}).`);
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
      L.push(`| ${i + 1} | ${e.source} | ${e.window} | ${e.reset || "none"} | ${new Date(e.first).toISOString().slice(0, 16)} | ${e.occurrences} | ${e.sessions.size} | ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""} |`);
    });
    L.push("");
  }

  L.push(`## Evidence index`, "", `Where each finding comes from, with no message text copied. Sessions with a cap notice come first, then the most records. Records: Claude messages (latest snapshot per message.id) or Codex counted counter readings. Files are relative to the source folder${o.byProject ? "" : "; a Claude project folder shows as dir-<hash> (add --by-project for the name)"}.`, "");
  if (s.evidence.length) {
    L.push(`| Session | Source | Source file | First (UTC) | Last (UTC) | Records | Cap notices |`, `|---|---|---|---|---|---|---|`);
    // Every session with a cap notice is listed, so each episode's aliases resolve; the cutoff applies to the rest.
    const shown = Math.max(EVIDENCE_ROWS, s.evidence.filter((e) => e.caps > 0).length);
    for (const e of s.evidence.slice(0, shown)) {
      const refs = e.files.length ? e.files.map((f) => fileRef(f, e.source, o.byProject)).join("; ") : "none";
      L.push(`| ${e.alias} | ${e.source} | ${refs} | ${new Date(e.first).toISOString().slice(0, 16)} | ${new Date(e.last).toISOString().slice(0, 16)} | ${n(e.records)} | ${e.caps} |`);
    }
    if (s.evidence.length > shown) L.push("", `${n(s.evidence.length - shown)} more session(s) with in-period evidence are not listed.`);
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
  L.push("", `## Not covered`, "", "- Jev classification NOT RUN. Message text is not read except Claude Code cap notices. Work categories need your own descriptions.", "- Token counts are not subscription percentages or cost.");
  return L.join("\n") + "\n";
}

export function renderShare(s: Summary, o: { alias: string; days: number; sources: string[] }): string {
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
    "Jev analysis: NOT RUN",
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

export type WeekTotals = { sessions: number; claudeOutput: number; codexOutput: number; capHits: number };
/** The period totals the per-week averages divide: sessions and cap hits over both sources, output tokens per source. */
export function weekTotals(s: Summary): WeekTotals {
  return {
    sessions: (s.claude?.sessions ?? 0) + (s.codex?.sessions ?? 0),
    claudeOutput: s.claude ? [...s.claude.byModel.values()].reduce((a, t) => a + t.output, 0) : 0,
    codexOutput: s.codex?.totals.output ?? 0,
    capHits: s.episodes.length,
  };
}

/** Over 7 days, the per-week averages: each total divided evenly by days / 7 (#409). Null for 7 days or fewer. */
export function perWeekLine(t: WeekTotals & { days: number }): string | null {
  if (t.days <= 7) return null;
  const weeks = t.days / 7;
  const one = (v: number): string => (Math.round(v * 10) / 10).toLocaleString("en-US");
  const per = (v: number): string => n(Math.round(v / weeks));
  return `Per week on average over ${one(weeks)} weeks (${t.days} days): ${per(t.sessions)} sessions, ${per(t.claudeOutput)} Claude output tokens, ${per(t.codexOutput)} Codex output tokens, ${one(t.capHits / weeks)} cap hits. Totals divided evenly by days / 7; not a measured week.`;
}

/** Aggregate share fields from a summary. Sessions, subagent sessions and cap episodes sum both sources. */
export function buildShare(s: Summary, o: { days: number; sources: ShareSources }): SharePayload {
  const { sessions, claudeOutput: claudeOut } = weekTotals(s);
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

// ---------- CLI ----------

export type Args = { claude: string | null; codex: string | null; from: number; to: number; days: number; out: string; byProject: boolean; alias: string; share: boolean };

const VALUE_FLAGS = ["--claude", "--codex", "--days", "--from", "--to", "--out", "--alias", "--now"];
const BOOL_FLAGS = ["--by-project", "--share"];
const USAGE = [
  "Usage: bun map.ts [--claude DIR|none] [--codex DIR|none] [--days N | --from YYYY-MM-DD --to YYYY-MM-DD]",
  "                  [--out DIR] [--by-project] [--alias NAME] [--now ISO] [--share] [-h|--help]",
  "       curl -fsSL https://jevnotjev.breakoutwithai.com/tm/map.ts | bun run - --share",
  "Reads the last 7 days by default. Use --days N for a longer window; shared maps allow up to 90 days.",
  "Use --from YYYY-MM-DD --to YYYY-MM-DD for a date range.",
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

export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  let args: Args;
  try {
    args = parseArgs(argv, { home: homedir(), now: Date.now(), cwd: process.cwd() });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!args.claude && !args.codex) {
    console.error("no source folder found: pass --claude DIR or --codex DIR");
    return 2;
  }
  if (existsSync(args.out) || !reserve(args.out)) {
    console.error(`refusing to overwrite ${args.out}: pass a new folder name with --out (it is created for you), or leave --out off for a dated folder`);
    return 2;
  }
  const c = args.claude ? await scanClaude(args.claude, args.from, args.to) : null;
  const x = args.codex ? await scanCodex(args.codex, args.from, args.to) : null;
  const s = summarise(c, x);
  const sources = [args.claude ? "Claude Code" : "", args.codex ? "Codex" : ""].filter(Boolean);
  const share = renderShare(s, { alias: args.alias, days: args.days, sources });
  const leaks = scanShare(share);
  writeFileSync(join(args.out, "private-report.md"), renderPrivate(s, { from: dayOf(args.from), to: dayOf(args.to), byProject: args.byProject, sources, days: args.days }), { flag: "wx" });
  writeFileSync(join(args.out, "share-draft.md"), share, { flag: "wx" });
  console.log(`wrote ${join(args.out, "private-report.md")}`);
  console.log(`wrote ${join(args.out, "share-draft.md")} (scan: ${leaks.length ? `FOUND ${leaks.join(", ")}` : "clean"})`);
  console.log(`claude sessions ${s.claude?.sessions ?? 0}, codex sessions ${s.codex?.sessions ?? 0}, cap hits ${s.episodes.length}`);
  const perWeek = perWeekLine({ days: args.days, ...weekTotals(s) });
  if (perWeek) console.log(perWeek);
  if (args.share) {
    const sources: ShareSources = args.claude && args.codex ? "claude+codex" : args.claude ? "claude" : "codex";
    const payload = buildShare(s, { days: args.days, sources });
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
