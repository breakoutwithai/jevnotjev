/** Adapted from the operator-authorized TokenMax Map metadata mapper v0.2.0 (2026-10-16).
 * Reuse: provider counter shapes, snapshot folding, episode grouping. Changes: namespaced Claude
 * identities; Codex active baseline sessions, all-counter segment reset and future-start guard.
 * No rendering, report writing or CLI from source. Source provenance in tokenmax-collection-credit.md. */

export const CODEX_META_TYPE = ["session", "meta"].join("_");
const DAY = 86_400_000;

// ---------- helpers ----------

export type Rec = Record<string, unknown>;
export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A token counter: a non-negative safe integer, else undefined. */
const counter = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A cwd's project basename, rolling `<repo>-wt/<YYYYMMDD>-<slug>` and assistant worktree folders up to the repo. */
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
export type CapOccurrence = { source: "claude" | "codex"; ts: number; window: Window; reset: string; session: string; eventId: string };
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
export type ClaudeUsage = { messageId: string; ts: number; order: number; session: string; subagent: boolean; model: string; project: string; tokens: ClaudeTokens };
export type ClaudeParsed =
  | { kind: "usage"; usage: ClaudeUsage }
  | { kind: "cap"; cap: CapOccurrence }
  | { kind: "error"; category: string }
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
export function parseClaudeLine(line: string, ctx: { subagent: boolean; order: number }): ClaudeParsed {
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
    if (category !== "rate_limit") return { kind: "error", category };
    let text = "";
    if (Array.isArray(msg.content)) for (const c of msg.content) if (isRec(c)) text += str(c.text);
    if (!/hit your .{0,12}limit|usage limit/i.test(text)) return { kind: "error", category: "rate_limit-generic" };
    const { window, reset } = classifyClaudeNotice(text);
    return { kind: "cap", cap: { source: "claude", ts, window, reset, session, eventId: str(raw.uuid) } };
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
  const ts = p.kind === "usage" ? p.usage.ts : p.kind === "cap" ? p.cap.ts : from;
  if (ts < from || ts > to) { s.cov.outOfPeriod++; return; }
  s.cov.accepted++;
  if (p.kind === "error") { s.errors.set(p.category, (s.errors.get(p.category) ?? 0) + 1); return; }
  if (p.kind === "cap") { s.caps.push(p.cap); return; }
  s.usageRecords++;
  const u = p.usage;
  const key = JSON.stringify([u.session, u.messageId]);
  const prev = s.snaps.get(key);
  if (!prev || u.ts > prev.ts || (u.ts === prev.ts && u.order > prev.order)) s.snaps.set(key, u);
}

// ---------- Codex ----------

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
  active?: boolean;
  model: string;
  project: string;
  prev: CodexTokens | undefined;
  established: CodexTokens;
  baselines: number;
  days: Map<string, number>;
};
export type WindowReading = { ts: number; slot: string; usedPercent: number; windowMinutes: number; resetsAt: number };
export type CodexState = { cov: Coverage; sessions: CodexSession[]; caps: CapOccurrence[]; reachedWithoutWindow: number; lastReading: WindowReading | undefined; lastWeekly?: WindowReading };
export const newCodexState = (): CodexState => ({ cov: newCoverage(), sessions: [], caps: [], reachedWithoutWindow: 0, lastReading: undefined });

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
 * full only when this file holds an in-period session metadata start record for a session that was not forked;
 * otherwise it is an uncounted baseline. A decrease is a new uncounted baseline.
 */
export function addCodexLine(st: CodexState, sess: CodexSession, line: string, from: number, to: number): void {
  if (!line.includes('"token_count"') && !line.includes(JSON.stringify(CODEX_META_TYPE)) && !line.includes('"turn_context"')) return;
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
  const inPeriod = ts >= from && ts <= to && (sess.startTs === undefined || ts >= sess.startTs);
  if (inPeriod) sess.active = true;
  const cur = readTotals(isRec(p.info) ? p.info.total_token_usage : undefined);
  if (cur) {
    if (!sess.prev) {
      const fromStart = sess.startTs !== undefined && sess.startTs >= from && sess.startTs <= ts && !sess.forked;
      if (fromStart && inPeriod) addDelta(sess, cur, ts);
      else sess.baselines++;
    } else if (CODEX_KEYS.some(([key]) => cur[key] < (sess.prev?.[key] ?? 0))) {
      sess.baselines++;
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
    const used = typeof w.used_percent === "number" ? w.used_percent : 0;
    if (!st.lastReading || ts >= st.lastReading.ts) st.lastReading = { ts, slot, usedPercent: used, windowMinutes: counter(w.window_minutes) ?? 0, resetsAt: counter(w.resets_at) ?? 0 };
    if (counter(w.window_minutes) === 10080 && Number.isFinite(used) && used >= 0 && used <= 100 && (!st.lastWeekly || ts >= st.lastWeekly.ts)) st.lastWeekly = { ts, slot, usedPercent: used, windowMinutes: 10080, resetsAt: counter(w.resets_at) ?? 0 };
    if (used < 100) continue;
    found = true;
    const wm = counter(w.window_minutes);
    const window: Window = wm === 10080 ? "weekly" : wm !== undefined && wm <= 300 ? "short" : "unknown";
    st.caps.push({ source: "codex", ts, window, reset: String(counter(w.resets_at) ?? ""), session: sess.id, eventId: "" });
  }
  if (reached && !found) {
    st.reachedWithoutWindow++;
    st.caps.push({ source: "codex", ts, window: "unknown", reset: reached, session: sess.id, eventId: "" });
  }
}

function addDelta(sess: CodexSession, d: CodexTokens, ts: number): void {
  for (const [k] of CODEX_KEYS) sess.established[k] += d[k];
  const day = dayOf(ts);
  sess.days.set(day, (sess.days.get(day) ?? 0) + d.input + d.output);
}

// ---------- summary ----------

export type Summary = ReturnType<typeof summarise>;

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
  const xActive = (x?.sessions ?? []).filter((s) => s.active || s.days.size > 0);
  const xTotals = zeroCodex();
  const xByModel = new Map<string, number>();
  const xByDay = new Map<string, number>();
  const xByProject = new Map<string, number>();
  for (const s of xActive) {
    for (const [k] of CODEX_KEYS) xTotals[k] += s.established[k];
    const t = s.established.input + s.established.output;
    xByModel.set(s.model, (xByModel.get(s.model) ?? 0) + t);
    xByProject.set(s.project, (xByProject.get(s.project) ?? 0) + t);
    for (const [d, n] of s.days) xByDay.set(d, (xByDay.get(d) ?? 0) + n);
  }
  const episodes = groupEpisodes([...(c?.caps ?? []), ...(x?.caps ?? [])]);
  const win = (src: "claude" | "codex") => {
    const e = { short: 0, weekly: 0, unknown: 0 };
    for (const ep of episodes) if (ep.source === src) e[ep.window]++;
    return e;
  };
  const subagents = [...sessions.values()].filter(Boolean).length;
  return {
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
      capEpisodes: win("claude"),
      errors: c.errors,
    },
    codex: x && {
      cov: x.cov,
      sessions: xActive.length,
      subagentSessions: xActive.filter((s) => s.subagent).length,
      baselines: xActive.reduce((a, s) => a + s.baselines, 0),
      totals: xTotals,
      byModel: xByModel,
      byDay: xByDay,
      byProject: xByProject,
      capOccurrences: x.caps.length,
      capEpisodes: win("codex"),
      reachedWithoutWindow: x.reachedWithoutWindow,
      lastReading: x.lastReading,
    },
    episodes,
  };
}
