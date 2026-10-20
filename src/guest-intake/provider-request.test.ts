// Provider requests from /guide/ (#guide-provider-roadmap): a public question with topic "provider-request". The email is
// optional for this topic only; the stored text carries a fixed server-side prefix so the operator can tell it apart in
// the existing question admin (CLI `show`, /backstage/questions/?id=<id>).
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../backstage/server.ts";
import { checkPublicSubmission, PROVIDER_REQUEST_PREFIX, PROVIDER_REQUEST_TOPIC } from "./contract.ts";
import { renderAdminDetail } from "./admin-page.ts";
import { QuestionStore } from "./store.ts";

const ORIGIN = "http://localhost:3457";
const SITE = join(import.meta.dir, "..", "..", "site");
const KEY = "p".repeat(43);

let handlers: ReturnType<typeof createHandler>[] = [];
afterEach(() => {
  for (const h of handlers) h.close();
  handlers = [];
});

function setup(): { readonly handler: ReturnType<typeof createHandler>; readonly path: string } {
  const path = join(mkdtempSync(join(tmpdir(), "provider-request-")), "tickets.sqlite");
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: SITE, tickets: { path }, log: () => {}, questions: { limiterCapacity: 1000 } });
  handlers.push(handler);
  return { handler, path };
}

function post(data: unknown): [Request, { remoteAddress: string }] {
  return [new Request(`${ORIGIN}/api/questions`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(data) }), { remoteAddress: "203.0.113.40" }];
}

const request = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  topic: PROVIDER_REQUEST_TOPIC,
  question: "Wanted: xAI (Grok)\nUse: map my Grok CLI usage next to Claude Code",
  reply_consent: true,
  request_key: KEY,
  nickname: "",
  ...extra,
});

describe("provider request contract", () => {
  test("[unit] PR-1 a provider request needs no email and its text gets the fixed prefix", () => {
    const checked = checkPublicSubmission(request());
    expect(checked).toEqual({ ok: true, submission: { email: null, question: `${PROVIDER_REQUEST_PREFIX}Wanted: xAI (Grok)\nUse: map my Grok CLI usage next to Claude Code`, replyConsent: true, marketingConsent: false, requestKey: KEY } });
    const blank = checkPublicSubmission(request({ email: "  " }));
    expect(blank.ok && "submission" in blank ? blank.submission.email : "x").toBeNull();
  });

  test("[unit] PR-2 a provider request with an email keeps it, lowercased; a malformed one is refused", () => {
    const checked = checkPublicSubmission(request({ email: "David@Example.test" }));
    expect(checked.ok && "submission" in checked ? checked.submission.email : null).toBe("david@example.test");
    expect(checked.ok && "submission" in checked ? checked.submission.question.startsWith(PROVIDER_REQUEST_PREFIX) : false).toBe(true);
    expect(checkPublicSubmission(request({ email: "nope" }))).toEqual({ ok: false, reason: "bad-email" });
  });

  test("[unit] PR-3 an unknown topic is refused, and a plain question still needs an email and is not prefixed", () => {
    expect(checkPublicSubmission(request({ topic: "other" }))).toEqual({ ok: false, reason: "bad-topic" });
    expect(checkPublicSubmission(request({ topic: 1 }))).toEqual({ ok: false, reason: "bad-topic" });
    const plain = { question: "Route stock questions?", reply_consent: true, request_key: KEY };
    expect(checkPublicSubmission(plain)).toEqual({ ok: false, reason: "bad-email" });
    const withEmail = checkPublicSubmission({ ...plain, email: "a@example.test" });
    expect(withEmail.ok && "submission" in withEmail ? withEmail.submission.question : "").toBe("Route stock questions?");
  });

  test("[unit] PR-4 consent is still required and an empty request is refused", () => {
    expect(checkPublicSubmission(request({ reply_consent: false }))).toEqual({ ok: false, reason: "no-consent" });
    expect(checkPublicSubmission(request({ question: "   " }))).toEqual({ ok: false, reason: "bad-question" });
  });
});

describe("provider request route", () => {
  test("[integration] PR-5 POST /api/questions stores the request and returns a reference and status code", async () => {
    const { handler, path } = setup();
    const res = await handler(...post(request()));
    expect(res.status).toBe(200);
    const out: unknown = await res.json();
    if (typeof out !== "object" || out === null || !("id" in out) || typeof out.id !== "string") throw new Error("no id");
    expect(out.id).toMatch(/^Q-[0-9A-F]{12}$/);
    expect(Reflect.get(out, "status_code")).toBe(`${out.id}.${KEY}`);
    const store = new QuestionStore(path);
    const row = store.show(out.id);
    store.close();
    expect(row?.scope).toBe("public");
    expect(row?.email).toBeNull();
    expect(row?.state).toBe("pending_review");
    expect(row?.question).toBe(`${PROVIDER_REQUEST_PREFIX}Wanted: xAI (Grok)\nUse: map my Grok CLI usage next to Claude Code`);
  });

  test("[integration] PR-6 the operator detail page shows the request and says no email was given", async () => {
    const { handler, path } = setup();
    const res = await handler(...post(request()));
    const out: unknown = await res.json();
    const id = typeof out === "object" && out !== null && "id" in out && typeof out.id === "string" ? out.id : "";
    const store = new QuestionStore(path);
    const row = store.show(id);
    store.close();
    if (row === null) throw new Error("row missing");
    const html = await renderAdminDetail(row).text();
    expect(html).toContain("[Provider request] Wanted: xAI (Grok)");
    expect(html).toContain("<dt>Email</dt><dd>none given</dd>");
  });
});
