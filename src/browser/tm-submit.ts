// /tm/ Submit: turns the parsed TOKENMAX WEEK block into the tm-share/1 body that POST /api/maps takes
// (contract: src/backstage/maps.ts). Pure functions, no network: tm-run.ts sends the result when the visitor presses Submit.
// Nothing is guessed: a required line that is not recorded, or a number the contract cannot hold, refuses the submit
// with a message that names the line. The only values this file supplies itself are the fixed ones below.

import type { MapPayload, MapSources } from "../backstage/maps.ts";
import { readDate, type NumberField, type Week } from "./tm-week.ts";

/** The tm-share/1 `skill` field is a version string. "0.0.0" means "a pasted block, not the mapper script". */
export const PASTED_SKILL = "0.0.0";
/** Same pattern as the server's ALIAS in src/backstage/maps.ts. */
export const ALIAS_PATTERN = /^[a-z0-9-]{3,24}$/;
export const ALIAS_MESSAGE = "Choose a nickname of 3 to 24 lowercase letters, digits or hyphens.";
const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const KEY_LENGTH = 32;
const DAY_MS = 86_400_000;

export type SubmitBody = {
  readonly payload: MapPayload;
  readonly alias: string;
  readonly request_key: string;
};
export type Mapped = { readonly ok: true; readonly payload: MapPayload } | { readonly ok: false; readonly message: string };

/** 32 characters from [A-Za-z0-9_-]. The key is the idempotency key and the delete secret. */
export function newRequestKey(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(KEY_LENGTH));
  let key = "";
  // 64 characters and a 6-bit mask: every character is equally likely.
  for (const b of bytes) key += KEY_CHARS.charAt(b & 63);
  return key;
}

/** Whole days from Period start to Period end, both included; null when either is not a real YYYY-MM-DD date or end is before start. */
export function periodDays(week: Week): number | null {
  const start = week.period ? readDate(week.period.start) : null;
  const end = week.period ? readDate(week.period.end) : null;
  if (!start || !end) return null;
  const span = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS;
  return span >= 0 ? span + 1 : null;
}

type Line = { readonly label: string; readonly value: number | null };

/**
 * The tm-share/1 payload for a parsed block, keys in contract order, or the reason it cannot be sent.
 * From the block: days (Period start to end inclusive), sources (which session counts are above 0), sessions (Claude plus
 * Codex), caps.unknown (Usage limit hits), output_tokens, opus_share_pct, codex_weekly_pct (null when not recorded).
 * Fixed here, because a pasted block does not carry them: skill "0.0.0"; subagent_sessions 0; caps.short 0 and
 * caps.weekly 0 (the block says how many limits were hit, not which kind, so every hit is counted as unknown).
 */
export function weekToPayload(week: Week): Mapped {
  // A visitor who uses only one tool gets "not recorded" for the other tool's lines (#344). When exactly one tool has a
  // session count and the other tool's lines are all "not recorded", the absent tool is 0: sources names the tool that
  // has data, and the contract needs a number for its output tokens (and, for Codex-only, for the Opus share), so 0.
  // "All not recorded" means each line said exactly that: an omitted or unreadable line is refused, and a Codex weekly
  // window reading means Codex was used, so it is not absent.
  const said = (...fields: readonly NumberField[]): boolean => fields.every((f) => week.notRecorded?.includes(f) === true);
  const claudeAbsent = said("claudeSessions", "claudeOutput", "opusShare") && week.codexSessions !== null;
  const codexAbsent = said("codexSessions", "codexOutput", "codexWindow") &&week.claudeSessions !== null;
  if (week.claudeSessions === null && week.codexSessions === null)
    return { ok: false, message: "Not submitted: Claude sessions and Codex sessions are both not recorded in your result, so there is no week to show. Use Claude Code or Codex on this machine, then run the prompt and paste the whole result." };
  const claudeSessions = claudeAbsent ? 0 : week.claudeSessions;
  const claudeOutput = claudeAbsent ? 0 : week.claudeOutput;
  const opusShare = claudeAbsent ? 0 : week.opusShare;
  const codexSessions = codexAbsent ? 0 : week.codexSessions;
  const codexOutput = codexAbsent ? 0 : week.codexOutput;
  const limitHits = week.limitHits;
  const required: readonly Line[] = [
    { label: "Claude sessions", value: claudeSessions },
    { label: "Codex sessions", value: codexSessions },
    { label: "Claude output tokens", value: claudeOutput },
    { label: "Codex output tokens", value: codexOutput },
    { label: "Opus share of Claude output", value: opusShare },
    { label: "Usage limit hits", value: limitHits },
  ];
  const missing = required.filter((r) => r.value === null).map((r) => r.label);
  const days = periodDays(week);
  if (days === null) missing.unshift(week.period === null ? "Period" : "Period (two dates like 2026-10-14 to 2026-10-21)");
  if (missing.length > 0) return { ok: false, message: `Not submitted: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not recorded in your result. Run the prompt again and paste the whole result.` };
  if (days === null || claudeSessions === null || codexSessions === null || claudeOutput === null || codexOutput === null || opusShare === null || limitHits === null)
    return { ok: false, message: "Not submitted: the result is incomplete." };
  if (days > 90) return { ok: false, message: `Not submitted: the period is ${days} days; a submitted week covers 1 to 90 days.` };
  for (const r of required)
    if (r.value !== null && (!Number.isSafeInteger(r.value) || r.value < 0)) return { ok: false, message: `Not submitted: ${r.label} must be a whole number, not ${r.value}.` };
  const codexWeekly = week.codexWindow;
  if (codexWeekly !== null && (!Number.isSafeInteger(codexWeekly) || codexWeekly < 0)) return { ok: false, message: `Not submitted: Codex weekly window used must be a whole number, not ${codexWeekly}.` };
  const sources: MapSources | null = claudeSessions > 0 && codexSessions > 0 ? "claude+codex" : claudeSessions > 0 ? "claude" : codexSessions > 0 ? "codex" : null;
  if (sources === null) return { ok: false, message: "Not submitted: both session counts are 0, so there is no week to show." };
  return {
    ok: true,
    payload: {
      v: "tm-share/1",
      skill: PASTED_SKILL,
      days,
      sources,
      sessions: claudeSessions + codexSessions,
      subagent_sessions: 0,
      caps: { short: 0, weekly: 0, unknown: limitHits },
      output_tokens: { claude: claudeOutput, codex: codexOutput },
      opus_share_pct: opusShare,
      codex_weekly_pct: codexWeekly,
    },
  };
}

/** The POST /api/maps body, keys the server accepts: payload, alias, request_key. */
export function submitBody(payload: MapPayload, alias: string, requestKey: string): SubmitBody {
  return { payload, alias, request_key: requestKey };
}

/** The sentence for a rejected submit, from the server's code, field and reason (see the reject calls in src/backstage/server.ts). */
export function rejectionMessage(status: number, body: unknown): string {
  const field = typeof body === "object" && body !== null && "field" in body && typeof body.field === "string" ? body.field : "";
  const reason = typeof body === "object" && body !== null && "reason" in body && typeof body.reason === "string" ? body.reason : "";
  const code = typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" ? body.code : "";
  if (reason) return `Not submitted: ${field ? `${field} ` : ""}${reason}.`;
  const known: Readonly<Record<string, string>> = {
    "rate-limited": "too many requests from this network, try again later",
    "maps-unavailable": "the board is not available right now",
    "maps-full": "the board is full",
    "too-large": "the request was too large",
    "request-key-reused": "this attempt was already used for different details; press Submit again for a new attempt",
  };
  return `Not submitted: ${known[code] ?? (code || `the server answered ${status}`)}.`;
}
