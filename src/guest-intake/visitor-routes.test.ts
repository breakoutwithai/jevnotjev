// Visitor question API (#307; contract: criteria 3, 4, 5, 7, 8, 9, the first-10-free rule 10 to 13 and the waitlist from
// the operator's scope change "lets start with first 10 free 1 jev call then waitlist", 2026-10-20). Every request
// goes through the real createHandler; only Google's HTTP is faked. A visitor gets its cookie from the real Google start
// and callback, with the fake mapping code `c<n>` -> id_token `t<n>` -> profile `v<n>@example.com` / `sub-<n>`.
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookie, cookieName, credentialFingerprint, signSession } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import * as contract from "./contract.ts";
import { QuestionStore } from "./store.ts";
import { GuestTokenStore } from "./tokens.ts";

const ORIGIN = "http://localhost:8787";
const SITE = join(import.meta.dir, "..", "..", "site");
const SECRET = "v".repeat(48);
const CLIENT_ID = "client-307";
const ADMIN = "admin-vr307@example.test";
const MARKER = "zq-visitor-marker-307";
const REPLY = "zq-visitor-reply-307 route it to the stock desk";
const T0 = Date.parse("2026-10-20T09:00:00.000Z");
const BASE = "/api/v1/visitor";
const QUESTIONS = `${BASE}/questions`;
const VISITOR_COOKIE = "jnj_visitor";
const OAUTH_COOKIE = cookieName(ORIGIN, "oauth");
const ONE_QUESTION = "You have already used your free question. Your question and its reply are on this page.";
const FREE_SLOTS_USED = "The free places are taken. You are on the waitlist.";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

/** The one named cap, read through the namespace so an absent export fails here rather than at import. */
function freeCap(): number {
  const value: unknown = Reflect.get(contract, "FREE_QUESTION_VISITORS");
  if (typeof value !== "number") throw new Error(`contract.FREE_QUESTION_VISITORS is ${typeof value}, expected a number`);
  expect(value).toBe(10);
  return value;
}

/** A positive integer, or a thrown error naming what came back instead. */
function position(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`waitlist_position is ${JSON.stringify(value)}, expected a positive integer`);
  return value;
}

function profileFor(n: number): Record<string, unknown> {
  return { email: `v${n}@example.com`, email_verified: true, aud: CLIENT_ID, iss: "https://accounts.google.com", sub: `sub-${n}` };
}

async function fakeGoogle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.pathname === "/token") {
    const body = init?.body;
    const code = body instanceof URLSearchParams ? body.get("code") ?? "" : "";
    const match = /^c(\d+)$/.exec(code);
    return match ? Response.json({ id_token: `t${match[1]}` }) : Response.json({ error: "invalid_grant" }, { status: 400 });
  }
  if (url.pathname === "/tokeninfo") {
    const match = /^t(\d+)$/.exec(url.searchParams.get("id_token") ?? "");
    return match ? Response.json(profileFor(Number(match[1]))) : Response.json({ error: "invalid_token" }, { status: 400 });
  }
  return Response.json({ error: "unexpected" }, { status: 404 });
}

interface Box {
  readonly handler: ReturnType<typeof createHandler>;
  readonly path: string;
  readonly operatorsPath: string;
  readonly logs: string[];
  readonly clock: { now: number };
}

function box(opts: { limits?: Partial<contract.QuestionLimits>; tickets?: boolean } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), "visitor-routes-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const path = join(state, "tickets.sqlite");
  const operatorsPath = join(root, "operators.json");
  writeFileSync(operatorsPath, JSON.stringify([{ email: ADMIN, admin: true }]));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return handlerOn({ path, operatorsPath, logs: [], clock: { now: T0 } }, opts);
}

/** A handler on an existing tickets file, operators file, clock and log, with the same origin and secret, so a cookie
 * issued by one handler is valid on the other. */
function handlerOn(at: Omit<Box, "handler">, opts: { limits?: Partial<contract.QuestionLimits>; tickets?: boolean } = {}): Box {
  const { path, operatorsPath, logs, clock } = at;
  const handler = createHandler({
    version: "test",
    origin: ORIGIN,
    staticRoot: SITE,
    ...(opts.tickets === false ? {} : { tickets: { path } }),
    log: (line) => logs.push(line),
    questions: { limiterCapacity: 10_000, ...(opts.limits ? { limits: opts.limits } : {}) },
    auth: { sessionSecret: SECRET, operatorsPath, googleClientId: CLIENT_ID, googleClientSecret: "google-secret", fetch: fakeGoogle, clock: () => clock.now },
  });
  cleanup.push(() => handler.close());
  return { handler, path, operatorsPath, logs, clock };
}

function store(b: Box): QuestionStore {
  const s = new QuestionStore(b.path);
  cleanup.push(() => s.close());
  return s;
}

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
}

/** Every request in this file goes through here: a 500 anywhere fails the test that sent it (criterion 8). */
async function send(b: Box, request: Request, ip: string = nextIp()): Promise<Response> {
  const res = await b.handler(request, { remoteAddress: ip });
  expect([request.method, new URL(request.url).pathname, res.status === 500]).toEqual([request.method, new URL(request.url).pathname, false]);
  return res;
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

function setCookieValue(response: Response, name: string): string | null {
  const header = response.headers.getSetCookie().find((h) => h.startsWith(`${name}=`));
  return header === undefined ? null : (header.split(";")[0] ?? "").slice(name.length + 1);
}

interface Visitor {
  readonly n: number;
  readonly cookie: string;
  readonly value: string;
  readonly email: string;
  readonly sub: string;
}

let visitorSeq = 0;

/** Real Google start + callback for profile n. */
async function signIn(b: Box, n: number): Promise<{ response: Response; location: string | null; value: string | null }> {
  const start = await send(b, new Request(`${ORIGIN}/api/auth/google?next=/backstage/`));
  if (start.status !== 302) throw new Error(`google start: ${start.status}`);
  const state = new URL(start.headers.get("location") ?? "https://invalid.test/").searchParams.get("state") ?? "";
  const nonce = setCookieValue(start, OAUTH_COOKIE) ?? "";
  const response = await send(b, new Request(`${ORIGIN}/api/auth/google/callback?state=${encodeURIComponent(state)}&code=c${n}`, { headers: { cookie: `${OAUTH_COOKIE}=${nonce}` } }));
  return { response, location: response.headers.get("location"), value: setCookieValue(response, VISITOR_COOKIE) };
}

async function visitor(b: Box): Promise<Visitor> {
  visitorSeq += 1;
  const n = visitorSeq;
  const { response, location, value } = await signIn(b, n);
  if (response.status !== 303 || location !== "/ask/mine/" || value === null || value === "") {
    throw new Error(`visitor sign-in v${n}: ${response.status} ${String(location)} visitor-cookie=${value === null ? "absent" : "empty"}`);
  }
  return { n, cookie: `${VISITOR_COOKIE}=${value}`, value, email: `v${n}@example.com`, sub: `sub-${n}` };
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `${String(keySeq).padStart(6, "0")}${"k".repeat(37)}`;
}

const submitBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ question: `Which desk answers stock questions? ${MARKER}`, reply_consent: true, request_key: freshKey(), ...extra });

function vPost(cookieHeader: string | null, data: unknown, init: { origin?: string | null; site?: string; type?: string; headers?: Record<string, string>; path?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": init.type ?? "application/json", ...init.headers };
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin !== null) headers.origin = origin;
  if (init.site !== undefined) headers["sec-fetch-site"] = init.site;
  if (cookieHeader !== null) headers.cookie = cookieHeader;
  return new Request(`${ORIGIN}${init.path ?? QUESTIONS}`, { method: "POST", headers, body: typeof data === "string" ? data : JSON.stringify(data) });
}

function vGet(cookieHeader: string | null, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers: cookieHeader === null ? headers : { ...headers, cookie: cookieHeader } });
}

async function submitOk(b: Box, v: Visitor, data: Record<string, unknown> = submitBody()): Promise<string> {
  const res = await send(b, vPost(v.cookie, data));
  const out = await obj(res);
  if (res.status !== 200) throw new Error(`visitor submit v${v.n}: ${res.status} ${String(out.code)}`);
  return str(out.id);
}

/** count distinct visitors, each signed in and holding one question. */
async function seedHolders(b: Box, count: number): Promise<void> {
  for (let i = 0; i < count; i++) await submitOk(b, await visitor(b));
}

function adminCookie(b: Box): string {
  const session = signSession({ email: ADMIN, auth: "google", iat: b.clock.now, exp: b.clock.now + 3_600_000, sid: `sid-${ADMIN}`, cred: credentialFingerprint("google") }, SECRET);
  return cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
}

async function adminReply(b: Box, id: string, body: Record<string, unknown>): Promise<Response> {
  return send(b, new Request(`${ORIGIN}/api/backstage/questions/${id}/reply`, { method: "POST", headers: { cookie: adminCookie(b), origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) }));
}

async function publicSubmit(b: Box, cookieHeader: string | null): Promise<{ id: string; code: string }> {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookieHeader !== null) headers.cookie = cookieHeader;
  const res = await send(b, new Request(`${ORIGIN}/api/questions`, { method: "POST", headers, body: JSON.stringify({ email: "public-vr307@example.test", question: `Public question ${MARKER}`, reply_consent: true, request_key: freshKey(), nickname: "" }) }));
  const out = await obj(res);
  if (res.status !== 200) throw new Error(`public submit: ${res.status} ${String(out.code)}`);
  return { id: str(out.id), code: str(out.status_code) };
}

async function publicStatus(b: Box, code: string, cookieHeader: string | null): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookieHeader !== null) headers.cookie = cookieHeader;
  return send(b, new Request(`${ORIGIN}/api/questions/status`, { method: "POST", headers, body: JSON.stringify({ code }) }));
}

function vidOf(scope: string): string {
  const match = /^visitor:(vis_[0-9a-f]{12})$/.exec(scope);
  if (!match || match[1] === undefined) throw new Error(`not a visitor scope: ${scope}`);
  return match[1];
}

function visitorSub(path: string, vid: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    return db.query<{ google_sub: string }, [string]>("SELECT google_sub FROM visitors WHERE id = ?").get(vid)?.google_sub ?? null;
  } finally {
    db.close();
  }
}

/** The visitors row's `waitlisted_at` for a Google sub; a missing row throws rather than reading as NULL. */
function waitlistedAt(path: string, sub: string): string | null {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query<{ waitlisted_at: string | null }, [string]>("SELECT waitlisted_at FROM visitors WHERE google_sub = ?").get(sub);
    if (row === null) throw new Error(`no visitors row for ${sub}`);
    return row.waitlisted_at;
  } finally {
    db.close();
  }
}

/** Visitor A submits; the admin approves then answers it through the existing admin web routes. */
async function answeredFlow(b: Box): Promise<{ a: Visitor; bv: Visitor; id: string; question: string }> {
  const a = await visitor(b);
  const bv = await visitor(b);
  const data = submitBody();
  const id = await submitOk(b, a, data);
  const approved = await adminReply(b, id, { version: 1, to: "approved" });
  expect(approved.status).toBe(200);
  const answered = await adminReply(b, id, { version: 2, to: "answered", text: REPLY, source: "human_reviewed" });
  expect(answered.status).toBe(200);
  return { a, bv, id, question: str(data.question) };
}

describe("visitor submit", () => {
  test("[integration] VR1 a signed-in visitor submits; the row carries the verified Google email, the visitor scope and the profile sub", async () => {
    const b = box();
    const v = await visitor(b);
    const me = await send(b, vGet(v.cookie, `${BASE}/me`));
    expect([me.status, await obj(me)]).toEqual([200, { email: v.email, can_ask: true, reason: null, waitlist_position: null }]);
    const res = await send(b, vPost(v.cookie, submitBody()));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await obj(res);
    expect(Object.keys(out).sort()).toEqual(["id", "replay", "state"]);
    expect(out).toMatchObject({ state: "pending_review", replay: false });
    const row = store(b).show(str(out.id));
    if (row === null) throw new Error("row not stored");
    expect(row.email).toBe(v.email);
    expect(row.scope).toMatch(/^visitor:vis_[0-9a-f]{12}$/);
    expect(visitorSub(b.path, vidOf(row.scope))).toBe(v.sub);
  });

  test("[integration] VR2 an email field in the visitor body is 400 unknown-field and the attacker email reaches no row", async () => {
    const b = box();
    const v = await visitor(b);
    const before = store(b).counts().questions;
    const res = await send(b, vPost(v.cookie, submitBody({ email: "attacker@example.com" })));
    expect([res.status, (await obj(res)).code]).toEqual([400, "unknown-field"]);
    expect(store(b).counts().questions).toBe(before);
    const db = new Database(b.path, { readonly: true });
    try {
      const inQuestions = db.query<{ n: number }, [string]>("SELECT count(*) n FROM questions WHERE email = ?").get("attacker@example.com")?.n ?? 0;
      const inVisitors = db.query<{ n: number }, [string]>("SELECT count(*) n FROM visitors WHERE email = ?").get("attacker@example.com")?.n ?? 0;
      expect([inQuestions, inVisitors]).toEqual([0, 0]);
    } finally {
      db.close();
    }
  });

  test("[integration] VR3 no cookie, an operator cookie or a bearer is 401; a foreign or missing origin is 403; non-JSON is 415; nothing is stored", async () => {
    const b = box();
    const v = await visitor(b);
    const cases: [string, Request, number, string | null][] = [
      ["no cookie", vPost(null, submitBody()), 401, "unauthenticated"],
      ["operator admin cookie", vPost(adminCookie(b), submitBody()), 401, "unauthenticated"],
      ["guest bearer", vPost(null, submitBody(), { headers: { authorization: `Bearer jng_${"A".repeat(43)}` } }), 401, "unauthenticated"],
      ["evil origin", vPost(v.cookie, submitBody(), { origin: "https://evil.test" }), 403, "cross-origin"],
      ["cross-site fetch", vPost(v.cookie, submitBody(), { site: "cross-site" }), 403, "cross-origin"],
      ["no origin", vPost(v.cookie, submitBody(), { origin: null }), 403, "cross-origin"],
      ["text/plain", vPost(v.cookie, submitBody(), { type: "text/plain" }), 415, "json-required"],
    ];
    for (const [label, request, status, code] of cases) {
      const res = await send(b, request);
      expect([label, res.status, (await obj(res)).code]).toEqual([label, status, code]);
    }
    for (const cookieHeader of [null, adminCookie(b)]) {
      for (const path of [`${BASE}/me`, QUESTIONS]) {
        const res = await send(b, vGet(cookieHeader, path));
        expect([path, res.status]).toEqual([path, 401]);
      }
    }
    expect(store(b).counts().questions).toBe(0);
  });
});

describe("visitor reads", () => {
  test("[integration] VR4 a visitor lists and reads only its own question; another visitor's, a public, a guest, an unknown or a malformed id is 404", async () => {
    const b = box();
    const a = await visitor(b);
    const bv = await visitor(b);
    const dataA = submitBody({ question: `Visitor A asks about returns ${MARKER}` });
    const idA = await submitOk(b, a, dataA);
    const idB = await submitOk(b, bv, submitBody({ question: "Visitor B asks something else" }));
    const pub = await publicSubmit(b, null);
    const tokens = new GuestTokenStore(b.path, () => b.clock.now);
    cleanup.push(() => tokens.close());
    const guest = tokens.mint("Guest VR4").token;
    const guestRes = await send(b, new Request(`${ORIGIN}/api/v1/guest/questions`, { method: "POST", headers: { authorization: `Bearer ${guest}`, "content-type": "application/json" }, body: JSON.stringify(submitBody()) }));
    expect(guestRes.status).toBe(200);
    const guestId = str((await obj(guestRes)).id);
    const list = await send(b, vGet(a.cookie, QUESTIONS));
    expect(list.status).toBe(200);
    expect(await obj(list)).toEqual({
      questions: [{ id: idA, state: "pending_review", created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(), question: str(dataA.question), response: null, response_source: null }],
    });
    const own = await send(b, vGet(a.cookie, `${QUESTIONS}/${idA}`));
    expect([own.status, await obj(own)]).toEqual([200, { id: idA, state: "pending_review", created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString(), question: str(dataA.question), response: null, response_source: null }]);
    for (const other of [idB, pub.id, guestId, "Q-000000000000", "bad"]) {
      const res = await send(b, vGet(a.cookie, `${QUESTIONS}/${other}`));
      expect([other, res.status, await obj(res)]).toEqual([other, 404, { code: "not-found" }]);
    }
  });

  test("[integration] VR5 a visitor sees the admin's approved-then-answered reply on its list and read; another visitor sees neither", async () => {
    const b = box();
    const { a, bv, id } = await answeredFlow(b);
    const read = await obj(await send(b, vGet(a.cookie, `${QUESTIONS}/${id}`)));
    expect(read).toMatchObject({ id, state: "answered", response: REPLY, response_source: "human_reviewed" });
    const listA = rows((await obj(await send(b, vGet(a.cookie, QUESTIONS)))).questions);
    expect(listA).toEqual([expect.objectContaining({ id, state: "answered", response: REPLY, response_source: "human_reviewed" })]);
    const listB = await obj(await send(b, vGet(bv.cookie, QUESTIONS)));
    expect(listB).toEqual({ questions: [] });
    const foreign = await send(b, vGet(bv.cookie, `${QUESTIONS}/${id}`));
    expect([foreign.status, await obj(foreign)]).toEqual([404, { code: "not-found" }]);
  });

  test("[integration] VR6 across submit, admin answer, list and read the server never logs question text, email, sub, reply or cookie", async () => {
    const b = box();
    const { a, id, question } = await answeredFlow(b);
    await send(b, vGet(a.cookie, QUESTIONS));
    await send(b, vGet(a.cookie, `${QUESTIONS}/${id}`));
    const all = b.logs.join("\n");
    expect(all).toContain('"event":"visitor.question.received"');
    expect(all).toContain(id);
    for (const secret of [question, MARKER, a.email, a.sub, REPLY, a.value]) expect([secret, all.includes(secret)]).toEqual([secret, false]);
  });
});

describe("visitor limits never 500", () => {
  test("[integration] VR7 one address past the TicketLimiter limit is 429 rate-limited", async () => {
    const b = box();
    const v = await visitor(b);
    const ip = "203.0.113.207";
    const first = await send(b, vPost(v.cookie, submitBody()), ip);
    expect(first.status).toBe(200);
    for (let i = 1; i < 5; i++) await send(b, vPost(v.cookie, submitBody()), ip);
    const limited = await send(b, vPost(v.cookie, submitBody()), ip);
    expect([limited.status, (await obj(limited)).code]).toEqual([429, "rate-limited"]);
    expect(store(b).counts().questions).toBe(1);
  });

  test("[integration] VR7 a full store (maxRetained) is 503 capacity and stores nothing", async () => {
    const b = box({ limits: { maxRetained: 1 } });
    const seeded = store(b).submit("public", { email: "seed-vr7@example.test", question: "Seed row", replyConsent: true, marketingConsent: false, requestKey: freshKey() }, T0);
    expect(seeded.status).toBe("issued");
    const v = await visitor(b);
    const res = await send(b, vPost(v.cookie, submitBody()));
    expect([res.status, (await obj(res)).code]).toEqual([503, "capacity"]);
    expect(store(b).counts().questions).toBe(1);
  });

  test("[integration] VR7 with no tickets path the visitor submit is 503 questions-unavailable", async () => {
    const b = box({ tickets: false });
    for (const cookieHeader of [null, `${VISITOR_COOKIE}=not-a-token`]) {
      const res = await send(b, vPost(cookieHeader, submitBody()));
      expect([res.status, (await obj(res)).code]).toEqual([503, "questions-unavailable"]);
    }
  });

  test("[integration] VR7 a store write that throws (tickets.sqlite write-locked by another connection) is 503 store-error", async () => {
    const b = box();
    const v = await visitor(b);
    const lock = new Database(b.path);
    lock.exec("PRAGMA busy_timeout=0");
    lock.exec("BEGIN IMMEDIATE");
    try {
      const res = await send(b, vPost(v.cookie, submitBody()));
      expect([res.status, (await obj(res)).code]).toEqual([503, "store-error"]);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
    }
    expect(store(b).counts().questions).toBe(0);
  }, 30_000);
});

describe("first FREE_QUESTION_VISITORS (10) visitors: one free question each, then a waitlist", () => {
  test("[integration] VR8 free: with CAP-1 visitors holding a question, the CAP-th distinct visitor's first question is accepted", async () => {
    const cap = freeCap();
    const b = box();
    await seedHolders(b, cap - 1);
    const last = await visitor(b);
    const res = await send(b, vPost(last.cookie, submitBody()));
    expect([res.status, (await obj(res)).replay]).toEqual([200, false]);
    expect(store(b).counts().questions).toBe(cap);
  }, 120_000);

  test("[integration] VR9 free: past the cap sign-in still works, /me says free-slots-used with a waitlist position and submit is 409 with the waitlist note", async () => {
    const cap = freeCap();
    const b = box();
    await seedHolders(b, cap);
    const before = store(b).counts().questions;
    expect(before).toBe(cap);
    for (const label of ["CAP+1", "CAP+2"]) {
      b.clock.now += 1000;
      visitorSeq += 1;
      const n = visitorSeq;
      const signed = await signIn(b, n);
      expect([label, signed.response.status, signed.location]).toEqual([label, 303, "/ask/mine/"]);
      if (signed.value === null || signed.value === "") throw new Error(`${label}: no visitor cookie`);
      const cookieHeader = `${VISITOR_COOKIE}=${signed.value}`;
      const me = await obj(await send(b, vGet(cookieHeader, `${BASE}/me`)));
      expect([label, Object.keys(me).sort()]).toEqual([label, ["can_ask", "email", "reason", "waitlist_position"]]);
      expect([label, me.email, me.can_ask, me.reason]).toEqual([label, `v${n}@example.com`, false, "free-slots-used"]);
      const mePosition = position(me.waitlist_position);
      const res = await send(b, vPost(cookieHeader, submitBody()));
      expect(res.status).toBe(409);
      const refused = await obj(res);
      expect([label, Object.keys(refused).sort()]).toEqual([label, ["code", "message", "waitlist_position"]]);
      expect([label, refused.code, refused.message, position(refused.waitlist_position)]).toEqual([label, "free-slots-used", FREE_SLOTS_USED, mePosition]);
      expect(FREE_SLOTS_USED).toContain("waitlist");
    }
    expect(store(b).counts().questions).toBe(before);
  }, 120_000);

  test("[integration] VR10 free: one question per visitor; a second is 409 one-question while open, answered or declined; a replay is 200", async () => {
    const b = box();
    const a = await visitor(b);
    const first = submitBody();
    const id = await submitOk(b, a, first);
    const second = await send(b, vPost(a.cookie, submitBody()));
    expect([second.status, await obj(second)]).toEqual([409, { code: "one-question", message: ONE_QUESTION }]);
    expect(store(b).counts().questions).toBe(1);
    const me = await send(b, vGet(a.cookie, `${BASE}/me`));
    expect(await obj(me)).toEqual({ email: a.email, can_ask: false, reason: "one-question", waitlist_position: null });
    const replay = await send(b, vPost(a.cookie, first));
    expect([replay.status, await obj(replay)]).toEqual([200, { id, state: "pending_review", replay: true }]);
    const s = store(b);
    expect(s.transition(id, "approved", 1, "operator:test", T0).ok).toBe(true);
    expect(s.answer(id, 2, "operator:test", T0, REPLY, "human_reviewed").ok).toBe(true);
    const afterAnswer = await send(b, vPost(a.cookie, submitBody()));
    expect([afterAnswer.status, (await obj(afterAnswer)).code]).toEqual([409, "one-question"]);
    const d = await visitor(b);
    const declinedId = await submitOk(b, d);
    expect(s.transition(declinedId, "declined", 1, "operator:test", T0).ok).toBe(true);
    const afterDecline = await send(b, vPost(d.cookie, submitBody()));
    expect([afterDecline.status, (await obj(afterDecline)).code]).toEqual([409, "one-question"]);
    expect(s.counts().questions).toBe(2);
  });

  test("[integration] VR11 free: sign-ins never consume a slot (30 sign-ins; then CAP-1 holders plus 5 sign-ins) and a new visitor's first question is 200", async () => {
    const cap = freeCap();
    const b = box();
    for (let i = 0; i < 30; i++) await visitor(b);
    const x = await visitor(b);
    const resX = await send(b, vPost(x.cookie, submitBody()));
    expect(resX.status).toBe(200);
    await seedHolders(b, cap - 2);
    for (let i = 0; i < 5; i++) await visitor(b);
    expect(store(b).counts().questions).toBe(cap - 1);
    const y = await visitor(b);
    const resY = await send(b, vPost(y.cookie, submitBody()));
    expect(resY.status).toBe(200);
  }, 180_000);

  test("[integration] VR12 free: a deleted question keeps its visitor at one-question and its slot still counts toward the cap", async () => {
    const cap = freeCap();
    const b = box();
    await seedHolders(b, cap - 1);
    const a = await visitor(b);
    const first = submitBody();
    const id = await submitOk(b, a, first);
    expect(store(b).remove(id, "operator", T0)).toBe(true);
    const again = await send(b, vPost(a.cookie, submitBody()));
    expect([again.status, (await obj(again)).code]).toEqual([409, "one-question"]);
    const replay = await send(b, vPost(a.cookie, first));
    expect([replay.status, (await obj(replay)).code]).toEqual([410, "deleted"]);
    const late = await visitor(b);
    const res = await send(b, vPost(late.cookie, submitBody()));
    expect([res.status, (await obj(res)).code]).toEqual([409, "free-slots-used"]);
    expect(store(b).counts().questions).toBe(cap - 1);
  }, 120_000);

  test("[integration] VR15 free waitlist: sign-ins at the cap set waitlisted_at in sign-in order (positions 1, 2); an earlier sign-in joins when first seen at the cap", async () => {
    const cap = freeCap();
    const b = box();
    const early = await visitor(b);
    const earlyRefused = await visitor(b);
    await seedHolders(b, cap);
    expect(store(b).counts().questions).toBe(cap);
    expect([waitlistedAt(b.path, early.sub), waitlistedAt(b.path, earlyRefused.sub)]).toEqual([null, null]);
    const holderSub = `sub-${visitorSeq}`;
    b.clock.now += 1000;
    const w1 = await visitor(b);
    b.clock.now += 1000;
    const w2 = await visitor(b);
    const w1At = waitlistedAt(b.path, w1.sub);
    const w2At = waitlistedAt(b.path, w2.sub);
    expect([typeof w1At, typeof w2At, waitlistedAt(b.path, holderSub)]).toEqual(["string", "string", null]);
    const order: [string, Visitor, number][] = [["W1", w1, 1], ["W2", w2, 2]];
    for (const [label, v, expected] of order) {
      const me = await send(b, vGet(v.cookie, `${BASE}/me`));
      expect([label, me.status, await obj(me)]).toEqual([label, 200, { email: v.email, can_ask: false, reason: "free-slots-used", waitlist_position: expected }]);
    }
    // A visitor who signed in before the cap filled is not waitlisted until it is seen at the cap: by /me ...
    expect(waitlistedAt(b.path, early.sub)).toBeNull();
    b.clock.now += 1000;
    const earlyMe = await send(b, vGet(early.cookie, `${BASE}/me`));
    expect(await obj(earlyMe)).toEqual({ email: early.email, can_ask: false, reason: "free-slots-used", waitlist_position: 3 });
    expect(typeof waitlistedAt(b.path, early.sub)).toBe("string");
    // ... or by a refused submit; its position follows W1, W2 and the /me visitor by time.
    expect(waitlistedAt(b.path, earlyRefused.sub)).toBeNull();
    b.clock.now += 1000;
    const refused = await send(b, vPost(earlyRefused.cookie, submitBody()));
    expect([refused.status, await obj(refused)]).toEqual([409, { code: "free-slots-used", message: FREE_SLOTS_USED, waitlist_position: 4 }]);
    expect(typeof waitlistedAt(b.path, earlyRefused.sub)).toBe("string");
    // Being seen again keeps the earliest time, so W1 stays first.
    expect(waitlistedAt(b.path, w1.sub)).toBe(w1At);
    const w1Again = await obj(await send(b, vGet(w1.cookie, `${BASE}/me`)));
    expect(w1Again.waitlist_position).toBe(1);
    expect(waitlistedAt(b.path, w1.sub)).toBe(w1At);
    expect(store(b).counts().questions).toBe(cap);
  }, 120_000);

  test("[integration] VR16 free waitlist release: a waitlisted visitor is 409 until a handler on the same tickets file raises the cap, then 200; the next waitlisted visitor moves to 1", async () => {
    const cap = freeCap();
    const b = box();
    await seedHolders(b, cap);
    b.clock.now += 1000;
    const w1 = await visitor(b);
    b.clock.now += 1000;
    const w2 = await visitor(b);
    const blocked = await send(b, vPost(w1.cookie, submitBody()));
    expect([blocked.status, await obj(blocked)]).toEqual([409, { code: "free-slots-used", message: FREE_SLOTS_USED, waitlist_position: 1 }]);
    expect(store(b).counts().questions).toBe(cap);
    // Built as a variable, not a literal, so this file type-checks before `freeVisitorSlots` joins QuestionLimits;
    // maxRetained is the default and changes nothing.
    const raised = { maxRetained: contract.QUESTION_LIMITS.maxRetained, freeVisitorSlots: cap + 1 };
    const b2 = handlerOn(b, { limits: raised });
    const accepted = await send(b2, vPost(w1.cookie, submitBody()));
    const acceptedBody = await obj(accepted);
    expect([accepted.status, acceptedBody.state, acceptedBody.replay]).toEqual([200, "pending_review", false]);
    expect(store(b2).show(str(acceptedBody.id))?.email).toBe(w1.email);
    const w2Me = await send(b2, vGet(w2.cookie, `${BASE}/me`));
    expect([w2Me.status, await obj(w2Me)]).toEqual([200, { email: w2.email, can_ask: false, reason: "free-slots-used", waitlist_position: 1 }]);
    const w2Res = await send(b2, vPost(w2.cookie, submitBody()));
    expect([w2Res.status, await obj(w2Res)]).toEqual([409, { code: "free-slots-used", message: FREE_SLOTS_USED, waitlist_position: 1 }]);
    expect(store(b2).counts().questions).toBe(cap + 1);
  }, 120_000);
});

describe("anonymous /ask/ unchanged", () => {
  test("[integration] VR13 with no visitor cookie, anonymous POST /api/questions is 200 and its status is readable", async () => {
    const b = box();
    const { id, code } = await publicSubmit(b, null);
    const status = await publicStatus(b, code, null);
    expect([status.status, (await obj(status)).id]).toEqual([200, id]);
  });

  test("[integration] VR13 with a visitor cookie present, anonymous POST /api/questions is 200 and its status is readable", async () => {
    const b = box();
    const v = await visitor(b);
    const { id, code } = await publicSubmit(b, v.cookie);
    const status = await publicStatus(b, code, v.cookie);
    expect([status.status, (await obj(status)).id]).toEqual([200, id]);
    expect(store(b).show(id)?.scope).toBe("public");
  });
});

describe("visitor sign-out", () => {
  test("[integration] VR14 sign-out is 204 and clears the cookie; the old cookie is then 401 on /me and on submit", async () => {
    const b = box();
    const v = await visitor(b);
    const cross = await send(b, vPost(v.cookie, "", { path: `${BASE}/sign-out`, origin: "https://evil.test" }));
    expect(cross.status).toBe(403);
    expect((await send(b, vGet(v.cookie, `${BASE}/me`))).status).toBe(200);
    const out = await send(b, vPost(v.cookie, "", { path: `${BASE}/sign-out` }));
    expect(out.status).toBe(204);
    const cleared = out.headers.getSetCookie().find((h) => h.startsWith(`${VISITOR_COOKIE}=`)) ?? "";
    expect(cleared).toStartWith(`${VISITOR_COOKIE}=;`);
    expect(cleared).toContain("Max-Age=0");
    const me = await send(b, vGet(v.cookie, `${BASE}/me`));
    expect([me.status, (await obj(me)).code]).toEqual([401, "unauthenticated"]);
    const submit = await send(b, vPost(v.cookie, submitBody()));
    expect([submit.status, (await obj(submit)).code]).toEqual([401, "unauthenticated"]);
    expect(store(b).counts().questions).toBe(0);
  });
});
