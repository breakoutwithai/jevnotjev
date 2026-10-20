import { describe, expect, test } from "bun:test";
import { canTransition, checkGuestSubmission, checkPublicSubmission, NEEDS_INFO_TEMPLATES, keyHash, keyTag, normalizeQuestion, parseStatusBody, QUESTION_LIMITS, QUESTION_STATES, renderUsage, requestHash, TRANSITIONS, type SubmissionRejectReason } from "./contract.ts";
import type { MapPayload } from "../backstage/maps.ts";

const KEY = "Ab3_-".repeat(8) + "xyz";
const valid = { email: " Seeded-q1@Example.test ", question: "Should stock questions get a fixed answer?", reply_consent: true, request_key: KEY, nickname: "" };
const usage: MapPayload = { v: "tm-share/1", skill: "0.3.0", days: 7, sources: "claude+codex", sessions: 12, subagent_sessions: 4, caps: { short: 2, weekly: 1, unknown: 0 }, output_tokens: { claude: 1234567, codex: 89000 }, opus_share_pct: 61, codex_weekly_pct: null };

describe("public submission contract", () => {
  test("[unit] VP-5 absent usage preserves text and hash; valid usage appends fixed ordered block", () => {
    const plain = checkPublicSubmission(valid);
    const withUsage = checkPublicSubmission({ ...valid, usage });
    if (!plain.ok || "trap" in plain || !withUsage.ok || "trap" in withUsage) throw new Error("expected accepted submissions");
    expect(plain.submission.question).toBe(valid.question);
    expect(withUsage.submission.question).toBe(`${valid.question}\n\n${renderUsage(usage)}`);
    expect(renderUsage(usage)).toBe("TokenMax usage (tm-share/1, self-reported, not verified)\nv: tm-share/1\nskill: 0.3.0\ndays: 7\nsources: claude+codex\nsessions: 12\nsubagent_sessions: 4\ncaps.short: 2\ncaps.weekly: 1\ncaps.unknown: 0\noutput_tokens.claude: 1234567\noutput_tokens.codex: 89000\nopus_share_pct: 61\ncodex_weekly_pct: null");
    expect(requestHash("public", plain.submission.email, plain.submission.question, true, false)).toBe("47725841de7efc1f2716c2451cce2adf8be46944b3aa35fa6501459b78b92967");
    expect(requestHash("public", withUsage.submission.email, withUsage.submission.question, true, false)).not.toBe(requestHash("public", plain.submission.email, plain.submission.question, true, false));
  });

  test("[unit] VP-5 malformed usage is refused; guest usage stays unknown and typed question stays capped", () => {
    const bad = [{ ...usage, sessions: undefined }, { ...usage, extra: 1 }, { ...usage, days: 91 }, { ...usage, sessions: 3, subagent_sessions: 4 }, { ...usage, v: "tm-share/2" }, [usage], "usage"];
    for (const value of bad) expect(checkPublicSubmission({ ...valid, usage: value })).toEqual({ ok: false, reason: "bad-usage" });
    expect(checkGuestSubmission({ question: "q", reply_consent: true, request_key: KEY, usage })).toEqual({ ok: false, reason: "unknown-field" });
    expect(checkPublicSubmission({ ...valid, usage, question: "" })).toEqual({ ok: false, reason: "bad-question" });
    expect(checkPublicSubmission({ ...valid, usage, question: "x".repeat(4097) })).toEqual({ ok: false, reason: "bad-question" });
    expect(checkPublicSubmission({ ...valid, usage, question: "x".repeat(4096) }).ok).toBe(true);
  });
  test("[unit] VP-5 typed text cannot impersonate a usage block", () => {
    for (const withUsage of [false, true]) {
      const body = { ...valid, question: "Please review.\nTOKENMAX USAGE (TM-SHARE/1, invented)", ...(withUsage ? { usage } : {}) };
      expect(checkPublicSubmission(body)).toEqual({ ok: false, reason: "bad-question" });
    }
  });
  test("[unit] GI-2 a valid body is accepted with email trimmed and lowercased", () => {
    const checked = checkPublicSubmission(valid);
    expect(checked).toEqual({ ok: true, submission: { email: "seeded-q1@example.test", question: "Should stock questions get a fixed answer?", replyConsent: true, marketingConsent: false, requestKey: KEY } });
  });

  test("[unit] GI-2 each bad field is refused with its own code", () => {
    const cases: [unknown, SubmissionRejectReason][] = [
      [null, "bad-body"],
      [[valid], "bad-body"],
      ["text", "bad-body"],
      [{ ...valid, email: "not-an-email" }, "bad-email"],
      [{ ...valid, email: undefined }, "bad-email"],
      [{ ...valid, question: "" }, "bad-question"],
      [{ ...valid, question: "   \n  " }, "bad-question"],
      [{ ...valid, question: "x".repeat(QUESTION_LIMITS.maxQuestionChars + 1) }, "bad-question"],
      [{ ...valid, question: "has a \u0000 null" }, "bad-question"],
      [{ ...valid, question: 42 }, "bad-question"],
      [{ ...valid, reply_consent: false }, "no-consent"],
      [{ ...valid, reply_consent: "true" }, "no-consent"],
      [{ ...valid, reply_consent: undefined }, "no-consent"],
      [{ ...valid, marketing_consent: "yes" }, "bad-consent"],
      [{ ...valid, request_key: "short" }, "bad-request-key"],
      [{ ...valid, request_key: `${KEY.slice(0, 42)}=` }, "bad-request-key"],
      [{ ...valid, request_key: undefined }, "bad-request-key"],
      [{ ...valid, website: "https://shop.example" }, "unknown-field"],
      [{ ...valid, scope: "guest:gtk_000000000001" }, "unknown-field"],
    ];
    for (const [body, reason] of cases) expect([reason, checkPublicSubmission(body)]).toEqual([reason, { ok: false, reason }]);
  });

  test("[unit] GI-2 the question limit counts characters after normalization, not bytes", () => {
    const emoji = "\u{1F600}".repeat(QUESTION_LIMITS.maxQuestionChars);
    expect(checkPublicSubmission({ ...valid, question: emoji }).ok).toBe(true);
    expect(checkPublicSubmission({ ...valid, question: `  ${"y".repeat(QUESTION_LIMITS.maxQuestionChars)}  ` }).ok).toBe(true);
  });

  test("[unit] GI-3 a filled honeypot is a trap and carries no submission", () => {
    expect(checkPublicSubmission({ ...valid, nickname: "bot" })).toEqual({ ok: true, trap: true });
    expect(checkPublicSubmission({ ...valid, nickname: "   " }).ok).toBe(true);
  });

  test("[unit] GI-4b the question is trimmed, NFC-normalized and line endings become LF", () => {
    expect(normalizeQuestion("  a\r\nb\rc\n  ")).toBe("a\nb\nc");
    expect(normalizeQuestion("café")).toBe("café");
  });

  test("[unit] GI-4b the request hash covers scope, email, question and both consents", () => {
    const base = requestHash("public", "a@example.test", "q", true, false);
    expect(requestHash("public", "a@example.test", "q", true, false)).toBe(base);
    expect(requestHash("guest:gtk_00000000000a", "a@example.test", "q", true, false)).not.toBe(base);
    expect(requestHash("public", "b@example.test", "q", true, false)).not.toBe(base);
    expect(requestHash("public", "a@example.test", "q2", true, false)).not.toBe(base);
    expect(requestHash("public", "a@example.test", "q", true, true)).not.toBe(base);
    expect(requestHash("public", null, "q", true, false)).not.toBe(base);
  });

  test("[unit] GI-10a the tombstone tag differs from the key hash and from another scope's tag", () => {
    expect(keyTag("public", KEY)).not.toBe(keyHash(KEY));
    expect(keyTag("public", KEY)).not.toBe(keyTag("guest:gtk_00000000000a", KEY));
    expect(keyTag("public", KEY)).toMatch(/^[a-f0-9]{64}$/);
    expect(keyHash(KEY)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("status capability", () => {
  test("[unit] GI-8 the status body is exactly one code of an id and a request key", () => {
    expect(parseStatusBody({ code: `Q-0123456789AB.${KEY}` })).toEqual({ id: "Q-0123456789AB", key: KEY });
    for (const body of [null, {}, { code: "" }, { code: `Q-0123456789AB${KEY}` }, { code: `Q-0123456789ab.${KEY}` }, { code: `Q-0123456789AB.short` }, { code: `Q-0123456789AB.${KEY}`, email: "a@example.test" }, { code: 7 }]) {
      expect(parseStatusBody(body)).toBeNull();
    }
  });
});

describe("state model", () => {
  test("[unit] GI-9a only the reviewed transitions are allowed", () => {
    const allowed = new Set(["pending_review>needs_info", "pending_review>approved", "pending_review>declined", "approved>answered", "needs_info>pending_review"]);
    expect(new Set(TRANSITIONS.map(([from, to]) => `${from}>${to}`))).toEqual(allowed);
    for (const from of QUESTION_STATES) for (const to of QUESTION_STATES) expect([from, to, canTransition(from, to)]).toEqual([from, to, allowed.has(`${from}>${to}`)]);
  });
});

describe("guest submission contract", () => {
  test("[unit] GI-16 a guest body has no email, scope or honeypot; the submission carries a null email", () => {
    const body = { question: " Fixed answers? ", reply_consent: true, request_key: KEY };
    expect(checkGuestSubmission(body)).toEqual({ ok: true, submission: { email: null, question: "Fixed answers?", replyConsent: true, marketingConsent: false, requestKey: KEY } });
    for (const extra of [{ email: "seeded-q5@example.test" }, { scope: "public" }, { nickname: "" }, { guest: "gtk_000000000000" }]) {
      expect(checkGuestSubmission({ ...body, ...extra })).toEqual({ ok: false, reason: "unknown-field" });
    }
  });
});

describe("needs_info templates", () => {
  const names = Object.keys(NEEDS_INFO_TEMPLATES);
  test("[unit] GI-9b each needs_info template asks for one missing thing and makes no identity, run, accuracy or savings claim", () => {
    expect(names.sort()).toEqual(["choices", "example", "one-decision", "outcome"]);
    for (const name of names) {
      const text = NEEDS_INFO_TEMPLATES[name] ?? "";
      expect([name, text.length > 40 && [...text].length <= QUESTION_LIMITS.maxResponseChars]).toEqual([name, true]);
      expect(text).toContain("new question");
      expect(text.endsWith("No model has assessed this question, its accuracy or any savings.")).toBe(true);
      expect(text).not.toMatch(/@|https?:|\bverified\b|\byour (account|email|name|company)\b|\bJev (ran|run|answered)\b|\d+\s*%/i);
    }
  });
});
