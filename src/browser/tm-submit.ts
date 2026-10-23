// /tm/ Submit: turns the parsed TOKENMAX WEEK block into the tm-share/1 body that POST /api/maps takes
// (contract: src/backstage/maps.ts). Pure functions, no network: tm-run.ts sends the result when the visitor presses Submit.
// Nothing is guessed: a required line that is not recorded, or a number the contract cannot hold, refuses the submit
// with a message that names the line. The only values this file supplies itself are the fixed ones below, and 0 for the
// output (and Opus share) of a tool whose session count is 0.

import type { MapPayload, MapSources } from "../backstage/maps.ts";
import { labelValue, LABELS, MAX_PERIOD_DAYS, periodDays, type Week } from "./tm-week.ts";

/** The tm-share/1 `skill` field is a version string. "0.0.0" means "a pasted block, not the mapper script". */
export const PASTED_SKILL = "0.0.0";
export const MAX_DAYS = MAX_PERIOD_DAYS;
/** Same pattern as the server's ALIAS in src/backstage/maps.ts. */
export const ALIAS_PATTERN = /^[a-z0-9-]{3,24}$/;
/**
 * What a visitor typed, made to fit ALIAS_PATTERN where it can: lowercase, each run of characters outside a-z and 0-9
 * (spaces, symbols, accents, existing hyphens) becomes one hyphen, then leading and trailing hyphens are dropped.
 * Length is not touched: a result shorter than 3 or longer than 24 still fails ALIAS_PATTERN and is refused, never truncated.
 */
export function normaliseAlias(typed: string): string {
  return typed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
export const ALIAS_MESSAGE = "Choose a nickname that is 3 to 24 letters, digits or hyphens once spaces and symbols are turned into hyphens.";
const KEY_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const KEY_LENGTH = 32;

export type SubmitBody = {
  readonly payload: MapPayload;
  readonly alias: string;
  readonly request_key: string;
};
export type Mapped = { readonly ok: true; readonly payload: MapPayload } | { readonly ok: false; readonly message: string };

/** Refuse numbers the tolerant display parser would silently reinterpret before Submit. */
export function rawNumberProblem(text: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const pair = labelValue(raw);
    if (!pair) continue;
    const field = LABELS[pair[0]];
    if (field === undefined || field === "period" || field === "pattern" || field === "perDay" || field === "limitDays") continue;
    const value = pair[1].trim();
    // Anything the display reader treats as "no number" (not recorded, N/A, a note without digits) is not this check's business.
    if (/not recorded/i.test(value) || !/\d/.test(value)) continue;
    const percent = field === "opusShare" || field === "codexWindow" ? "(?:\\s*%)?" : "";
    // A digit run past the safe-integer range would reach weekToPayload as null and could be sent as an unused tool's 0 (#359).
    const digits = value.replace(/[^\d]/g, "");
    if (new RegExp(`^(?:\\d+|\\d{1,3}(?:,\\d{3})+)${percent}\\.?$`).test(value) && Number.isSafeInteger(Number(digits))) continue;
    const label = pair[0].charAt(0).toUpperCase() + pair[0].slice(1);
    return `Not submitted: ${label} must be a plain whole number like 1,234, not "${value.slice(0, 40)}". Run the prompt again and paste the whole result.`;
  }
  return null;
}

/** 32 characters from [A-Za-z0-9_-]. The key is the idempotency key and the delete secret. */
export function newRequestKey(random: (bytes: Uint8Array) => Uint8Array): string {
  const bytes = random(new Uint8Array(KEY_LENGTH));
  let key = "";
  // 64 characters and a 6-bit mask: every character is equally likely.
  for (const b of bytes) key += KEY_CHARS.charAt(b & 63);
  return key;
}

/** Whole days from Period start to Period end, both included (the reader's own count, so Submit and the page agree). */
export { periodDays };

type Line = { readonly label: string; readonly value: number | null };

/**
 * The tm-share/1 payload for a parsed block, keys in contract order, or the reason it cannot be sent.
 * From the block: days (Period start to end inclusive), sources (which session counts are above 0), sessions (Claude plus
 * Codex), caps.unknown (Usage limit hits), output_tokens, opus_share_pct, codex_weekly_pct (null when not recorded).
 * Fixed here, because a pasted block does not carry them: skill "0.0.0"; subagent_sessions 0; caps.short 0 and
 * caps.weekly 0 (the block says how many limits were hit, not which kind, so every hit is counted as unknown); and 0 for
 * the output tokens (and Opus share) of a tool whose session count is 0 when the block says not recorded (#359).
 */
export function weekToPayload(week: Week): Mapped {
  // A tool with 0 sessions has 0 output, so its not-recorded output (and Claude's Opus share) is sent as 0 (#359).
  // A not-recorded session count is never defaulted.
  const { claudeSessions, codexSessions, limitHits } = week;
  const claudeOutput = week.claudeOutput ?? (claudeSessions === 0 ? 0 : null);
  const codexOutput = week.codexOutput ?? (codexSessions === 0 ? 0 : null);
  const opusShare = week.opusShare ?? (claudeSessions === 0 ? 0 : null);
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
  if (days === null) missing.unshift(week.period === null ? "Period" : "Period (two dates like 2026-10-14 to 2026-10-20)");
  if (missing.length > 0) {
    const tools = ["Claude", "Codex"].filter((tool) => missing.some((label) => label === `${tool} sessions` || label === `${tool} output tokens`));
    const hint = tools.length > 0
      ? ` Submit needs a number on every one of these lines. ${tools.map((tool) => `If you did not use ${tool}, change its lines to 0 in the box.`).join(" ")} Otherwise run the prompt again and paste the whole result. If your assistant still cannot recover a tool you used, this week cannot be posted.`
      : " Run the prompt again and paste the whole result.";
    return { ok: false, message: `Not submitted: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not recorded in your result.${hint}` };
  }
  if (days === null || claudeSessions === null || codexSessions === null || claudeOutput === null || codexOutput === null || opusShare === null || limitHits === null)
    return { ok: false, message: "Not submitted: the result is incomplete." };
  if (days > MAX_DAYS) return { ok: false, message: `Not submitted: the period is ${days} days; a submitted week covers 1 to ${MAX_DAYS} days.` };
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
