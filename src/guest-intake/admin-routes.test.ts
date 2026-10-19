// Admin routes for submitted /ask/ questions (#278): a signed-in operator whose operators.json row carries
// `"admin": true` lists, reads and answers questions through the same QuestionStore methods the CLI calls.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookie, credentialFingerprint, OperatorStore, signSession } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import { runQuestionAdmin } from "./admin-cli.ts";
import { ADMIN_ROUTES } from "./admin-routes.ts";
import { QuestionStore } from "./store.ts";

const ORIGIN = "http://localhost:3456";
const SITE = join(import.meta.dir, "..", "..", "site");
const SECRET = "a".repeat(48);
const ADMIN = "admin-q@example.test";
const TESTER = "tester-q@example.test";
const STRINGY = "stringy-q@example.test";
const EMAIL = "visitor-q278@example.test";
const MARKER = "zq-admin-marker-278";
const T0 = Date.parse("2026-10-19T09:00:00.000Z");

let handlers: ReturnType<typeof createHandler>[] = [];
afterEach(() => {
  for (const h of handlers) h.close();
  handlers = [];
});

interface Box {
  readonly handler: ReturnType<typeof createHandler>;
  readonly path: string;
  readonly state: string;
  readonly logs: string[];
  readonly tick: (ms: number) => void;
  readonly now: () => number;
}

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), "question-admin-routes-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const path = join(state, "tickets.sqlite");
  const operatorsPath = join(root, "operators.json");
  writeFileSync(operatorsPath, JSON.stringify([{ email: ADMIN, admin: true }, { email: TESTER }, { email: STRINGY, admin: "true" }]));
  let at = T0;
  const logs: string[] = [];
  const handler = createHandler({
    version: "test", origin: ORIGIN, staticRoot: SITE, tickets: { path }, log: (line) => logs.push(line),
    auth: { sessionSecret: SECRET, operatorsPath, clock: () => at },
  });
  handlers.push(handler);
  return { handler, path, state, logs, tick: (ms) => { at += ms; }, now: () => at };
}

function sessionFor(b: Box, email: string): string {
  const session = signSession({ email, auth: "google", iat: b.now(), exp: b.now() + 3_600_000, sid: `sid-${email}`, cred: credentialFingerprint("google") }, SECRET);
  return cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `${String(keySeq).padStart(4, "0")}${"m".repeat(39)}`;
}

async function submit(b: Box, question = `Which desk answers stock questions? ${MARKER}`): Promise<{ id: string; code: string }> {
  keySeq += 1;
  const res = await b.handler(new Request(`${ORIGIN}/api/questions`, {
    method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, question, reply_consent: true, request_key: freshKey(), nickname: "" }),
  }), { remoteAddress: `203.0.113.${keySeq % 200}` });
  if (res.status !== 200) throw new Error(`submit failed: ${res.status}`);
  const out = await obj(res);
  return { id: str(out.id), code: str(out.status_code) };
}

async function obj(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(value));
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value.map((v: unknown) => {
    if (typeof v !== "object" || v === null) throw new Error("expected an object row");
    return Object.fromEntries(Object.entries(v));
  });
}

function call(b: Box, method: string, path: string, opts: { cookie?: string; body?: unknown; origin?: string; site?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie !== undefined) headers.cookie = opts.cookie;
  if (opts.origin !== undefined) headers.origin = opts.origin;
  if (opts.site !== undefined) headers["sec-fetch-site"] = opts.site;
  return b.handler(new Request(`${ORIGIN}${path}`, { method, headers, ...(method === "POST" ? { body: JSON.stringify(opts.body ?? {}) } : {}) }), { remoteAddress: "198.51.100.40" });
}

function routePath(pattern: string, id: string): string {
  return pattern.replace("{id}", id);
}

function cli(b: Box, args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = runQuestionAdmin(args, { BACKSTAGE_TICKETS_PATH: b.path }, { out: (s) => out.push(s), err: (s) => err.push(s) }, b.now);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("access", () => {
  test("[integration] AQ-1 every registered admin route answers 401 unauthenticated to an anonymous request", async () => {
    const b = box();
    const { id } = await submit(b);
    expect(ADMIN_ROUTES.length).toBeGreaterThanOrEqual(4);
    for (const route of ADMIN_ROUTES) {
      const res = await call(b, route.method, routePath(route.pattern, id), { origin: ORIGIN, body: { version: 1, to: "approved" } });
      const text = await res.text();
      expect([route.method, route.pattern, res.status, text.includes(MARKER), text.includes(EMAIL)]).toEqual([route.method, route.pattern, 401, false, false]);
      expect(JSON.parse(text)).toEqual({ code: "unauthenticated" });
    }
    const unknown = await call(b, "GET", `/api/backstage/questions/${id}/other`);
    expect(unknown.status).toBe(401);
    expect(new QuestionStore(b.path).show(id)?.version).toBe(1);
  });

  test("[integration] AQ-2 a signed-in operator without the boolean admin flag gets 403 and no question data", async () => {
    const b = box();
    const { id } = await submit(b);
    for (const email of [TESTER, STRINGY]) {
      const session = sessionFor(b, email);
      for (const route of ADMIN_ROUTES) {
        const res = await call(b, route.method, routePath(route.pattern, id), { cookie: session, origin: ORIGIN, body: { version: 1, to: "approved" } });
        const text = await res.text();
        expect([email, route.pattern, res.status, text.includes(MARKER), text.includes(EMAIL), text.includes(id)]).toEqual([email, route.pattern, 403, false, false, false]);
      }
    }
    expect(new QuestionStore(b.path).show(id)?.state).toBe("pending_review");
  });

  test("[unit] AQ-12 OperatorStore sets admin only when the row's admin field is the boolean true", () => {
    const dir = mkdtempSync(join(tmpdir(), "operators-admin-"));
    const path = join(dir, "operators.json");
    writeFileSync(path, JSON.stringify([{ email: "a@example.test", admin: true }, { email: "b@example.test", admin: "true" }, { email: "c@example.test", admin: 1 }, { email: "d@example.test" }]));
    const store = new OperatorStore(path);
    expect(["a", "b", "c", "d"].map((n) => store.get(`${n}@example.test`)?.admin === true)).toEqual([true, false, false, false]);
    expect(Object.hasOwn(store.get("b@example.test") ?? {}, "admin")).toBe(false);
  });
});

describe("admin reads", () => {
  test("[integration] AQ-3 the admin list is newest first with id, state, created and updated time, and no contact or text", async () => {
    const b = box();
    const first = await submit(b);
    b.tick(60_000);
    const second = await submit(b);
    b.tick(60_000);
    const third = await submit(b);
    const res = await call(b, "GET", "/api/backstage/questions", { cookie: sessionFor(b, ADMIN) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.clone().text();
    expect([text.includes(MARKER), text.includes(EMAIL)]).toEqual([false, false]);
    const list = rows((await obj(res)).questions);
    expect(list.map((r) => r.id)).toEqual([third.id, second.id, first.id]);
    for (const r of list) {
      expect(Object.keys(r).sort()).toEqual(["created_at", "id", "scope", "state", "updated_at", "version"]);
      expect(r.state).toBe("pending_review");
    }
  });

  test("[integration] AQ-4 the admin detail shows text, email, state, version and reply; an unknown id is 404", async () => {
    const b = box();
    const { id } = await submit(b);
    const res = await call(b, "GET", `/api/backstage/questions/${id}`, { cookie: sessionFor(b, ADMIN) });
    expect(res.status).toBe(200);
    const row = await obj(res);
    expect(row).toMatchObject({ id, email: EMAIL, state: "pending_review", version: 1, response: null, response_source: null, scope: "public" });
    expect(str(row.question)).toContain(MARKER);
    expect(Object.keys(row)).not.toContain("key_tag");
    for (const bad of ["Q-000000000000", "nope"]) {
      const missing = await call(b, "GET", `/api/backstage/questions/${bad}`, { cookie: sessionFor(b, ADMIN) });
      expect([bad, missing.status, (await obj(missing)).code]).toEqual([bad, 404, "not-found"]);
    }
  });
});

describe("admin changes", () => {
  test("[integration] AQ-5 a reply carrying a stale version is refused stale-version and changes nothing", async () => {
    const b = box();
    const { id } = await submit(b);
    const admin = sessionFor(b, ADMIN);
    const ok = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "approved" } });
    expect([ok.status, await obj(ok)]).toEqual([200, { id, state: "approved", version: 2 }]);
    const stale = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "answered", text: "Too late.", source: "human_reviewed" } });
    expect([stale.status, (await obj(stale)).code]).toEqual([409, "stale-version"]);
    expect(new QuestionStore(b.path).show(id)).toMatchObject({ state: "approved", version: 2, response: null });
  });

  test("[integration] AQ-6 a transition the state model forbids is refused bad-transition; a malformed body is bad-body", async () => {
    const b = box();
    const { id } = await submit(b);
    const admin = sessionFor(b, ADMIN);
    const bad = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "answered", text: "Skipping review.", source: "human_reviewed" } });
    expect([bad.status, (await obj(bad)).code]).toEqual([409, "bad-transition"]);
    for (const body of [{ version: "1", to: "approved" }, { version: 1, to: "closed" }, { version: 1, to: "approved", extra: true }, { version: 1, to: "approved", source: "model" }]) {
      const res = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body });
      expect([JSON.stringify(body), res.status, (await obj(res)).code]).toEqual([JSON.stringify(body), 400, "bad-body"]);
    }
    const missing = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "needs_info" } });
    expect([missing.status, (await obj(missing)).code]).toEqual([400, "message-required"]);
    expect(new QuestionStore(b.path).show(id)).toMatchObject({ state: "pending_review", version: 1 });
  });

  test("[integration] AQ-7 end to end: public submit, admin read, approve, answer, then the public status shows the reply", async () => {
    const b = box();
    const { id, code } = await submit(b);
    const admin = sessionFor(b, ADMIN);
    const read = await obj(await call(b, "GET", `/api/backstage/questions/${id}`, { cookie: admin }));
    expect(read.version).toBe(1);
    expect((await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "approved" } })).status).toBe(200);
    const answered = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 2, to: "answered", text: "Route stock questions to the stock desk.", source: "human_reviewed" } });
    expect([answered.status, await obj(answered)]).toEqual([200, { id, state: "answered", version: 3 }]);
    const status = await b.handler(new Request(`${ORIGIN}/api/questions/status`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) }), { remoteAddress: "203.0.113.250" });
    expect(await obj(status)).toMatchObject({ id, state: "answered", response: "Route stock questions to the stock desk.", response_source: "human_reviewed" });
  });

  test("[integration] AQ-8 across submit, read and answer the server never logs the question text, the email or the reply", async () => {
    const b = box();
    const reply = "zq-reply-marker-278 send it to stock";
    const { id } = await submit(b);
    const admin = sessionFor(b, ADMIN);
    await call(b, "GET", "/api/backstage/questions", { cookie: admin });
    await call(b, "GET", `/api/backstage/questions/${id}`, { cookie: admin });
    await call(b, "GET", `/backstage/questions/?id=${id}`, { cookie: admin });
    await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "approved" } });
    await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 1, to: "answered", text: reply, source: "human_reviewed" } });
    await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 2, to: "answered", text: reply, source: "human_reviewed" } });
    await call(b, "GET", `/api/backstage/questions/${id}`, { cookie: sessionFor(b, TESTER) });
    await call(b, "GET", `/api/backstage/questions/${id}`);
    const all = b.logs.join("\n");
    expect(all).toContain('"event":"question.admin.changed"');
    expect(all).toContain('"reason":"stale-version"');
    expect(all).toContain(id);
    for (const secret of [MARKER, EMAIL, reply, ADMIN, TESTER]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });

  test("[integration] AQ-9 the CLI and the admin API see one state and one version, in both directions", async () => {
    const b = box();
    const { id } = await submit(b);
    const admin = sessionFor(b, ADMIN);
    const viaCli = cli(b, ["transition", id, "approved", "--version", "1"]);
    expect([viaCli.code, viaCli.out]).toEqual([0, `${id} now v2`]);
    expect(await obj(await call(b, "GET", `/api/backstage/questions/${id}`, { cookie: admin }))).toMatchObject({ state: "approved", version: 2 });
    const viaApi = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, origin: ORIGIN, body: { version: 2, to: "answered", text: "Answered from the page.", source: "template" } });
    expect(viaApi.status).toBe(200);
    const shown = cli(b, ["show", id]);
    expect(shown.out).toContain("state: answered");
    expect(shown.out).toContain("version: 3");
    expect(shown.out).toContain("response: Answered from the page.");
    expect(shown.out).toContain("response_source: template");
    expect(cli(b, ["transition", id, "approved", "--version", "2"]).err).toBe("refused: bad-transition");
  });

  test("[integration] AQ-10 a cross-origin or cross-site reply POST from an admin session is refused and changes nothing", async () => {
    const b = box();
    const { id } = await submit(b);
    const admin = sessionFor(b, ADMIN);
    for (const headers of [{ origin: "https://evil.example" }, { origin: ORIGIN, site: "cross-site" }]) {
      const res = await call(b, "POST", `/api/backstage/questions/${id}/reply`, { cookie: admin, ...headers, body: { version: 1, to: "approved" } });
      expect([JSON.stringify(headers), res.status, (await obj(res)).code]).toEqual([JSON.stringify(headers), 403, "origin-rejected"]);
    }
    expect(new QuestionStore(b.path).show(id)).toMatchObject({ state: "pending_review", version: 1 });
  });
});

describe("admin page", () => {
  test("[integration] AQ-11 the page renders question markup as text, sends no secrets and loads nothing external", async () => {
    const b = box();
    const hostile = `<img src=x onerror="alert(1)"><script>alert(2)</script> ${MARKER}`;
    const { id } = await submit(b, hostile);
    const admin = sessionFor(b, ADMIN);
    const list = await call(b, "GET", "/backstage/questions/", { cookie: admin });
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toContain("text/html");
    const listHtml = await list.text();
    expect(listHtml).toContain(id);
    expect(listHtml).not.toContain(MARKER);
    const detail = await call(b, "GET", `/backstage/questions/?id=${id}`, { cookie: admin });
    expect(detail.status).toBe(200);
    const html = await detail.text();
    expect(html).toContain(EMAIL);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toMatch(/(?:src|href|action)=["']?(?:https?:)?\/\//i);
    for (const secret of [SECRET, "sessionSecret", "password_hash"]) expect(html).not.toContain(secret);
    const csp = detail.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
    const unknown = await call(b, "GET", "/backstage/questions/?id=Q-000000000000", { cookie: admin });
    expect(unknown.status).toBe(404);
  });
});
