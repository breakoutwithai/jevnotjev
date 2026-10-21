// Reads the TOKENMAX WEEK block a visitor pastes back into /tm/ after running the prompt in Claude Code or Codex.
// Runs in the browser only: nothing is sent or stored. Tolerant of what assistants do to a plain block: any case,
// extra spaces, thousands commas, bullets, markdown table pipes, bold markers and a trailing "%". A line it cannot
// read, or one that says "not recorded", stays null and is shown as "not recorded"; nothing is invented.

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
};
type NumberField = "claudeSessions" | "codexSessions" | "claudeOutput" | "codexOutput" | "opusShare" | "limitHits" | "codexWindow";

/** Shown when nothing in the paste is recognisable. */
export const NOT_A_RESULT = "That doesn't look like the result. Run the prompt again and paste what it prints.";

const LABELS: Readonly<Record<string, NumberField | "period" | "pattern">> = {
  "period": "period",
  "claude sessions": "claudeSessions",
  "codex sessions": "codexSessions",
  "claude output tokens": "claudeOutput",
  "codex output tokens": "codexOutput",
  "opus share of claude output": "opusShare",
  "usage limit hits": "limitHits",
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

/** The week in a pasted result, or null when no line of it is recognisable. */
export function parseWeek(text: string): Week | null {
  const nums: Record<NumberField, number | null> = { claudeSessions: null, codexSessions: null, claudeOutput: null, codexOutput: null, opusShare: null, limitHits: null, codexWindow: null };
  let period: Week["period"] = null;
  let pattern: Pattern | null = null;
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
    } else {
      nums[field] = readNumber(value);
    }
  }
  if (recognised === 0) return null;
  return { period, pattern, ...nums };
}

/** The situation to play: the Pattern line if given, else running out when a limit was hit, else unused. */
export function situationOf(week: Week): Pattern {
  if (week.pattern) return week.pattern;
  return (week.limitHits ?? 0) > 0 ? "running out" : "leaving most unused";
}

const fmt = (n: number | null, unit = ""): string => n === null ? "not recorded" : `${n.toLocaleString("en-US")}${unit}`;

/** The "Your week" card's lines, in plain words. */
export function weekLines(week: Week): { readonly label: string; readonly value: string }[] {
  const both = (claude: number | null, codex: number | null): string =>
    claude === null && codex === null ? "not recorded" : `${fmt(claude)} in Claude Code, ${fmt(codex)} in Codex`;
  return [
    { label: "Period", value: week.period ? `${week.period.start} to ${week.period.end}` : "not recorded" },
    { label: "Sessions", value: both(week.claudeSessions, week.codexSessions) },
    { label: "Output", value: both(week.claudeOutput, week.codexOutput) },
    { label: "Usage limit hits", value: fmt(week.limitHits) },
    { label: "Opus share of Claude output", value: fmt(week.opusShare, "%") },
    { label: "Codex weekly window used", value: fmt(week.codexWindow, "%") },
  ];
}

/** The one line naming the situation. */
export function situationLine(week: Week): string {
  return situationOf(week) === "running out" ? "Your week looks like running out before the end of the week." : "Your week looks like leaving most of it unused.";
}
