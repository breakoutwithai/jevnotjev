// Operator bearer API for submitted /ask/ questions (#282). Every test goes through the real createHandler with real
// AdminTokenStore, GuestTokenStore and QuestionStore on one temporary tickets.sqlite.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken } from "../backstage/api-tokens.ts";
import { cookie, credentialFingerprint, signSession } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import { runQuestionAdmin } from "./admin-cli.ts";
import { ADMIN_API_ROUTES, ADMIN_LIST_MAX, ADMIN_QUESTIONS_PATH, createAdminApi } from "./admin-api.ts";
import { QUESTION_LIMITS } from "./contract.ts";
import { QuestionStore } from "./store.ts";
import { AdminTokenStore, GuestTokenStore } from "./tokens.ts";

const ORIGIN = "http://localhost:3456";
const ROOT = join(import.meta.dir, "..", "..");
const SITE = join(ROOT, "site");
const SECRET = "b".repeat(48);
const OPERATOR = "admin-api@example.test";
const EMAIL = "visitor-q282@example.test";
const MARKER = "zq-admin-api-marker-282";
const REPLY = "zq-admin-api-reply-282: start with the fixed choices.";
const T0 = Date.parse("2026-10-19T09:00:00.000Z");
const CHALLENGE = 'Bearer realm="jevnotjev-admin"';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Box {
  readonly handler: ReturnType<typeof createHandler>;
  readonly path: string;
  readonly env: Record<string, string>;
  readonly logs: string[];
  readonly admins: AdminTokenStore;
  readonly guests: GuestTokenStore;
  readonly questions: QuestionStore;
  readonly clock: { now: number };
  readonly apiTokensPath: string;
}

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), "question-admin-api-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const path = join(state, "tickets.sqlite");
  const operatorsPath = join(root, "operators.json");
  writeFileSync(operatorsPath, JSON.stringify([{ email: OPERATOR, admin: true }]));
  const apiDir = join(root, "api");
  const apiTokensPath = join(apiDir, "api-tokens.json");
  const clock = { now: T0 };
  const logs: string[] = [];
  const handler = createHandler({
    version: "test",
    origin: ORIGIN,
    staticRoot: SITE,
    tickets: { path },
    log: (line) => logs.push(line),
    questions: { limiterCapacity: 10_000 },
    api: { tokensPath: apiTokensPath },
    auth: { sessionSecret: SECRET, operatorsPath, clock: () => clock.now },
  });
  const questions = new QuestionStore(path);
  const admins = new AdminTokenStore(path, () => clock.now);
  const guests = new GuestTokenStore(path, () => clock.now);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => questions.close());
  cleanup.push(() => admins.close());
  cleanup.push(() => guests.close());
  cleanup.push(() => handler.close());
  return { handler, path, env: { STATE_DIRECTORY: state }, logs, admins, guests, questions, clock, apiTokensPath };
}

let seq = 0;
function freshKey(): string {
  seq += 1;
  return `${String(seq).padStart(4, "0")}${"a".repeat(39)}`;
}

function seed(b: Box, question = `Fixed choices or open help? ${MARKER}`, at = b.clock.now): string {
  const r = b.questions.submit("public", { email: EMAIL, question, replyConsent: true, marketingConsent: false, requestKey: freshKey() }, at);
  if (r.status !== "issued") throw new Error(`seed failed: ${r.status}`);
  return r.id;
}

function at(): { remoteAddress: string } {
  seq += 1;
  return { remoteAddress: `198.51.100.${seq % 250}` };
}

function get(token: string | null, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { headers: { ...headers, ...(token === null ? {} : { authorization: `Bearer ${token}` }) } });
}

function post(token: string | null, path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers, ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function routeRequest(route: { method: "GET" | "POST"; pattern: string }, token: string | null, id: string, headers: Record<string, string> = {}): Request {
  const path = route.pattern.replace("{id}", id);
  return route.method === "GET" ? get(token, path, headers) : post(token, path, { version: 1, to: "approved" }, headers);
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(value));
}

describe("admin API credentials", () => {
  test("[integration] AQ-API-1 no token, a guest, decide, malformed, unknown, expired, revoked or rotated-away token is 401 on every admin route", async () => {
    const b = box();
    const id = seed(b);
    const live = b.admins.mint("Live");
    const expired = b.admins.mint("Expires", { ttlMs: 60 * 60_000 });
    const revoked = b.admins.mint("Revoked");
    b.admins.revoke(revoked.record.id);
    const rotated = b.admins.mint("Rotated");
    b.admins.rotate(rotated.record.id);
    const visitor = b.guests.mint("Guest A").token;
    const decide = mintToken(b.apiTokensPath, "decide").token;
    b.clock.now = T0 + 60 * 60_000;
    const bad: (string | null)[] = [null, "", "jna_short", `${live.token}x`, `jna_${"A".repeat(43)}`, visitor, decide, expired.token, revoked.token, rotated.token];
    expect(ADMIN_API_ROUTES.length).toBe(3);
    for (const route of ADMIN_API_ROUTES) {
      for (const token of bad) {
        const res = await b.handler(routeRequest(route, token, id), at());
        expect([route.pattern, String(token).slice(0, 4), res.status]).toEqual([route.pattern, String(token).slice(0, 4), 401]);
        expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
        expect((await json(res)).code).toBe("unauthenticated");
      }
      const ok = await b.handler(routeRequest(route, live.token, id), at());
      expect([route.pattern, ok.status]).toEqual([route.pattern, 200]);
    }
  });

  test("[integration] AQ-API-1 a signed-in admin session cookie grants nothing on the admin API", async () => {
    const b = box();
    const id = seed(b);
    const session = signSession({ email: OPERATOR, auth: "google", iat: T0, exp: T0 + 3_600_000, sid: "s".repeat(32), cred: credentialFingerprint("google") }, SECRET);
    const sessionCookie = cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
    expect((await b.handler(new Request(`${ORIGIN}/api/backstage/questions`, { headers: { cookie: sessionCookie } }), at())).status).toBe(200);
    for (const route of ADMIN_API_ROUTES) {
      const res = await b.handler(routeRequest(route, null, id, { cookie: sessionCookie, origin: ORIGIN }), at());
      expect([route.pattern, res.status]).toEqual([route.pattern, 401]);
    }
  });

  test("[integration] AQ-API-ISOLATION an admin token is 401 on every guest route and every decide route", async () => {
    const b = box();
    const decide = mintToken(b.apiTokensPath, "decide");
    const { token } = b.admins.mint("Operator");
    expect((await b.handler(get(decide.token, "/api/v1/arms"), at())).status).toBe(200);
    for (const route of ["arms", "estimate", "ask", "run", "verdict", "validate"]) {
      const req = route === "arms" ? get(token, `/api/v1/${route}`) : post(token, `/api/v1/${route}`, {});
      expect([route, (await b.handler(req, at())).status]).toEqual([route, 401]);
    }
    const guestId = "Q-0123456789AB";
    for (const req of [get(token, "/api/v1/guest/questions"), get(token, `/api/v1/guest/questions/${guestId}`), post(token, "/api/v1/guest/questions", { question: "q", reply_consent: true, request_key: freshKey() })]) {
      expect((await b.handler(req, at())).status).toBe(401);
    }
    expect(b.questions.counts().questions).toBe(0);
  });

  test("[integration] AQ-API-1 revoke applies on the next request; a revoke while the reply body uploads changes nothing", async () => {
    const b = box();
    const id = seed(b);
    const minted = b.admins.mint("Operator");
    expect((await b.handler(get(minted.token, ADMIN_QUESTIONS_PATH), at())).status).toBe(200);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const text = JSON.stringify({ version: 1, to: "approved" });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, 5)));
        await gate;
        controller.enqueue(encoder.encode(text.slice(5)));
        controller.close();
      },
    });
    const pending = b.handler(new Request(`${ORIGIN}${ADMIN_QUESTIONS_PATH}/${id}/reply`, { method: "POST", headers: { authorization: `Bearer ${minted.token}`, "content-type": "application/json" }, body }), at());
    await Bun.sleep(20);
    b.admins.revoke(minted.record.id);
    release();
    const res = await pending;
    expect([res.status, (await json(res)).code]).toEqual([401, "unauthenticated"]);
    expect(b.questions.show(id)?.version).toBe(1);
    expect((await b.handler(get(minted.token, ADMIN_QUESTIONS_PATH), at())).status).toBe(401);
  });

  test("[integration] AQ-API-RACE the token re-check and the reply write share one transaction: a revoke cannot commit between them (#285)", async () => {
    const b = box();
    const id = seed(b);
    const minted = b.admins.mint("Operator");
    const api = createAdminApi({ path: b.path, clock: () => b.clock.now, log: () => {} });
    cleanup.push(() => api.close());
    const principal = api.authenticate(get(minted.token, ADMIN_QUESTIONS_PATH));
    if (principal === null || principal === "unsafe") throw new Error("the operator token did not verify");
    // Another connection, as the CLI's revoke uses, that fails at once instead of waiting for a lock.
    const other = new Database(b.path, { strict: true });
    cleanup.push(() => other.close());
    other.exec("PRAGMA busy_timeout=0;");
    let revoke = "not tried";
    const done = await api.perform({
      principal,
      recheck: () => {
        try {
          other.query("UPDATE admin_tokens SET revoked_at = ? WHERE id = ?").run(b.clock.now, minted.record.id);
          revoke = "committed";
        } catch (error) {
          revoke = error instanceof Error && /locked|busy/i.test(error.message) ? "blocked" : "other-error";
        }
        return principal;
      },
      method: "POST",
      pathname: `${ADMIN_QUESTIONS_PATH}/${id}/reply`,
      body: async () => ({ ok: true, value: { version: 1, to: "approved" } }),
      rid: "rid-race",
    });
    // Never a revoke committed after the check followed by the write it should have stopped.
    expect({ revoke, status: done.status, version: b.questions.show(id)?.version }).toEqual({ revoke: "blocked", status: 200, version: 2 });
    expect(b.admins.verify(`Bearer ${minted.token}`)?.tokenId).toBe(minted.record.id);
  });
});

describe("admin API reads and replies", () => {
  test("[integration] AQ-API-2 list is newest first with id, state, created, updated and version only; no text or email", async () => {
    const b = box();
    const first = seed(b, "first", T0);
    const second = seed(b, "second", T0 + 1000);
    const third = seed(b, `third ${MARKER}`, T0 + 2000);
    const { token } = b.admins.mint("Operator");
    const res = await b.handler(get(token, ADMIN_QUESTIONS_PATH), at());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(EMAIL);
    const out: unknown = JSON.parse(text);
    expect(out).toEqual({
      total: 3,
      questions: [third, second, first].map((id, i) => ({ id, kind: "question", state: "pending_review", created_at: new Date(T0 + (2 - i) * 1000).toISOString(), updated_at: new Date(T0 + (2 - i) * 1000).toISOString(), version: 1 })),
    });
    expect(ADMIN_LIST_MAX).toBe(200);
    const put = await b.handler(new Request(`${ORIGIN}${ADMIN_QUESTIONS_PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}` } }), at());
    expect([put.status, put.headers.get("allow")]).toEqual([405, "GET"]);
  });

  test("[integration] AQ-API-3 read one returns the text, email, state, version and response; unknown or malformed ids are 404", async () => {
    const b = box();
    const id = seed(b);
    const { token } = b.admins.mint("Operator");
    const res = await b.handler(get(token, `${ADMIN_QUESTIONS_PATH}/${id}`), at());
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      id, kind: "question", page: null, created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(), email: EMAIL, question: `Fixed choices or open help? ${MARKER}`,
      state: "pending_review", version: 1, response: null, response_source: null,
    });
    for (const other of ["Q-FFFFFFFFFFFF", "Q-xyz", "q-0A1B2C3D4E5F", `${id}/extra`, `${id}/delete`]) {
      const miss = await b.handler(get(token, `${ADMIN_QUESTIONS_PATH}/${other}`), at());
      expect([other, miss.status]).toEqual([other, 404]);
    }
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      const res2 = await b.handler(new Request(`${ORIGIN}${ADMIN_QUESTIONS_PATH}/${id}`, { method, headers: { authorization: `Bearer ${token}` } }), at());
      expect([method, res2.status]).toEqual([method, 405]);
    }
    const purge = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/purge`, {}), at());
    expect(purge.status).toBe(404);
    expect(b.questions.counts().questions).toBe(1);
  });

  test("[integration] AQ-API-4 reply moves state with the version check; stale is 409, a bad move 409, text on a non-carrying state 400", async () => {
    const b = box();
    const id = seed(b);
    const { token } = b.admins.mint("Operator");
    const reply = async (body: unknown): Promise<[number, unknown]> => {
      const res = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, body), at());
      const out = await json(res);
      return [res.status, res.status === 200 ? out : out.code];
    };
    expect(await reply({ version: 1, to: "approved", text: "this note would be dropped" })).toEqual([400, "text-not-stored"]);
    expect(await reply({ version: 1, to: "declined", source: "template" })).toEqual([400, "text-not-stored"]);
    expect(b.questions.show(id)?.version).toBe(1);
    expect(await reply({ version: 1, to: "answered", text: REPLY })).toEqual([409, "bad-transition"]);
    expect(await reply({ version: 2, to: "approved" })).toEqual([409, "stale-version"]);
    expect(await reply({ version: 1, to: "approved" })).toEqual([200, { id, state: "approved", version: 2 }]);
    expect(await reply({ version: 1, to: "answered", text: REPLY })).toEqual([409, "stale-version"]);
    expect(await reply({ version: 2, to: "answered" })).toEqual([400, "message-required"]);
    expect(await reply({ version: 2, to: "answered", text: "   " })).toEqual([400, "bad-message"]);
    expect(await reply({ version: 2, to: "answered", text: REPLY, extra: 1 })).toEqual([400, "bad-body"]);
    expect(await reply("{")).toEqual([400, "bad-json"]);
    expect(await reply({ version: 2, to: "answered", text: REPLY })).toEqual([200, { id, state: "answered", version: 3 }]);
    expect(b.questions.show(id)).toMatchObject({ state: "answered", response: REPLY, response_source: "human_reviewed", version: 3 });
    const typed = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, { version: 3, to: "approved" }, { "content-type": "text/plain" }), at());
    expect([typed.status, (await json(typed)).code]).toEqual([415, "json-required"]);
    const missing = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/Q-FFFFFFFFFFFF/reply`, { version: 1, to: "approved" }), at());
    expect([missing.status, (await json(missing)).code]).toEqual([404, "not-found"]);
  });

  test("[integration] AQ-API-5 a maximum-length reply passes as raw UTF-8 (astral included) or BMP unicode escapes; an oversize body is 413", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    const max = QUESTION_LIMITS.maxResponseChars;
    const escape = (text: string): string => [...text].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    const cjk = "中".repeat(max);
    const astral = "\u{1F600}".repeat(max);
    // An all-astral reply sent as surrogate escapes is over the 64 KiB edge cap: AQ-API-EDGE.
    const bodies: [string, string][] = [
      [cjk, JSON.stringify({ version: 2, to: "answered", text: cjk })],
      [cjk, `{"version":2,"to":"answered","text":"${escape(cjk)}"}`],
      [astral, JSON.stringify({ version: 2, to: "answered", text: astral })],
    ];
    for (const [text, body] of bodies) {
      const id = seed(b);
      expect(b.questions.transition(id, "approved", 1, "operator:cli", T0).ok).toBe(true);
      const res = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, body), at());
      expect([body.length, res.status]).toEqual([body.length, 200]);
      expect(b.questions.show(id)?.response).toBe(text);
    }
    const id = seed(b);
    const huge = `{"version":1,"to":"approved","text":"${" ".repeat(max * 12 + 2048)}"}`;
    const big = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, huge), at());
    expect([big.status, (await json(big)).code]).toEqual([413, "too-large"]);
    expect(b.questions.show(id)?.version).toBe(1);
  });

  test("[integration] AQ-API-EDGE the reply body cap is the 64 KiB that Bun.serve and nginx apply; an all-astral reply as surrogate escapes is 413 (#285)", async () => {
    const server = readFileSync(join(ROOT, "src", "backstage", "server.ts"), "utf8");
    expect(server).toContain("maxRequestBodySize: 65536,");
    const nginx = readFileSync(join(ROOT, ".deploy", "backstage-nginx.conf"), "utf8");
    const v1 = nginx.slice(nginx.indexOf("location ^~ /api/v1/ {"));
    expect(v1.slice(0, v1.indexOf("}"))).toContain("client_max_body_size 64k;");
    const b = box();
    const { token } = b.admins.mint("Operator");
    const send = async (body: string): Promise<[number, unknown]> => {
      const id = seed(b);
      const res = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, body), at());
      const out = await json(res);
      return [res.status, res.status === 200 ? b.questions.show(id)?.version : out.code];
    };
    const padded = (bytes: number): string => {
      const head = '{"version":1,"to":"approved"';
      return `${head}${" ".repeat(bytes - head.length - 1)}}`;
    };
    expect(await send(padded(65_536))).toEqual([200, 2]);
    expect(await send(padded(65_537))).toEqual([413, "too-large"]);
    const astral = `{"version":1,"to":"approved","text":"${"\\ud83d\\ude00".repeat(QUESTION_LIMITS.maxResponseChars)}"}`;
    expect(astral.length).toBeGreaterThan(65_536);
    expect(await send(astral)).toEqual([413, "too-large"]);
  });

  test("[integration] AQ-API-SLOWBODY a reply body still incomplete after 5 s is 408 body-timeout, not 413 too-large", async () => {
    const b = box();
    const id = seed(b);
    const { token } = b.admins.mint("Operator");
    const stall = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"version":')); } });
    const res = await b.handler(new Request(`${ORIGIN}${ADMIN_QUESTIONS_PATH}/${id}/reply`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: stall }), at());
    expect([res.status, (await json(res)).code]).toEqual([408, "body-timeout"]);
    expect(b.questions.show(id)?.version).toBe(1);
  }, 15_000);

  test("[integration] AQ-API-E2E a public submit is read with an admin token, answered, and the public status lookup shows the reply", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    const key = freshKey();
    const submit = await b.handler(new Request(`${ORIGIN}/api/questions`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, question: `Should this be a fixed choice? ${MARKER}`, reply_consent: true, request_key: key }) }), at());
    expect(submit.status).toBe(200);
    const submitted = await json(submit);
    const id = String(submitted.id);
    const list = await json(await b.handler(get(token, ADMIN_QUESTIONS_PATH), at()));
    expect(list.questions).toEqual([expect.objectContaining({ id, state: "pending_review", version: 1 })]);
    const read = await json(await b.handler(get(token, `${ADMIN_QUESTIONS_PATH}/${id}`), at()));
    expect(read).toMatchObject({ id, question: `Should this be a fixed choice? ${MARKER}`, email: EMAIL, version: 1 });
    expect((await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, { version: 1, to: "approved" }), at())).status).toBe(200);
    expect((await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, { version: 2, to: "answered", text: REPLY }), at())).status).toBe(200);
    const status = await b.handler(new Request(`${ORIGIN}/api/questions/status`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code: String(submitted.status_code) }) }), at());
    expect(status.status).toBe(200);
    expect(await json(status)).toMatchObject({ id, state: "answered", response: REPLY, response_source: "human_reviewed" });
  });

  test("[integration] AQ-API-AGREE the CLI, the page API and the bearer API see one version: a change on one is stale on the others", async () => {
    const b = box();
    const id = seed(b);
    const { token } = b.admins.mint("Operator");
    const session = signSession({ email: OPERATOR, auth: "google", iat: T0, exp: T0 + 3_600_000, sid: "a".repeat(32), cred: credentialFingerprint("google") }, SECRET);
    const sessionCookie = cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
    const pageRead = async (): Promise<Record<string, unknown>> => json(await b.handler(new Request(`${ORIGIN}/api/backstage/questions/${id}`, { headers: { cookie: sessionCookie } }), at()));
    const pageReply = async (body: unknown): Promise<[number, unknown]> => {
      const res = await b.handler(new Request(`${ORIGIN}/api/backstage/questions/${id}/reply`, { method: "POST", headers: { cookie: sessionCookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }), at());
      const out = await json(res);
      return [res.status, res.status === 200 ? out.version : out.code];
    };
    const bearerReply = async (body: unknown): Promise<[number, unknown]> => {
      const res = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, body), at());
      const out = await json(res);
      return [res.status, res.status === 200 ? out.version : out.code];
    };
    const cliShow = (): string[] => {
      const cli: string[] = [];
      runQuestionAdmin(["show", id], b.env, { out: (s) => cli.push(s), err: (s) => cli.push(s) }, () => T0);
      return cli;
    };
    // CLI change: stale on the bearer API and the page API; both read version 2.
    const out: string[] = [];
    expect(runQuestionAdmin(["transition", id, "approved", "--version", "1"], b.env, { out: (s) => out.push(s), err: (s) => out.push(s) }, () => T0)).toBe(0);
    expect(await bearerReply({ version: 1, to: "answered", text: REPLY })).toEqual([409, "stale-version"]);
    expect(await pageReply({ version: 1, to: "answered", text: REPLY })).toEqual([409, "stale-version"]);
    expect((await json(await b.handler(get(token, `${ADMIN_QUESTIONS_PATH}/${id}`), at()))).version).toBe(2);
    expect((await pageRead()).version).toBe(2);
    // Page change: the bearer API and the CLI read version 3.
    expect(await pageReply({ version: 2, to: "answered", text: REPLY })).toEqual([200, 3]);
    expect(await json(await b.handler(get(token, `${ADMIN_QUESTIONS_PATH}/${id}`), at()))).toMatchObject({ state: "answered", version: 3, response: REPLY });
    expect(cliShow()).toContain("version: 3");
    // Page change on a fresh row: stale on the bearer API.
    const third = seed(b);
    const pageMove = await b.handler(new Request(`${ORIGIN}/api/backstage/questions/${third}/reply`, { method: "POST", headers: { cookie: sessionCookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ version: 1, to: "approved" }) }), at());
    expect(pageMove.status).toBe(200);
    const staleBearer = await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${third}/reply`, { version: 1, to: "answered", text: REPLY }), at());
    expect([staleBearer.status, (await json(staleBearer)).code]).toEqual([409, "stale-version"]);
    // Bearer change on a second row: stale on the page API; the page API and the CLI read it.
    const second = seed(b);
    expect((await b.handler(post(token, `${ADMIN_QUESTIONS_PATH}/${second}/reply`, { version: 1, to: "approved" }), at())).status).toBe(200);
    const stalePage = await b.handler(new Request(`${ORIGIN}/api/backstage/questions/${second}/reply`, { method: "POST", headers: { cookie: sessionCookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ version: 1, to: "answered", text: REPLY }) }), at());
    expect([stalePage.status, (await json(stalePage)).code]).toEqual([409, "stale-version"]);
    const pageSecond = await json(await b.handler(new Request(`${ORIGIN}/api/backstage/questions/${second}`, { headers: { cookie: sessionCookie } }), at()));
    expect([pageSecond.state, pageSecond.version]).toEqual(["approved", 2]);
    const cli: string[] = [];
    runQuestionAdmin(["show", second], b.env, { out: (s) => cli.push(s), err: (s) => cli.push(s) }, () => T0);
    expect(cli).toContain("state: approved");
    expect(cli).toContain("version: 2");
  });

  test("[integration] AQ-API-LOG logs carry event, rid, token id, question id and reason; never the token, question text, email or reply", async () => {
    const b = box();
    const id = seed(b);
    const minted = b.admins.mint("Operator");
    await b.handler(get(minted.token, ADMIN_QUESTIONS_PATH), at());
    await b.handler(get(minted.token, `${ADMIN_QUESTIONS_PATH}/${id}`), at());
    await b.handler(post(minted.token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, { version: 1, to: "approved", text: REPLY }), at());
    await b.handler(post(minted.token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, { version: 1, to: "approved" }), at());
    await b.handler(post(minted.token, `${ADMIN_QUESTIONS_PATH}/${id}/reply`, { version: 2, to: "answered", text: REPLY }), at());
    await b.handler(get(`jna_${"B".repeat(43)}`, ADMIN_QUESTIONS_PATH), at());
    const text = b.logs.join("\n");
    for (const event of ["question.api.list", "question.api.read", "question.api.changed", "question.api.rejected"]) expect(text).toContain(event);
    expect(text).toContain(minted.record.id);
    expect(text).toContain(id);
    expect(text).toContain("text-not-stored");
    for (const secret of [minted.token, minted.token.slice(4), MARKER, EMAIL, REPLY, "jna_"]) expect(text).not.toContain(secret);
    for (const line of b.logs.filter((l) => l.includes("question.api."))) {
      const keys = Object.keys(JSON.parse(line));
      expect(keys.every((k) => ["ts", "event", "rid", "token", "id", "reason"].includes(k))).toBe(true);
    }
  });
});
