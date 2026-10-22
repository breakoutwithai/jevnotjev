// Guest questions (#253, docs/product/guest-intake.md): the submission contract, the state model and the derived keys.
// Pure: no storage, no network, no provider. A question is untrusted text; nothing here reads it as an instruction.
import { createHash } from "node:crypto";
import { EMAIL } from "../backstage/tickets.ts";
import { checkSharePayload, type MapPayload } from "../backstage/maps.ts";

/** Public submit body cap (bytes); nginx `location = /api/questions` matches it (16k). */
export const MAX_QUESTION_BODY = 16_384;
/** Status lookup body cap (bytes); nginx `location = /api/questions/status` matches it (1k). */
export const MAX_STATUS_BODY = 1_024;

export type QuestionState = "pending_review" | "needs_info" | "approved" | "declined" | "answered";
export const QUESTION_STATES: readonly QuestionState[] = ["pending_review", "needs_info", "approved", "declined", "answered"];

/** The reviewed transitions. `needs_info -> pending_review` is the operator's, after the information arrived elsewhere. */
export const TRANSITIONS: readonly (readonly [QuestionState, QuestionState])[] = [
  ["pending_review", "needs_info"],
  ["pending_review", "approved"],
  ["pending_review", "declined"],
  ["approved", "answered"],
  ["needs_info", "pending_review"],
];

export function canTransition(from: QuestionState, to: QuestionState): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function isQuestionState(value: unknown): value is QuestionState {
  return typeof value === "string" && QUESTION_STATES.some((s) => s === value);
}

export type ResponseSource = "human_reviewed" | "template";
export function isResponseSource(value: unknown): value is ResponseSource {
  return value === "human_reviewed" || value === "template";
}

const NEEDS_INFO_FOOTER = " No model has assessed this question, its accuracy or any savings.";

/**
 * Generic needs_info notes for `transition <id> needs_info --template <name>` (stored with source `template`). Each asks
 * for one missing thing, names no person, account or address, and claims no run, accuracy or savings. The submitter
 * answers with a new question; the operator moves the row back to pending_review once it arrives.
 */
export const NEEDS_INFO_TEMPLATES: Readonly<Record<string, string>> = Object.freeze({
  choices: "Please send the fixed answers this decision may return (for example: stock help or general help) as a new question that starts with your reference." + NEEDS_INFO_FOOTER,
  example: "Please send one or two made-up example cases, each with the answer you would expect, as a new question that starts with your reference. Do not include real customer, staff or personal data." + NEEDS_INFO_FOOTER,
  outcome: "Please say what you will do differently once this decision is made, and how you would tell it went well, as a new question that starts with your reference." + NEEDS_INFO_FOOTER,
  "one-decision": "This reads as more than one decision. Please pick the one you want help with first and send it as a new question that starts with your reference." + NEEDS_INFO_FOOTER,
});

/** Proposed defaults, not approved policy (docs/product/guest-intake.md, Limits). */
export interface QuestionLimits {
  readonly maxQuestionChars: number;
  /** New public rows per window, all addresses together. Replays do not count. */
  readonly publicNewPerWindow: number;
  readonly publicWindowMs: number;
  /** New rows per guest token per UTC day. */
  readonly guestNewPerDay: number;
  /** Rows in every state plus tombstones. Checked at admission only. */
  readonly maxRetained: number;
  /** An operator message or reply. */
  readonly maxResponseChars: number;
}
export const QUESTION_LIMITS: QuestionLimits = {
  maxQuestionChars: 4096,
  publicNewPerWindow: 100,
  publicWindowMs: 10 * 60_000,
  guestNewPerDay: 10,
  maxRetained: 25_000,
  maxResponseChars: 8000,
};

/** A row is a question (/ask/, guest token) or visitor feedback (/feedback/); both share one store and admin view. */
export type SubmissionKind = "question" | "feedback";
export function isSubmissionKind(value: unknown): value is SubmissionKind {
  return value === "question" || value === "feedback";
}

/** One submission after validation. `email` is null for a guest, whose principal is the token, and optional for feedback. */
export interface Submission {
  /** Absent means question: every caller written before feedback existed. */
  readonly kind?: SubmissionKind;
  /** The page a feedback form was opened from (`?from=`), or null. Questions carry none. */
  readonly page?: string | null;
  readonly email: string | null;
  readonly question: string;
  readonly replyConsent: boolean;
  readonly marketingConsent: boolean;
  readonly requestKey: string;
}

export type SubmissionRejectReason = "bad-body" | "unknown-field" | "bad-email" | "bad-question" | "bad-usage" | "no-consent" | "bad-consent" | "bad-request-key" | "bad-kind" | "bad-page";
export type SubmissionCheck =
  | { readonly ok: true; readonly submission: Submission }
  | { readonly ok: true; readonly trap: true }
  | { readonly ok: false; readonly reason: SubmissionRejectReason };

const PUBLIC_KEYS: readonly string[] = ["email", "question", "reply_consent", "marketing_consent", "request_key", "nickname", "usage", "kind"];
const FEEDBACK_KEYS: readonly string[] = ["kind", "message", "email", "page", "request_key", "nickname"];
/** Longest `page` value: a short site section name such as home, guide or tm. */
export const FEEDBACK_PAGE_MAX = 40;
const PAGE = /^[a-z0-9][a-z0-9-]*$/;
export const REQUEST_KEY = /^[A-Za-z0-9_-]{43}$/;
export const QUESTION_ID = /^Q-[0-9A-F]{12}$/;
// C0 controls other than tab and newline, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
const TOKENMAX_USAGE_HEADER = /TokenMax usage \(tm-share\/1/i;

function own(body: object, name: string): unknown {
  return Object.prototype.hasOwnProperty.call(body, name) ? Reflect.get(body, name) : undefined;
}

/** Trimmed, NFC, with CRLF and CR as LF: the form the store keeps and the request hash covers. */
export function normalizeQuestion(text: string): string {
  return text.replace(/\r\n?/g, "\n").normalize("NFC").trim();
}

function question(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const text = normalizeQuestion(value);
  if (text === "" || [...text].length > limit || CONTROL.test(text)) return null;
  return text;
}

/** Stable plain-text usage block kept inside the reviewed question. */
export function renderUsage(payload: MapPayload): string {
  return [
    "TokenMax usage (tm-share/1, self-reported, not verified)",
    `v: ${payload.v}`,
    `skill: ${payload.skill}`,
    `days: ${payload.days}`,
    `sources: ${payload.sources}`,
    `sessions: ${payload.sessions}`,
    `subagent_sessions: ${payload.subagent_sessions}`,
    `caps.short: ${payload.caps.short}`,
    `caps.weekly: ${payload.caps.weekly}`,
    `caps.unknown: ${payload.caps.unknown}`,
    `output_tokens.claude: ${payload.output_tokens.claude}`,
    `output_tokens.codex: ${payload.output_tokens.codex}`,
    `opus_share_pct: ${payload.opus_share_pct}`,
    `codex_weekly_pct: ${payload.codex_weekly_pct === null ? "null" : payload.codex_weekly_pct}`,
  ].join("\n");
}

/** Validate a decoded `POST /api/questions` body. A filled honeypot (`nickname`) is accepted and never stored. */
export function checkPublicSubmission(body: unknown, limits: QuestionLimits = QUESTION_LIMITS): SubmissionCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "bad-body" };
  const kind = own(body, "kind");
  if (kind !== undefined && !isSubmissionKind(kind)) return { ok: false, reason: "bad-kind" };
  if (kind === "feedback") return checkFeedback(body, limits);
  if (Object.keys(body).some((k) => !PUBLIC_KEYS.includes(k))) return { ok: false, reason: "unknown-field" };
  const trap = own(body, "nickname");
  if (typeof trap === "string" && trap.trim() !== "") return { ok: true, trap: true };
  if (trap !== undefined && typeof trap !== "string") return { ok: false, reason: "bad-body" };
  const rawEmail = own(body, "email");
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email === "" || email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: "bad-email" };
  const text = question(own(body, "question"), limits.maxQuestionChars);
  if (text === null) return { ok: false, reason: "bad-question" };
  if (TOKENMAX_USAGE_HEADER.test(text)) return { ok: false, reason: "bad-question" };
  const rawUsage = own(body, "usage");
  const usage = Object.prototype.hasOwnProperty.call(body, "usage") ? checkSharePayload(rawUsage) : null;
  if (usage !== null && !usage.ok) return { ok: false, reason: "bad-usage" };
  if (own(body, "reply_consent") !== true) return { ok: false, reason: "no-consent" };
  const marketing = own(body, "marketing_consent");
  if (marketing !== undefined && typeof marketing !== "boolean") return { ok: false, reason: "bad-consent" };
  const key = own(body, "request_key");
  if (typeof key !== "string" || !REQUEST_KEY.test(key)) return { ok: false, reason: "bad-request-key" };
  return { ok: true, submission: { email, question: usage === null ? text : `${text}\n\n${renderUsage(usage.payload)}`, replyConsent: true, marketingConsent: marketing === true, requestKey: key } };
}

/**
 * A feedback body: `message` (required), optional `email` and `page`, a request key and the honeypot. No consent boxes:
 * no reply is shown on a page, and an email given is the visitor's own choice to be contactable (stored as replyConsent).
 */
function checkFeedback(body: object, limits: QuestionLimits): SubmissionCheck {
  if (Object.keys(body).some((k) => !FEEDBACK_KEYS.includes(k))) return { ok: false, reason: "unknown-field" };
  const trap = own(body, "nickname");
  if (typeof trap === "string" && trap.trim() !== "") return { ok: true, trap: true };
  if (trap !== undefined && typeof trap !== "string") return { ok: false, reason: "bad-body" };
  const text = question(own(body, "message"), limits.maxQuestionChars);
  if (text === null) return { ok: false, reason: "bad-question" };
  const rawEmail = own(body, "email");
  if (rawEmail !== undefined && typeof rawEmail !== "string") return { ok: false, reason: "bad-email" };
  const trimmed = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (trimmed !== "" && (trimmed.length > 254 || !EMAIL.test(trimmed))) return { ok: false, reason: "bad-email" };
  const rawPage = own(body, "page");
  if (rawPage !== undefined && (typeof rawPage !== "string" || rawPage.length > FEEDBACK_PAGE_MAX || (rawPage !== "" && !PAGE.test(rawPage)))) return { ok: false, reason: "bad-page" };
  const key = own(body, "request_key");
  if (typeof key !== "string" || !REQUEST_KEY.test(key)) return { ok: false, reason: "bad-request-key" };
  const email = trimmed === "" ? null : trimmed;
  const page = typeof rawPage === "string" && rawPage !== "" ? rawPage : null;
  return { ok: true, submission: { kind: "feedback", page, email, question: text, replyConsent: email !== null, marketingConsent: false, requestKey: key } };
}

const GUEST_KEYS: readonly string[] = ["question", "reply_consent", "marketing_consent", "request_key"];

/** Validate a decoded `POST /api/v1/guest/questions` body. No email, scope, guest or honeypot field: the token is the principal. */
export function checkGuestSubmission(body: unknown, limits: QuestionLimits = QUESTION_LIMITS): SubmissionCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "bad-body" };
  if (Object.keys(body).some((k) => !GUEST_KEYS.includes(k))) return { ok: false, reason: "unknown-field" };
  const text = question(own(body, "question"), limits.maxQuestionChars);
  if (text === null) return { ok: false, reason: "bad-question" };
  if (TOKENMAX_USAGE_HEADER.test(text)) return { ok: false, reason: "bad-question" };
  if (own(body, "reply_consent") !== true) return { ok: false, reason: "no-consent" };
  const marketing = own(body, "marketing_consent");
  if (marketing !== undefined && typeof marketing !== "boolean") return { ok: false, reason: "bad-consent" };
  const key = own(body, "request_key");
  if (typeof key !== "string" || !REQUEST_KEY.test(key)) return { ok: false, reason: "bad-request-key" };
  return { ok: true, submission: { email: null, question: text, replyConsent: true, marketingConsent: marketing === true, requestKey: key } };
}

/** `{ "code": "<id>.<request_key>" }` and nothing else, or null. */
export function parseStatusBody(body: unknown): { readonly id: string; readonly key: string } | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "code") return null;
  const code = own(body, "code");
  if (typeof code !== "string") return null;
  const dot = code.indexOf(".");
  const id = code.slice(0, dot);
  const key = code.slice(dot + 1);
  return dot > 0 && QUESTION_ID.test(id) && REQUEST_KEY.test(key) ? { id, key } : null;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Covers the server-set scope and the full normalized payload, so any changed field under one key is a conflict. A
 * question hashes exactly as before feedback existed, so rows stored then still replay; feedback adds its kind and page.
 */
export function requestHash(scope: string, email: string | null, text: string, reply: boolean, marketing: boolean, feedbackPage?: string | null): string {
  const fields: unknown[] = [scope, email, normalizeQuestion(text), reply, marketing];
  if (feedbackPage !== undefined) fields.push("feedback", feedbackPage);
  return sha256(JSON.stringify(fields));
}

/** The status capability's verifier. Removed with the row. */
export function keyHash(key: string): string {
  return sha256(key);
}

/** The anti-replay tag: stored on the live row at submit and moved to the tombstone on delete; not a capability verifier. */
export function keyTag(scope: string, key: string): string {
  return sha256(`tombstone\0${scope}\0${key}`);
}
