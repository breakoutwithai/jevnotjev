import { describe, expect, test } from "bun:test";
import { canTransition, checkPublicSubmission, keyHash, keyTag, normalizeQuestion, parseStatusBody, QUESTION_LIMITS, QUESTION_STATES, requestHash, TRANSITIONS, type SubmissionRejectReason } from "./contract.ts";

const KEY = "Ab3_-".repeat(8) + "xyz";
const valid = { email: " Seeded-q1@Example.test ", question: "Should stock questions get a fixed answer?", reply_consent: true, request_key: KEY, nickname: "" };

describe("public submission contract", () => {
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
