import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import childProcess from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cookie, credentialFingerprint, signSession } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import { MAX_QUESTION_BODY, type QuestionLimits } from "./contract.ts";
import { QuestionStore } from "./store.ts";

const ORIGIN = "http://localhost:3456";
const SITE = join(import.meta.dir, "..", "..", "site");
const MARKER = "zq-marker-5d1f7c";
const EMAIL = "seeded-q3@example.test";
const SECRET = "s".repeat(48);

let handlers: ReturnType<typeof createHandler>[] = [];
afterEach(() => {
  for (const h of handlers) h.close();
  handlers = [];
});

interface Setup { readonly handler: ReturnType<typeof createHandler>; readonly path: string; readonly logs: string[]; readonly dir: string }
function setup(opts: { limits?: Partial<QuestionLimits>; limiterCapacity?: number; session?: boolean } = {}): Setup {
  const dir = mkdtempSync(join(tmpdir(), "question-routes-"));
  const path = join(dir, "tickets.sqlite");
  const logs: string[] = [];
  const operatorsPath = join(dir, "operators.json");
  writeFileSync(operatorsPath, JSON.stringify([{ email: "tester@example.test" }]));
  const handler = createHandler({
    version: "test", origin: ORIGIN, staticRoot: SITE, tickets: { path }, log: (line) => logs.push(line),
    questions: { ...(opts.limits ? { limits: opts.limits } : {}), ...(opts.limiterCapacity !== undefined ? { limiterCapacity: opts.limiterCapacity } : {}) },
    ...(opts.session ? { requireSession: true, auth: { sessionSecret: SECRET, operatorsPath } } : {}),
  });
  handlers.push(handler);
  return { handler, path, logs, dir };
}

let keySeq = 0;
function freshKey(): string {
  keySeq += 1;
  return `${String(keySeq).padStart(4, "0")}${"k".repeat(39)}`;
}

const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ email: EMAIL, question: `Route stock questions? ${MARKER}`, reply_consent: true, request_key: freshKey(), nickname: "", ...extra });

function post(path: string, data: unknown, init: { ip?: string; origin?: string; type?: string; length?: string } = {}): [Request, { remoteAddress: string }] {
  const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, "content-type": init.type ?? "application/json" };
  if (init.length !== undefined) headers["content-length"] = init.length;
  return [new Request(`${ORIGIN}${path}`, { method: "POST", headers, body: typeof data === "string" ? data : JSON.stringify(data) }), { remoteAddress: init.ip ?? "203.0.113.9" }];
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

describe("public submit", () => {
  test("[integration] GI-1 a valid submit stores one row and returns its id and private status code", async () => {
    const { handler, path } = setup();
    const data = body();
    const res = await handler(...post("/api/questions", data));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const out = await json(res);
    expect(str(out.id)).toMatch(/^Q-[0-9A-F]{12}$/);
    expect(out.status_code).toBe(`${str(out.id)}.${str(data.request_key)}`);
    expect(out).toMatchObject({ state: "pending_review", replay: false });
    expect(Object.keys(out).sort()).toEqual(["id", "replay", "state", "status_code"]);
    expect(new QuestionStore(path).counts().questions).toBe(1);
  });

  test("[integration] GI-2 a bad field, wrong origin, wrong type, bad JSON or oversize body stores nothing", async () => {
    const { handler, path } = setup();
    const cases: [Parameters<typeof post>, number, string][] = [
      [["/api/questions", body({ website: "x" })], 400, "unknown-field"],
      [["/api/questions", body({ email: "nope" })], 400, "bad-email"],
      [["/api/questions", body({ reply_consent: false })], 400, "no-consent"],
      [["/api/questions", body(), { origin: "https://evil.example" }], 403, "origin-rejected"],
      [["/api/questions", body(), { type: "text/plain" }], 415, "json-required"],
      [["/api/questions", "{not json", { ip: "203.0.113.10" }], 400, "bad-json"],
      [["/api/questions", body(), { length: String(MAX_QUESTION_BODY + 1), ip: "203.0.113.10" }], 413, "too-large"],
      [["/api/questions", JSON.stringify(body({ question: "q".repeat(MAX_QUESTION_BODY) })), { ip: "203.0.113.10" }], 413, "too-large"],
    ];
    for (const [args, status, code] of cases) {
      const res = await handler(...post(...args));
      expect([code, res.status, (await json(res)).code]).toEqual([code, status, code]);
    }
    expect(new QuestionStore(path).counts().questions).toBe(0);
  });

  test("[integration] GI-3 a filled honeypot answers ok and stores nothing", async () => {
    const { handler, path, logs } = setup();
    const res = await handler(...post("/api/questions", body({ nickname: "bot" })));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
    expect(new QuestionStore(path).counts().questions).toBe(0);
    expect(logs.some((l) => l.includes('"reason":"honeypot"'))).toBe(true);
  });

  test("[integration] GI-4a a retry over HTTP returns the same receipt", async () => {
    const { handler, path } = setup();
    const data = body();
    const first = await json(await handler(...post("/api/questions", data)));
    const again = await json(await handler(...post("/api/questions", data)));
    expect(again).toEqual({ ...first, replay: true });
    const conflict = await handler(...post("/api/questions", { ...data, question: "changed" }));
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe("request-key-reused");
    expect(new QuestionStore(path).counts().questions).toBe(1);
  });

  test("[integration] GI-4d concurrent same-key retries from separate processes leave exactly one row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "question-race-"));
    const path = join(dir, "tickets.sqlite");
    new QuestionStore(path).close();
    const store = join(import.meta.dir, "store.ts");
    const script = (question: string): string =>
      `const { QuestionStore } = await import(${JSON.stringify(store)}); const s = new QuestionStore(${JSON.stringify(path)}); const r = s.submit("public", { email: "race@example.test", question: ${JSON.stringify(question)}, replyConsent: true, marketingConsent: false, requestKey: "${"R".repeat(43)}" }, Date.now()); console.log(JSON.stringify(r));`;
    const run = (question: string) => Bun.spawn(["bun", "-e", script(question)], { stdout: "pipe", stderr: "pipe" });
    const same = await Promise.all(Array.from({ length: 6 }, () => run("same payload")).map(async (p) => { await p.exited; return JSON.parse(await new Response(p.stdout).text()); }));
    const ids = new Set(same.map((r: unknown) => (typeof r === "object" && r !== null ? Reflect.get(r, "id") : undefined)));
    expect(ids.size).toBe(1);
    expect(same.filter((r: unknown) => typeof r === "object" && r !== null && Reflect.get(r, "status") === "issued").length).toBe(1);
    const mixed = await Promise.all([run("same payload"), run("other payload")].map(async (p) => { await p.exited; return JSON.parse(await new Response(p.stdout).text()); }));
    expect(mixed.map((r: unknown) => (typeof r === "object" && r !== null ? Reflect.get(r, "status") : undefined)).sort()).toEqual(["conflict", "replay"]);
    expect(new QuestionStore(path).counts().questions).toBe(1);
  }, 30_000);
});

describe("limits", () => {
  test("[integration] GI-5a the attempt limiter counts every POST from an address, valid or not", async () => {
    const { handler } = setup();
    for (let i = 0; i < 5; i++) expect((await handler(...post("/api/questions", i % 2 ? body() : body({ email: "bad" }), { ip: "198.51.100.1" }))).status).not.toBe(429);
    const limited = await handler(...post("/api/questions", body(), { ip: "198.51.100.1" }));
    expect(limited.status).toBe(429);
    expect((await json(limited)).code).toBe("rate-limited");
    expect((await handler(...post("/api/questions", body(), { ip: "198.51.100.2" }))).status).toBe(200);
  });

  test("[integration] GI-5a the limiter refuses a new address rather than grow past its capacity", async () => {
    const { handler } = setup({ limiterCapacity: 2 });
    expect((await handler(...post("/api/questions", body(), { ip: "198.51.100.11" }))).status).toBe(200);
    expect((await handler(...post("/api/questions", body(), { ip: "198.51.100.12" }))).status).toBe(200);
    expect((await handler(...post("/api/questions", body(), { ip: "198.51.100.13" }))).status).toBe(429);
  });

  test("[integration] GI-5b over the public write quota the answer is capacity and a replay still succeeds", async () => {
    const { handler } = setup({ limits: { publicNewPerWindow: 1 } });
    const data = body();
    expect((await handler(...post("/api/questions", data, { ip: "198.51.100.21" }))).status).toBe(200);
    const full = await handler(...post("/api/questions", body(), { ip: "198.51.100.22" }));
    expect([full.status, (await json(full)).code]).toEqual([503, "capacity"]);
    expect((await handler(...post("/api/questions", data, { ip: "198.51.100.23" }))).status).toBe(200);
  });
});

describe("store failure", () => {
  test("[integration] GI-6 a store write failure is 503 store-error with no detail", async () => {
    const { handler, path } = setup();
    await handler(...post("/api/questions", body()));
    const db = new Database(path);
    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON questions BEGIN SELECT RAISE(ABORT, 'disk on fire'); END");
    const res = await handler(...post("/api/questions", body()));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ code: "store-error" });
  });

  test("[integration] GI-6 with no store configured the routes answer 503 unavailable", async () => {
    const handler = createHandler({ version: "test", origin: ORIGIN, staticRoot: SITE, log: () => {} });
    handlers.push(handler);
    const res = await handler(...post("/api/questions", body()));
    expect([res.status, (await json(res)).code]).toEqual([503, "questions-unavailable"]);
  });
});

describe("status", () => {
  test("[integration] GI-8 status shows state and response, never the question or email; a wrong code is 404", async () => {
    const { handler, path } = setup();
    const issued = await json(await handler(...post("/api/questions", body())));
    const code = str(issued.status_code);
    const id = str(issued.id);
    const ok = await handler(...post("/api/questions/status", { code }));
    expect(ok.status).toBe(200);
    const text = await ok.clone().text();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain(EMAIL);
    const view = await json(ok);
    expect(Object.keys(view).sort()).toEqual(["id", "response", "response_source", "state", "updated_at"]);
    expect(view).toMatchObject({ id, state: "pending_review", response: null, response_source: null });
    const store = new QuestionStore(path);
    store.transition(id, "approved", 1, "operator", Date.now());
    store.answer(id, 2, "operator", Date.now(), "Try a prompt with two fixed choices.", "human_reviewed");
    expect(await json(await handler(...post("/api/questions/status", { code })))).toMatchObject({ state: "answered", response: "Try a prompt with two fixed choices.", response_source: "human_reviewed" });
    const wrongKey = `${id}.${"z".repeat(43)}`;
    for (const bad of [{ code: wrongKey }, { code: `Q-000000000000.${"z".repeat(43)}` }]) {
      const res = await handler(...post("/api/questions/status", bad));
      expect([res.status, (await json(res)).code]).toEqual([404, "not-found"]);
    }
    const malformed = await handler(...post("/api/questions/status", { code: "nope" }));
    expect([malformed.status, (await json(malformed)).code]).toEqual([400, "bad-code"]);
  });

  test("[integration] GI-8 a guest row is 404 to the public status route even with its correct id and key", async () => {
    const { handler, path } = setup();
    const key = "G".repeat(43);
    const store = new QuestionStore(path);
    const guest = store.submit("guest:gtk_00000000000a", { email: null, question: "Guest question", replyConsent: true, marketingConsent: false, requestKey: key }, Date.now());
    if (guest.status !== "issued") throw new Error("guest row not stored");
    const res = await handler(...post("/api/questions/status", { code: `${guest.id}.${key}` }));
    expect([res.status, (await json(res)).code]).toEqual([404, "not-found"]);
  });

  test("[integration] GI-10c after delete the status is 404 and a replay is 410 deleted", async () => {
    const { handler, path } = setup();
    const data = body();
    const issued = await json(await handler(...post("/api/questions", data)));
    expect(new QuestionStore(path).remove(str(issued.id), "operator", Date.now())).toBe(true);
    const status = await handler(...post("/api/questions/status", { code: str(issued.status_code) }));
    expect([status.status, (await json(status)).code]).toEqual([404, "not-found"]);
    const replay = await handler(...post("/api/questions", data));
    expect([replay.status, (await json(replay)).code]).toEqual([410, "deleted"]);
  });
});

describe("provider boundary", () => {
  test("[integration] GI-12 with fake provider keys set, the public lifecycle makes 0 provider requests and 0 model spawns", async () => {
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
      const { handler, path } = setup();
      const data = body();
      const issued = await json(await handler(...post("/api/questions", data)));
      await handler(...post("/api/questions", data));
      await handler(...post("/api/questions", body({ nickname: "bot" })));
      await handler(...post("/api/questions", body({ email: "bad" })));
      await handler(...post("/api/questions/status", { code: str(issued.status_code) }));
      const store = new QuestionStore(path);
      store.transition(str(issued.id), "approved", 1, "operator", Date.now());
      store.answer(str(issued.id), 2, "operator", Date.now(), "Reviewed reply.", "human_reviewed");
      await handler(...post("/api/questions/status", { code: str(issued.status_code) }));
      store.remove(str(issued.id), "operator", Date.now());
      await handler(...post("/api/questions", data));
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
});

describe("logs and public surfaces", () => {
  test("[integration] GI-14a logs name the event, id and reason, never the email, question, key or status code", async () => {
    const { handler, logs } = setup();
    const data = body();
    const issued = await json(await handler(...post("/api/questions", data)));
    await handler(...post("/api/questions", body({ email: "bad" })));
    await handler(...post("/api/questions/status", { code: str(issued.status_code) }));
    await handler(...post("/api/questions/status", { code: `${str(issued.id)}.${"z".repeat(43)}` }));
    const all = logs.join("\n");
    expect(all).toContain('"event":"question.received"');
    expect(all).toContain(str(issued.id));
    expect(all).toContain('"reason":"bad-email"');
    for (const secret of [EMAIL, MARKER, str(data.request_key), str(issued.status_code)]) expect(all).not.toContain(secret);
  });

  test("[integration] GI-15a pending question text is absent from every public GET route and from site/", async () => {
    const { handler, logs } = setup();
    await handler(...post("/api/questions", body()));
    for (const path of ["/", "/ask/", "/ask/ask.js", "/privacy/", "/api/tickets/ranking", "/api/maps", "/api/questions", "/api/questions/status"]) {
      const res = await handler(new Request(`${ORIGIN}${path}`), { remoteAddress: "203.0.113.30" });
      expect([path, (await res.text()).includes(MARKER)]).toEqual([path, false]);
    }
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(SITE);
    expect(files.filter((f) => readFileSync(f).includes(MARKER))).toEqual([]);
    expect(logs.join("\n")).not.toContain(MARKER);
  });

  test("[integration] GI-15b a signed-in tester session reaches no question queue route", async () => {
    const { handler } = setup({ session: true });
    await handler(...post("/api/questions", body()));
    const now = Date.now();
    const session = signSession({ email: "tester@example.test", auth: "google", iat: now, exp: now + 3_600_000, sid: "sid-test-0001", cred: credentialFingerprint("google") }, SECRET);
    const sessionCookie = cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
    const probes: [string, string][] = [["GET", "/api/backstage/questions"], ["POST", "/api/backstage/questions"], ["GET", "/backstage/questions/"], ["GET", "/api/questions/admin"], ["POST", "/api/questions/admin"], ["GET", "/api/questions/list"]];
    for (const [method, path] of probes) {
      const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers: { cookie: sessionCookie, origin: ORIGIN, "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) }), { remoteAddress: "203.0.113.31" });
      const text = await res.text();
      expect([method, path, res.status === 200, text.includes(MARKER), text.includes(EMAIL)]).toEqual([method, path, false, false, false]);
    }
  });

  test("[integration] GI-15c no route takes or returns rows by email", async () => {
    const { handler } = setup();
    await handler(...post("/api/questions", body()));
    const byEmail = await handler(...post("/api/questions/status", { email: EMAIL }));
    expect([byEmail.status, (await json(byEmail)).code]).toEqual([400, "bad-code"]);
    const query = await handler(new Request(`${ORIGIN}/api/questions?email=${encodeURIComponent(EMAIL)}`), { remoteAddress: "203.0.113.32" });
    expect(query.status).toBe(405);
    expect(await query.text()).not.toContain(EMAIL);
  });

  test("[unit] GI-15a the privacy page names the question store and promises no retention period", async () => {
    const page = await Bun.file(join(SITE, "privacy", "index.html")).text();
    const paragraph = page.match(/<p id="questions">[\s\S]*?<\/p>/)?.[0] ?? "";
    for (const phrase of ["question", "email", "status code", "no retention period has been set", "never sent to a model provider"]) expect([phrase, paragraph.includes(phrase)]).toEqual([phrase, true]);
  });
});
