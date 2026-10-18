// Guest questions (#253, docs/product/guest-intake.md): the submission contract, the state model and the derived keys.
// Pure: no storage, no network, no provider. A question is untrusted text; nothing here reads it as an instruction.
import { createHash } from "node:crypto";
import { EMAIL } from "../backstage/tickets.ts";

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

/** One submission after validation. `email` is null for a guest, whose principal is the token. */
export interface Submission {
  readonly email: string | null;
  readonly question: string;
  readonly replyConsent: boolean;
  readonly marketingConsent: boolean;
  readonly requestKey: string;
}

export type SubmissionRejectReason = "bad-body" | "unknown-field" | "bad-email" | "bad-question" | "no-consent" | "bad-consent" | "bad-request-key";
export type SubmissionCheck =
  | { readonly ok: true; readonly submission: Submission }
  | { readonly ok: true; readonly trap: true }
  | { readonly ok: false; readonly reason: SubmissionRejectReason };

const PUBLIC_KEYS: readonly string[] = ["email", "question", "reply_consent", "marketing_consent", "request_key", "nickname"];
export const REQUEST_KEY = /^[A-Za-z0-9_-]{43}$/;
export const QUESTION_ID = /^Q-[0-9A-F]{12}$/;
// C0 controls other than tab and newline, DEL, and C1 controls.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

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

/** Validate a decoded `POST /api/questions` body. A filled honeypot (`nickname`) is accepted and never stored. */
export function checkPublicSubmission(body: unknown, limits: QuestionLimits = QUESTION_LIMITS): SubmissionCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, reason: "bad-body" };
  if (Object.keys(body).some((k) => !PUBLIC_KEYS.includes(k))) return { ok: false, reason: "unknown-field" };
  const trap = own(body, "nickname");
  if (typeof trap === "string" && trap.trim() !== "") return { ok: true, trap: true };
  if (trap !== undefined && typeof trap !== "string") return { ok: false, reason: "bad-body" };
  const rawEmail = own(body, "email");
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email === "" || email.length > 254 || !EMAIL.test(email)) return { ok: false, reason: "bad-email" };
  const text = question(own(body, "question"), limits.maxQuestionChars);
  if (text === null) return { ok: false, reason: "bad-question" };
  if (own(body, "reply_consent") !== true) return { ok: false, reason: "no-consent" };
  const marketing = own(body, "marketing_consent");
  if (marketing !== undefined && typeof marketing !== "boolean") return { ok: false, reason: "bad-consent" };
  const key = own(body, "request_key");
  if (typeof key !== "string" || !REQUEST_KEY.test(key)) return { ok: false, reason: "bad-request-key" };
  return { ok: true, submission: { email, question: text, replyConsent: true, marketingConsent: marketing === true, requestKey: key } };
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

/** Covers the server-set scope and the full normalized payload, so any changed field under one key is a conflict. */
export function requestHash(scope: string, email: string | null, text: string, reply: boolean, marketing: boolean): string {
  return sha256(JSON.stringify([scope, email, normalizeQuestion(text), reply, marketing]));
}

/** The status capability's verifier. Removed with the row. */
export function keyHash(key: string): string {
  return sha256(key);
}

/** The anti-replay tag: stored on the live row at submit and moved to the tombstone on delete; not a capability verifier. */
export function keyTag(scope: string, key: string): string {
  return sha256(`tombstone\0${scope}\0${key}`);
}
