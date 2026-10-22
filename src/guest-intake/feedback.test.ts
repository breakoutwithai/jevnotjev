// Visitor feedback (/feedback/): stored as kind=feedback rows in the same question store, so it reaches the operator's
// existing admin list, API and MCP tools. Every test runs the real contract, store, server handler and admin code.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "../backstage/server.ts";
import { createAdminApi, ADMIN_QUESTIONS_PATH } from "./admin-api.ts";
import { runQuestionAdmin } from "./admin-cli.ts";
import { renderAdminList } from "./admin-page.ts";
import { checkPublicSubmission, FEEDBACK_PAGE_MAX, type Submission } from "./contract.ts";
import type { AdminPrincipal } from "./tokens.ts";
import { QuestionStore } from "./store.ts";

const ORIGIN = "http://localhost:3456";
const SITE = join(import.meta.dir, "..", "..", "site");
const NOW = Date.parse("2026-10-22T10:00:00.000Z");
const MARKER = "zq-feedback-marker-7c2e";

let closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

let seq = 0;
function key(): string {
  seq += 1;
  return `${String(seq).padStart(4, "0")}${"f".repeat(39)}`;
}

const feedback = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "feedback", message: `The button took me to Google ${MARKER}`, page: "guide", request_key: key(), nickname: "", ...extra });

function setup(): { handler: ReturnType<typeof createHandler>; path: string; logs: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "feedback-"));
  const path = join(dir, "tickets.sqlite");
  const logs: string[] = [];
  const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: SITE, tickets: { path }, log: (line) => logs.push(line), questions: { limiterCapacity: 10_000 } });
  closers.push(() => handler.close());
  return { handler, path, logs };
}

function post(data: unknown): [Request, { remoteAddress: string }] {
  return [new Request(`${ORIGIN}/api/questions`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(data) }), { remoteAddress: "203.0.113.20" }];
}

async function body(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(value));
}

describe("feedback contract", () => {
  test("[unit] FB-1 a feedback body needs only a message; email and page are optional", () => {
    const checked = checkPublicSubmission({ kind: "feedback", message: "  hello  ", request_key: "a".repeat(43) });
    expect(checked).toEqual({ ok: true, submission: { kind: "feedback", page: null, email: null, question: "hello", replyConsent: false, marketingConsent: false, requestKey: "a".repeat(43) } });
    const withEmail = checkPublicSubmission({ kind: "feedback", message: "hi", email: " Olly@Example.test ", page: "tm", request_key: "a".repeat(43) });
    expect(withEmail.ok && "submission" in withEmail ? [withEmail.submission.email, withEmail.submission.page, withEmail.submission.replyConsent] : null).toEqual(["olly@example.test", "tm", true]);
  });

  test("[unit] FB-2 over-length, empty, bad email, bad page, unknown kind and question-only fields are refused", () => {
    const k = "a".repeat(43);
    expect(checkPublicSubmission({ kind: "feedback", message: "x".repeat(4097), request_key: k })).toEqual({ ok: false, reason: "bad-question" });
    expect(checkPublicSubmission({ kind: "feedback", message: "x".repeat(4096), request_key: k }).ok).toBe(true);
    expect(checkPublicSubmission({ kind: "feedback", message: "   ", request_key: k })).toEqual({ ok: false, reason: "bad-question" });
    expect(checkPublicSubmission({ kind: "feedback", message: "x", email: "nope", request_key: k })).toEqual({ ok: false, reason: "bad-email" });
    expect(checkPublicSubmission({ kind: "feedback", message: "x", page: "<script>", request_key: k })).toEqual({ ok: false, reason: "bad-page" });
    expect(checkPublicSubmission({ kind: "feedback", message: "x", page: "a".repeat(FEEDBACK_PAGE_MAX + 1), request_key: k })).toEqual({ ok: false, reason: "bad-page" });
    expect(checkPublicSubmission({ kind: "praise", message: "x", request_key: k })).toEqual({ ok: false, reason: "bad-kind" });
    expect(checkPublicSubmission({ kind: "feedback", message: "x", reply_consent: true, request_key: k })).toEqual({ ok: false, reason: "unknown-field" });
    expect(checkPublicSubmission({ kind: "feedback", message: "x", request_key: "short" })).toEqual({ ok: false, reason: "bad-request-key" });
  });
});

describe("feedback store", () => {
  test("[unit] FB-3 an existing questions table gains kind and page, and its rows read as kind=question", () => {
    const path = join(mkdtempSync(join(tmpdir(), "feedback-migrate-")), "tickets.sqlite");
    const old = new Database(path, { create: true, strict: true });
    // The questions table exactly as origin/main created it before this change.
    old.exec(`CREATE TABLE questions (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, scope TEXT NOT NULL, email TEXT,
      question TEXT NOT NULL, reply_consent INTEGER NOT NULL CHECK(reply_consent IN (0, 1)),
      marketing_consent INTEGER NOT NULL CHECK(marketing_consent IN (0, 1)),
      state TEXT NOT NULL, version INTEGER NOT NULL, response TEXT, response_source TEXT,
      key_hash TEXT NOT NULL, key_tag TEXT NOT NULL, request_hash TEXT NOT NULL,
      UNIQUE(scope, key_hash), UNIQUE(scope, key_tag))`);
    old.query("INSERT INTO questions VALUES ('Q-000000000001', ?, ?, 'public', 'a@example.test', 'old', 1, 0, 'pending_review', 1, NULL, NULL, 'h', 't', 'r')").run(new Date(NOW).toISOString(), new Date(NOW).toISOString());
    old.close();
    const store = new QuestionStore(path);
    closers.push(() => store.close());
    expect(store.show("Q-000000000001")).toMatchObject({ kind: "question", page: null, question: "old" });
    expect(store.list().map((r) => r.kind)).toEqual(["question"]);
    // Opening it again is a no-op, not a second ALTER.
    const again = new QuestionStore(path);
    again.close();
  });

  test("[unit] FB-4 a question's stored request hash is unchanged by this change, so its replay still matches", () => {
    const path = join(mkdtempSync(join(tmpdir(), "feedback-hash-")), "tickets.sqlite");
    const store = new QuestionStore(path);
    closers.push(() => store.close());
    const submission = { email: "a@example.test", question: "Q?", replyConsent: true, marketingConsent: false, requestKey: "b".repeat(43) };
    const first = store.submit("public", submission, NOW);
    expect(store.submit("public", submission, NOW + 1)).toEqual(first.status === "issued" ? { status: "replay", id: first.id, state: "pending_review" } : { status: "conflict" });
    const fb: Submission = { ...submission, kind: "feedback", page: "home", email: null, replyConsent: false, requestKey: "c".repeat(43) };
    expect(store.submit("public", fb, NOW).status).toBe("issued");
    expect(store.submit("public", { ...fb, page: "guide" }, NOW).status).toBe("conflict");
  });
});

describe("feedback over HTTP", () => {
  test("[integration] FB-5 a submission is accepted and stored with kind=feedback, its page and no consent rows", async () => {
    const { handler, path, logs } = setup();
    const res = await handler(...post(feedback({ email: "olly@example.test" })));
    expect(res.status).toBe(200);
    const got = await body(res);
    expect(String(got.id)).toMatch(/^Q-[0-9A-F]{12}$/);
    const store = new QuestionStore(path);
    closers.push(() => store.close());
    expect(store.show(String(got.id))).toMatchObject({ kind: "feedback", page: "guide", email: "olly@example.test", question: `The button took me to Google ${MARKER}`, reply_consent: 1, marketing_consent: 0, state: "pending_review" });
    expect(logs.join("\n")).not.toContain(MARKER);
    expect(logs.join("\n")).not.toContain("olly@example.test");
  });

  test("[integration] FB-6 a filled honeypot answers ok and stores nothing", async () => {
    const { handler, path } = setup();
    const res = await handler(...post(feedback({ nickname: "bot" })));
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true });
    const store = new QuestionStore(path);
    closers.push(() => store.close());
    expect(store.counts().questions).toBe(0);
  });

  test("[integration] FB-7 a message over 4,096 characters is refused with 400 and stores nothing", async () => {
    const { handler, path } = setup();
    const res = await handler(...post(feedback({ message: "x".repeat(4097) })));
    expect(res.status).toBe(400);
    expect(await body(res)).toEqual({ code: "bad-question" });
    const store = new QuestionStore(path);
    closers.push(() => store.close());
    expect(store.counts().questions).toBe(0);
  });
});

describe("feedback in the operator's admin view", () => {
  test("[integration] FB-8 the admin list (API, page and CLI) and the admin read carry kind", async () => {
    const { handler, path } = setup();
    const fb = await body(await handler(...post(feedback())));
    const q = await body(await handler(...post({ email: "q@example.test", question: "A question", reply_consent: true, request_key: key(), nickname: "" })));
    const api = createAdminApi({ path, clock: () => NOW, log: () => {} });
    closers.push(() => api.close());
    const principal: AdminPrincipal = { tokenId: "atk_000000000000", scopes: ["questions:admin"] };
    const call = (pathname: string) => api.perform({ principal, recheck: () => principal, method: "GET", pathname, body: async () => ({ ok: true, value: null }), rid: "rid-fb" });
    const listed = await call(ADMIN_QUESTIONS_PATH);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).toContain(`"id":"${String(fb.id)}","kind":"feedback"`);
    expect(JSON.stringify(listed.body)).toContain(`"id":"${String(q.id)}","kind":"question"`);
    const read = await call(`${ADMIN_QUESTIONS_PATH}/${String(fb.id)}`);
    expect(read.body).toMatchObject({ id: fb.id, kind: "feedback", page: "guide" });

    const store = new QuestionStore(path);
    closers.push(() => store.close());
    const html = await renderAdminList(store.list()).text();
    expect(html).toContain("<th>Kind</th>");
    expect(html).toContain("<td>feedback</td>");

    const out: string[] = [];
    const code = runQuestionAdmin(["list"], { BACKSTAGE_TICKETS_PATH: path }, { out: (line) => out.push(line), err: () => {} }, () => NOW);
    expect(code).toBe(0);
    expect(out.find((line) => line.startsWith(String(fb.id)))).toContain("  feedback  ");
  });
});

describe("feedback links on the site", () => {
  function htmlFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return htmlFiles(full);
      return name.endsWith(".html") || name.endsWith(".js") ? [full] : [];
    });
  }

  test("[smoke] FB-9 no mailto feedback link remains in site/; index, guide and /tm/ link to /feedback/ with their page", () => {
    const offenders = htmlFiles(SITE).filter((file) => /mailto:[^"']*feedback/i.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(SITE, "index.html"), "utf8")).toContain('href="/feedback/?from=home"');
    expect(readFileSync(join(SITE, "guide", "index.html"), "utf8")).toContain('href="/feedback/?from=guide"');
    expect(readFileSync(join(SITE, "tm", "index.html"), "utf8")).toContain('href="/feedback/?from=tm"');
  });

  test("[integration] FB-10 /feedback/ is served with the form, honeypot and a 4,096 limit; deletion mailto links stay", async () => {
    const { handler } = setup();
    const res = await handler(new Request(`${ORIGIN}/feedback/`), { remoteAddress: "203.0.113.21" });
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const part of ['id="feedbackForm"', 'id="feedbackMessage"', 'maxlength="4096"', 'id="feedbackEmail"', 'id="feedbackPage"', 'id="feedbackNickname"', 'href="../page.css"', 'src="feedback.js"']) expect(html).toContain(part);
    expect(readFileSync(join(SITE, "ask", "index.html"), "utf8")).toContain('href="mailto:jev@breakoutwithai.com"');
    const privacy = readFileSync(join(SITE, "privacy", "index.html"), "utf8");
    expect(privacy).toContain('id="feedback"');
    expect(privacy).toContain('href="mailto:jev@breakoutwithai.com"');
  });
});
