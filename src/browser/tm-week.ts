// Reads the TOKENMAX WEEK block a visitor pastes back into /tm/ after running the prompt in Claude Code or Codex,
// and derives everything the page shows from it. Runs in the browser only: nothing is sent or stored. Tolerant of
// what assistants do to a plain block: any case, extra spaces, thousands commas, bullets, markdown table pipes, bold
// markers and a trailing "%". A line it cannot read, or one that says "not recorded", stays null and is shown as
// "not recorded"; nothing is invented: no day, no story, no saving.

export type Pattern = "running out" | "leaving most unused";
export type Week = {
  readonly period: { readonly start: string; readonly end: string } | null;
  readonly claudeSessions: number | null;
  readonly codexSessions: number | null;
  readonly claudeOutput: number | null;
  readonly codexOutput: number | null;
  readonly opusShare: number | null;
  readonly limitHits: number | null;
  readonly codexWindow: number | null;
  readonly pattern: Pattern | null;
  /** Sessions per day, Claude Code plus Codex, oldest day first: exactly seven numbers, else null. */
  readonly perDay: readonly number[] | null;
  /** Dates (YYYY-MM-DD) on which a limit was hit; [] for "none"; null when not recorded or unreadable. */
  readonly limitDays: readonly string[] | null;
};
type NumberField = "claudeSessions" | "codexSessions" | "claudeOutput" | "codexOutput" | "opusShare" | "limitHits" | "codexWindow";

/** Shown when nothing in the paste is recognisable. */
export const NOT_A_RESULT = "That doesn't look like the result. Run the prompt again and paste what it prints.";
export const NOT_RECORDED = "not recorded";

const LABELS: Readonly<Record<string, NumberField | "period" | "pattern" | "perDay" | "limitDays">> = {
  "period": "period",
  "claude sessions": "claudeSessions",
  "codex sessions": "codexSessions",
  "claude output tokens": "claudeOutput",
  "codex output tokens": "codexOutput",
  "opus share of claude output": "opusShare",
  "usage limit hits": "limitHits",
  "sessions per day": "perDay",
  "limit hit days": "limitDays",
  "codex weekly window used": "codexWindow",
  "pattern": "pattern",
};

/** Label and value from one line: "Label: value", a "| Label | Value |" table row, with bullets or bold markers. */
function labelValue(raw: string): [string, string] | null {
  const line = raw.replace(/\*\*|__|`/g, "").trim().replace(/^(?:[-*+•]|\d+[.)])\s+/, "");
  let label: string;
  let value: string;
  if (line.includes("|")) {
    const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
    if (cells.length < 2 || cells.every((c) => /^:?-+:?$/.test(c))) return null;
    label = cells[0] ?? "";
    value = cells[1] ?? "";
  } else {
    const at = line.indexOf(":");
    if (at < 0) return null;
    label = line.slice(0, at);
    value = line.slice(at + 1);
  }
  return [label.toLowerCase().replace(/\s+/g, " ").trim(), value.trim()];
}

/** A number from "7,940,728", " 42 %", "~2,900"; null for "not recorded" or anything without a number. */
export function readNumber(value: string): number | null {
  if (/not recorded/i.test(value)) return null;
  const m = /\d[\d,]*(?:\.\d+)?/.exec(value);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

const WEEKDAY = /^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?\s*/i;

/** "40, 52, 61, 44, 38, 30, 27" (each may carry a weekday word): exactly seven whole numbers, else null. */
export function readPerDay(value: string): number[] | null {
  if (/not recorded/i.test(value)) return null;
  // Thousands commas are ambiguous in a comma list, so a day's count is digits only.
  const parts = value.split(/[,;]/).map((p) => p.trim().replace(WEEKDAY, "").trim());
  if (parts.length !== 7 || parts.some((p) => !/^\d+$/.test(p))) return null;
  return parts.map(Number);
}

/** A real calendar date in YYYY-MM-DD, else null. */
export function readDate(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim().replace(WEEKDAY, "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === `${m[1]}-${m[2]}-${m[3]}` ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** "2026-10-15, 2026-10-17" or "none": the dates; any unreadable date makes the whole line not recorded. */
export function readLimitDays(value: string): string[] | null {
  if (/^none\.?$/i.test(value.trim())) return [];
  if (/not recorded/i.test(value) || value.trim() === "") return null;
  const dates = value.split(/[,;]/).map((p) => readDate(p));
  return dates.every((d): d is string => d !== null) ? dates : null;
}

/** The week in a pasted result, or null when no line of it is recognisable. */
export function parseWeek(text: string): Week | null {
  const nums: Record<NumberField, number | null> = { claudeSessions: null, codexSessions: null, claudeOutput: null, codexOutput: null, opusShare: null, limitHits: null, codexWindow: null };
  let period: Week["period"] = null;
  let pattern: Pattern | null = null;
  let perDay: number[] | null = null;
  let limitDays: string[] | null = null;
  let recognised = 0;
  for (const raw of text.split(/\r?\n/)) {
    const lv = labelValue(raw);
    if (!lv) continue;
    const field = LABELS[lv[0]];
    if (field === undefined) continue;
    recognised += 1;
    const value = lv[1];
    if (field === "period") {
      const m = /(\S.*?)\s+to\s+(\S.*)/i.exec(value);
      period = m && !/not recorded/i.test(value) ? { start: (m[1] ?? "").trim(), end: (m[2] ?? "").trim() } : null;
    } else if (field === "pattern") {
      pattern = /running out/i.test(value) ? "running out" : /unused/i.test(value) ? "leaving most unused" : null;
    } else if (field === "perDay") {
      perDay = readPerDay(value);
    } else if (field === "limitDays") {
      limitDays = readLimitDays(value);
    } else {
      nums[field] = readNumber(value);
    }
  }
  if (recognised === 0) return null;
  return { period, pattern, perDay, limitDays, ...nums };
}

/** The situation to play: the Pattern line if given, else running out when a limit was hit, else unused. */
export function situationOf(week: Week): Pattern {
  if (week.pattern) return week.pattern;
  return (week.limitHits ?? 0) > 0 ? "running out" : "leaving most unused";
}

const fmt = (n: number | null, unit = ""): string => n === null ? NOT_RECORDED : `${n.toLocaleString("en-US")}${unit}`;

/** The card's labelled rows, values formatted with thousands separators. */
export function weekLines(week: Week): { readonly label: string; readonly value: string }[] {
  return [
    { label: "Claude sessions", value: fmt(week.claudeSessions) },
    { label: "Codex sessions", value: fmt(week.codexSessions) },
    { label: "Claude output tokens", value: fmt(week.claudeOutput) },
    { label: "Codex output tokens", value: fmt(week.codexOutput) },
    { label: "Opus share", value: fmt(week.opusShare, "%") },
    { label: "Usage limit hits", value: fmt(week.limitHits) },
    { label: "Codex weekly window used", value: fmt(week.codexWindow, "%") },
  ];
}

/** The card's period line. */
export function periodLine(week: Week): string {
  return week.period ? `${week.period.start} to ${week.period.end}` : `Period ${NOT_RECORDED}`;
}

/** The card's headline, from the parsed values only. */
export function cardHeadline(week: Week): string {
  const n = week.limitHits;
  if (n !== null && n > 0) return `Heavy load: you hit your limit ${n.toLocaleString("en-US")} ${n === 1 ? "time" : "times"}`;
  if (n === 0) return "Light use: you never hit a limit";
  if (week.pattern === "running out") return "Heavy load: running out before the end of the week";
  if (week.pattern === "leaving most unused") return "Light use: leaving most of the week unused";
  return `Usage limit hits ${NOT_RECORDED}`;
}

/** Show Sample: one builder's real week, the sample this site has shown since #238. Period, totals, cap hits, Opus and
 * Codex figures are the recorded run (both cap hits on 2026-10-14). The per-day split is NOT in that record: it was
 * constructed on the operator's request (2026-10-21) to sum to the recorded 3,993 sessions. */
export const SAMPLE_WEEK: Week = {
  period: { start: "2026-10-09", end: "2026-10-16" }, claudeSessions: 515, codexSessions: 3478, claudeOutput: 9977232, codexOutput: 7503143,
  opusShare: 87, limitHits: 2, codexWindow: 15, pattern: null,
  perDay: [520, 610, 655, 702, 590, 498, 418], limitDays: ["2026-10-14"],
};

// ---------- The stage from data: only what the numbers support ----------
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The seven poster labels: the weekday of Period start + i, computed from the date; "Day 1..7" with no usable start. */
export function dayLabels(week: Week): string[] {
  const start = week.period ? readDate(week.period.start) : null;
  if (!start) return [1, 2, 3, 4, 5, 6, 7].map((i) => `Day ${i}`);
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return [0, 1, 2, 3, 4, 5, 6].map((i) => DAY_NAMES[new Date(t0 + i * 86400000).getUTCDay()] ?? "");
}

/** Which of the seven days (0..6) a recorded limit-hit date falls on; dates outside the period are dropped. Nothing is
 * stamped unless Usage limit hits is recorded above 0: a date with hits 0 or not recorded contradicts or is unbacked. */
export function limitDayIndexes(week: Week): number[] {
  const start = week.period ? readDate(week.period.start) : null;
  if (!start || !week.limitDays || !((week.limitHits ?? 0) > 0)) return [];
  const t0 = Date.parse(`${start}T00:00:00Z`);
  return [...new Set(week.limitDays.map((d) => Math.round((Date.parse(`${d}T00:00:00Z`) - t0) / 86400000)).filter((i) => i >= 0 && i <= 6))].sort((a, b) => a - b);
}

/** "Thu", "Thu and Sat", "Wed, Thu and Sat". */
function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1] ?? ""}`;
}

/** The stage's ending headline, from the numbers only. */
export function stageHeadline(week: Week): string {
  const n = week.limitHits;
  if (n === null) return `Usage limit hits ${NOT_RECORDED}`;
  if (n === 0) return "You never hit your limit";
  const days = limitDayIndexes(week);
  const labels = dayLabels(week);
  const on = days.length && week.limitDays && days.length === week.limitDays.length ? `, on ${listOf(days.map((i) => labels[i] ?? ""))}` : "";
  return `You hit your limit ${n.toLocaleString("en-US")} ${n === 1 ? "time" : "times"}${on}`;
}

/** One line from sessions and Opus share, each part only when recorded. */
export function stageSubtitle(week: Week): string {
  const parts: string[] = [];
  const s = [week.claudeSessions === null ? "" : `${week.claudeSessions.toLocaleString("en-US")} Claude Code`, week.codexSessions === null ? "" : `${week.codexSessions.toLocaleString("en-US")} Codex`].filter(Boolean);
  if (s.length) parts.push(`${s.join(" and ")} sessions`);
  if (week.opusShare !== null) parts.push(`Opus ${week.opusShare.toLocaleString("en-US")}% of Claude output`);
  return parts.join("; ");
}
