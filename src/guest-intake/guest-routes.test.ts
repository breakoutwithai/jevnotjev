// Guest HTTP routes (#256, child of #253; contract: docs/product/guest-intake.md "Guest HTTP schema"). Every test goes
// through the real createHandler with a real GuestTokenStore and QuestionStore on one temporary tickets.sqlite.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintToken } from "../backstage/api-tokens.ts";
import { cookie, credentialFingerprint, signSession } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import type { QuestionLimits } from "./contract.ts";
import { QuestionStore } from "./store.ts";
import { GuestTokenStore } from "./tokens.ts";

const ORIGIN = "http://localhost:3456";
const SITE = join(import.meta.dir, "..", "..", "site");
const MARKER = "zq-guest-marker-91c2";
const T0 = Date.parse("2026-10-18T09:00:00.000Z");
const SECRET = "s".repeat(48);
const PATH = "/api/v1/guest/questions";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

interface Setup {
  readonly handler: ReturnType<typeof createHandler>;
  readonly dir: string;
  readonly path: string;
  readonly logs: string[];
  readonly tokens: GuestTokenStore;
  readonly clock: { now: number };
}

function setup(opts: { limits?: Partial<QuestionLimits>; apiTokensPath?: string; operatorsPath?: string } = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "guest-routes-"));
  chmodSync(dir, 0o700);
  const path = join(dir, "tickets.sqlite");
  const clock = { now: T0 };
  const logs: string[] = [];
  const handler = createHandler({
    version: "test",
    origin: ORIGIN,
    staticRoot: SITE,
    tickets: { path },
    log: (line) => logs.push(line),
    questions: { limiterCapacity: 10_000, ...(opts.limits ? { limits: opts.limits } : {}) },
    ...(opts.apiTokensPath !== undefined ? { api: { tokensPath: opts.apiTokensPath } } : {}),
    auth: { clock: () => clock.now, ...(opts.operatorsPath !== undefined ? { sessionSecret: SECRET, operatorsPath: opts.operatorsPath } : {}) },
  });
  const tokens = new GuestTokenStore(path, () => clock.now);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => tokens.close());
  cleanup.push(() => handler.close());
  return { handler, dir, path, logs, tokens, clock };
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `${String(keySeq).padStart(4, "0")}${"g".repeat(39)}`;
}

const submitBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ question: `Fixed choices or open help? ${MARKER}`, reply_consent: true, request_key: freshKey(), ...extra });

let ipSeq = 0;
function guestPost(token: string | null, data: unknown, init: { ip?: string; type?: string; headers?: Record<string, string> } = {}): [Request, { remoteAddress: string }] {
  ipSeq += 1;
  const headers: Record<string, string> = { "content-type": init.type ?? "application/json", ...init.headers };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return [new Request(`${ORIGIN}${PATH}`, { method: "POST", headers, body: typeof data === "string" ? data : JSON.stringify(data) }), { remoteAddress: init.ip ?? `198.51.100.${ipSeq % 250}` }];
}

function guestGet(token: string | null, path = PATH, headers: Record<string, string> = {}): [Request, { remoteAddress: string }] {
  const all: Record<string, string> = { ...headers };
  if (token !== null) all.authorization = `Bearer ${token}`;
  return [new Request(`${ORIGIN}${path}`, { method: "GET", headers: all }), { remoteAddress: "198.51.100.200" }];
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
  return Object.fromEntries(Object.entries(value));
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

async function submitted(handler: Setup["handler"], token: string, data = submitBody()): Promise<string> {
  const res = await handler(...guestPost(token, data));
  const out = await json(res);
  if (res.status !== 200) throw new Error(`submit failed: ${res.status} ${String(out.code)}`);
  return str(out.id);
}

describe("guest submit, list and read", () => {
  test("[integration] GI-16 a guest submits, replays, lists and reads its own rows; the bodies carry no question, email or events", async () => {
    const { handler, tokens, path } = setup();
    const { token, record } = tokens.mint("Guest A");
    const data = submitBody();
    const first = await handler(...guestPost(token, data));
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const out = await json(first);
    expect(Object.keys(out).sort()).toEqual(["id", "replay", "state"]);
    expect(out).toMatchObject({ state: "pending_review", replay: false });
    const id = str(out.id);
    expect(id).toMatch(/^Q-[0-9A-F]{12}$/);
    expect(new QuestionStore(path).show(id)).toMatchObject({ scope: `guest:${record.id}`, email: null, question: `Fixed choices or open help? ${MARKER}` });
    const replay = await json(await handler(...guestPost(token, data)));
    expect(replay).toEqual({ id, state: "pending_review", replay: true });
    const list = await handler(...guestGet(token));
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain(MARKER);
    expect(JSON.parse(listText)).toEqual({ questions: [{ id, state: "pending_review", created_at: new Date(T0).toISOString(), updated_at: new Date(T0).toISOString() }] });
    const read = await handler(...guestGet(token, `${PATH}/${id}`));
    const readText = await read.text();
    expect(read.status).toBe(200);
    expect(readText).not.toContain(MARKER);
    expect(JSON.parse(readText)).toEqual({ id, state: "pending_review", updated_at: new Date(T0).toISOString(), response: null, response_source: null });
  });

  test("[integration] GI-16 two guests never see each other's rows; a public id is 404 to a guest", async () => {
    const { handler, tokens, path } = setup();
    const a = tokens.mint("Guest A").token;
    const b = tokens.mint("Guest B").token;
    const idA = await submitted(handler, a);
    const idB = await submitted(handler, b);
    const pub = new QuestionStore(path).submit("public", { email: "seeded-g1@example.test", question: "Public one", replyConsent: true, marketingConsent: false, requestKey: freshKey() }, T0);
    if (pub.status !== "issued") throw new Error("public row not stored");
    expect((await json(await handler(...guestGet(a)))).questions).toEqual([expect.objectContaining({ id: idA })]);
    expect((await json(await handler(...guestGet(b)))).questions).toEqual([expect.objectContaining({ id: idB })]);
    for (const [token, other] of [[a, idB], [b, idA], [a, pub.id]] satisfies [string, string][]) {
      const res = await handler(...guestGet(token, `${PATH}/${other}`));
      expect([res.status, (await json(res)).code]).toEqual([404, "not-found"]);
    }
    for (const bad of ["Q-xyz", "q-0A1B2C3D4E5F", "Q-0A1B2C3D4E5F/extra", "..%2fask"]) {
      const res = await handler(...guestGet(a, `${PATH}/${bad}`));
      expect(res.status).toBe(404);
    }
  });

  test("[integration] GI-16 the submit body is strict: email, scope, guest, nickname or a bad field is 400 and stores nothing", async () => {
    const { handler, tokens, path } = setup();
    const { token } = tokens.mint("Guest A");
    const cases: [Record<string, unknown> | string, number, string][] = [
      [submitBody({ email: "seeded-g2@example.test" }), 400, "unknown-field"],
      [submitBody({ scope: "public" }), 400, "unknown-field"],
      [submitBody({ guest: "gtk_000000000000" }), 400, "unknown-field"],
      [submitBody({ nickname: "" }), 400, "unknown-field"],
      [submitBody({ reply_consent: false }), 400, "no-consent"],
      [submitBody({ marketing_consent: "yes" }), 400, "bad-consent"],
      [submitBody({ request_key: "short" }), 400, "bad-request-key"],
      [submitBody({ question: "" }), 400, "bad-question"],
      [submitBody({ question: "x".repeat(4097) }), 400, "bad-question"],
      ["[1]", 400, "bad-body"],
      ["{", 400, "bad-json"],
      [JSON.stringify(submitBody({ question: "x".repeat(17_000) })), 413, "too-large"],
    ];
    for (const [data, status, code] of cases) {
      const res = await handler(...guestPost(token, data));
      expect([res.status, (await json(res)).code]).toEqual([status, code]);
    }
    const typed = await handler(...guestPost(token, submitBody(), { type: "text/plain" }));
    expect([typed.status, (await json(typed)).code]).toEqual([415, "json-required"]);
    expect(new QuestionStore(path).counts().questions).toBe(0);
  });

  test("[integration] GI-16 conflict, deletion replay and method checks", async () => {
    const { handler, tokens, path } = setup();
    const { token } = tokens.mint("Guest A");
    const data = submitBody();
    const id = await submitted(handler, token, data);
    const conflict = await handler(...guestPost(token, { ...data, question: "Another question" }));
    expect([conflict.status, (await json(conflict)).code]).toEqual([409, "request-key-reused"]);
    expect(new QuestionStore(path).remove(id, "operator", T0)).toBe(true);
    const replay = await handler(...guestPost(token, data));
    expect([replay.status, (await json(replay)).code]).toEqual([410, "deleted"]);
    const read = await handler(...guestGet(token, `${PATH}/${id}`));
    expect(read.status).toBe(404);
    expect((await json(await handler(...guestGet(token)))).questions).toEqual([]);
    const put = await handler(new Request(`${ORIGIN}${PATH}`, { method: "PUT", headers: { authorization: `Bearer ${token}` } }), { remoteAddress: "198.51.100.7" });
    expect([put.status, put.headers.get("allow")]).toEqual([405, "GET, POST"]);
    const postOne = await handler(new Request(`${ORIGIN}${PATH}/${id}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" }), { remoteAddress: "198.51.100.8" });
    expect([postOne.status, postOne.headers.get("allow")]).toEqual([405, "GET"]);
    const other = await handler(...guestGet(token, "/api/v1/guest/tokens"));
    expect(other.status).toBe(404);
  });

  test("[integration] GI-5b the guest quota counts new rows per token per UTC day; a replay and another token are not counted", async () => {
    const { handler, tokens, clock } = setup({ limits: { guestNewPerDay: 2 } });
    const a = tokens.mint("Guest A").token;
    const b = tokens.mint("Guest B").token;
    const first = submitBody();
    await submitted(handler, a, first);
    await submitted(handler, a);
    await submitted(handler, a, first);
    const over = await handler(...guestPost(a, submitBody()));
    expect([over.status, (await json(over)).code]).toEqual([503, "capacity"]);
    await submitted(handler, b);
    clock.now = Date.parse("2026-10-19T00:00:00.000Z");
    await submitted(handler, a);
  });

  test("[integration] GI-5a guest POSTs share the per-address attempt limiter, counted before the token is checked", async () => {
    const { handler, tokens } = setup();
    const { token } = tokens.mint("Guest A");
    for (let i = 0; i < 5; i++) await handler(...guestPost(i % 2 === 0 ? null : token, submitBody(), { ip: "203.0.113.77" }));
    const limited = await handler(...guestPost(token, submitBody(), { ip: "203.0.113.77" }));
    expect([limited.status, (await json(limited)).code]).toEqual([429, "rate-limited"]);
  });
});

describe("guest credentials", () => {
  test("[integration] GI-16 a missing, malformed, unknown, expired, revoked or rotated-away token is 401 on every route", async () => {
    const { handler, tokens, clock, path } = setup();
    const live = tokens.mint("Live");
    const id = await submitted(handler, live.token);
    const expired = tokens.mint("Expires", { ttlMs: 60 * 60_000 });
    const revoked = tokens.mint("Revoked");
    tokens.revoke(revoked.record.id);
    const rotated = tokens.mint("Rotated");
    const oldSecret = rotated.token;
    tokens.rotate(rotated.record.id);
    clock.now = T0 + 60 * 60_000;
    const bad: (string | null)[] = [null, "", "jng_short", `${live.token}x`, `jng_${"A".repeat(43)}`, expired.token, revoked.token, oldSecret];
    for (const token of bad) {
      for (const req of [guestPost(token, submitBody()), guestGet(token), guestGet(token, `${PATH}/${id}`)]) {
        const res = await handler(...req);
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="jevnotjev-guest"');
        expect((await json(res)).code).toBe("unauthenticated");
      }
    }
    expect(new QuestionStore(path).counts().questions).toBe(1);
    expect((await handler(...guestGet(live.token))).status).toBe(200);
  });

  test("[integration] GI-16 rotation keeps the principal: the new secret reads the same rows and shares the same quota", async () => {
    const { handler, tokens } = setup({ limits: { guestNewPerDay: 2 } });
    const minted = tokens.mint("Guest A");
    const id = await submitted(handler, minted.token);
    const rotated = tokens.rotate(minted.record.id);
    expect((await json(await handler(...guestGet(rotated.token, `${PATH}/${id}`)))).id).toBe(id);
    await submitted(handler, rotated.token);
    const over = await handler(...guestPost(rotated.token, submitBody()));
    expect([over.status, (await json(over)).code]).toEqual([503, "capacity"]);
  });

  test("[integration] GI-16 the token is checked again after the body is read: a revoke mid-upload stores nothing", async () => {
    const { handler, tokens, path } = setup();
    const { token, record } = tokens.mint("Guest A");
    const streamed = (text: string, gate: Promise<void>): ReadableStream<Uint8Array> => {
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(encoder.encode(text.slice(0, 10)));
          await gate;
          controller.enqueue(encoder.encode(text.slice(10)));
          controller.close();
        },
      });
    };
    const control = await handler(new Request(`${ORIGIN}${PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: streamed(JSON.stringify(submitBody()), Promise.resolve()) }), { remoteAddress: "198.51.100.9" });
    expect(control.status).toBe(200);
    const text = JSON.stringify(submitBody());
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = handler(new Request(`${ORIGIN}${PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: streamed(text, gate) }), { remoteAddress: "198.51.100.19" });
    await Bun.sleep(20);
    tokens.revoke(record.id);
    release();
    const res = await pending;
    expect([res.status, (await json(res)).code]).toEqual([401, "unauthenticated"]);
    expect(new QuestionStore(path).counts().questions).toBe(1);
  });

  test("[integration] GI-16 unsafe token state is 503 auth-unavailable, never a principal and never a 401", async () => {
    const { handler, tokens, dir, path } = setup();
    const { token } = tokens.mint("Guest A");
    chmodSync(dir, 0o755);
    try {
      for (const req of [guestPost(token, submitBody()), guestGet(token)]) {
        const res = await handler(...req);
        expect([res.status, (await json(res)).code]).toEqual([503, "auth-unavailable"]);
      }
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(new QuestionStore(path).counts().questions).toBe(0);
    expect((await handler(...guestGet(token))).status).toBe(200);
  });

  test("[integration] GI-16 with no tickets store configured the guest routes answer 503 questions-unavailable", async () => {
    const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: SITE, log: () => {} });
    cleanup.push(() => handler.close());
    const res = await handler(...guestGet(`jng_${"A".repeat(43)}`));
    expect([res.status, (await json(res)).code]).toEqual([503, "questions-unavailable"]);
  });

  test("[integration] GI-17 a guest token is 401 on every decide route, and a decide token is 401 on the guest routes", async () => {
    const apiDir = mkdtempSync(join(tmpdir(), "guest-api-"));
    cleanup.push(() => rmSync(apiDir, { recursive: true, force: true }));
    const apiTokensPath = join(apiDir, "api-tokens.json");
    const decide = mintToken(apiTokensPath, "decide");
    const { handler, tokens } = setup({ apiTokensPath });
    const { token } = tokens.mint("Guest A");
    const arms = await handler(new Request(`${ORIGIN}/api/v1/arms`, { headers: { authorization: `Bearer ${decide.token}` } }), { remoteAddress: "198.51.100.10" });
    expect(arms.status).toBe(200);
    for (const route of ["arms", "estimate", "ask", "run", "verdict", "validate"]) {
      const method = route === "arms" ? "GET" : "POST";
      const res = await handler(new Request(`${ORIGIN}/api/v1/${route}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) }), { remoteAddress: "198.51.100.11" });
      expect([route, res.status]).toEqual([route, 401]);
    }
    for (const req of [guestPost(decide.token, submitBody()), guestGet(decide.token)]) expect((await handler(...req)).status).toBe(401);
  });

  test("[integration] GI-16 a signed-in session cookie grants nothing on the guest routes", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "guest-ops-"));
    cleanup.push(() => rmSync(opsDir, { recursive: true, force: true }));
    const operatorsPath = join(opsDir, "operators.json");
    writeFileSync(operatorsPath, JSON.stringify([{ email: "tester@example.test" }]));
    const { handler, tokens } = setup({ operatorsPath });
    const { token } = tokens.mint("Guest A");
    expect((await handler(...guestGet(token, PATH, {}))).status).toBe(200);
    const session = signSession({ email: "tester@example.test", auth: "google", iat: T0, exp: T0 + 3_600_000, sid: "s".repeat(32), cred: credentialFingerprint("google") }, SECRET);
    const sessionCookie = cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
    const check = await handler(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: sessionCookie } }), { remoteAddress: "198.51.100.12" });
    expect(check.status).toBe(204);
    for (const req of [guestPost(null, submitBody(), { headers: { cookie: sessionCookie } }), guestGet(null, PATH, { cookie: sessionCookie })]) {
      const res = await handler(...req);
      expect(res.status).toBe(401);
    }
  });
});

describe("public capability boundary", () => {
  test("[integration] GI-8 a guest row is 404 on the public status route before and after its token is revoked or expires", async () => {
    const { handler, tokens, clock } = setup();
    const a = tokens.mint("Guest A", { ttlMs: 60 * 60_000 });
    const b = tokens.mint("Guest B");
    const keyA = freshKey();
    const keyB = freshKey();
    const idA = await submitted(handler, a.token, submitBody({ request_key: keyA }));
    const idB = await submitted(handler, b.token, submitBody({ request_key: keyB }));
    const status = async (code: string): Promise<number> =>
      (await handler(new Request(`${ORIGIN}/api/questions/status`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ code }) }), { remoteAddress: `192.0.2.${++ipSeq % 250}` })).status;
    expect(await status(`${idA}.${keyA}`)).toBe(404);
    expect(await status(`${idB}.${keyB}`)).toBe(404);
    tokens.revoke(b.record.id);
    clock.now = T0 + 60 * 60_000;
    expect(await status(`${idA}.${keyA}`)).toBe(404);
    expect(await status(`${idB}.${keyB}`)).toBe(404);
  });
});

describe("guest boundary", () => {
  test("[integration] GI-12 with fake provider keys set, the guest lifecycle makes 0 provider requests and 0 model spawns", async () => {
    const saved = { jev: process.env.JEV_API_KEY, openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY };
    process.env.JEV_API_KEY = "jev-fake-0000";
    process.env.OPENAI_API_KEY = "sk-fake-0000";
    process.env.ANTHROPIC_API_KEY = "sk-ant-fake-0000";
    const fetchSpy = spyOn(globalThis, "fetch");
    const spawnSpy = spyOn(Bun, "spawn");
    const spawnSyncSpy = spyOn(Bun, "spawnSync");
    const cpNames: (keyof typeof childProcess)[] = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
    const cp = cpNames.map((name) => spyOn(childProcess, name));
    try {
      const { handler, tokens, path } = setup();
      const { token, record } = tokens.mint("Guest A");
      const id = await submitted(handler, token);
      await handler(...guestGet(token));
      const store = new QuestionStore(path);
      store.transition(id, "approved", 1, "operator:cli", T0);
      store.answer(id, 2, "operator:cli", T0, "Reviewed reply.", "human_reviewed");
      expect((await json(await handler(...guestGet(token, `${PATH}/${id}`)))).response).toBe("Reviewed reply.");
      tokens.revoke(record.id);
      await handler(...guestGet(token));
      expect(fetchSpy).toHaveBeenCalledTimes(0);
      expect(spawnSpy).toHaveBeenCalledTimes(0);
      expect(spawnSyncSpy).toHaveBeenCalledTimes(0);
      for (const spy of cp) expect(spy).toHaveBeenCalledTimes(0);
    } finally {
      fetchSpy.mockRestore();
      spawnSpy.mockRestore();
      spawnSyncSpy.mockRestore();
      for (const spy of cp) spy.mockRestore();
      for (const [name, value] of [["JEV_API_KEY", saved.jev], ["OPENAI_API_KEY", saved.openai], ["ANTHROPIC_API_KEY", saved.anthropic]] satisfies [string, string | undefined][]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("[integration] GI-14a guest logs name the event, token id, question id and reason; never the token, question text or request key", async () => {
    const { handler, tokens, logs } = setup();
    const { token, record } = tokens.mint("Guest A");
    const data = submitBody();
    const id = await submitted(handler, token, data);
    await handler(...guestPost(token, { ...data, question: "changed" }));
    await handler(...guestGet(token, `${PATH}/${id}`));
    await handler(...guestGet(`jng_${"B".repeat(43)}`));
    const text = logs.join("\n");
    expect(text).toContain("guest.question.received");
    expect(text).toContain("guest.question.rejected");
    expect(text).toContain(record.id);
    expect(text).toContain(id);
    for (const secret of [token, MARKER, str(data.request_key), "jng_"]) expect(text).not.toContain(secret);
  });
});
