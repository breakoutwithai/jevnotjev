// /api/v1 (M5 of the API/MCP work): bearer auth on every route, per-request provider keys, no claude-cli, limits, no CORS.
// The real handler from server.ts is called in-process. Provider answers come from the recorded fixtures in
// src/decide/fixtures through the CLI's own fixtureDeps (a request with no key gets a 401); no test calls a provider.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureDeps } from "../decide/cli.ts";
import { parseFixtures, type FixtureSet } from "../decide/cli-args.ts";
import type { DecideSpawn } from "../decide/llm.ts";
import type { DecideFetch, FetchInit } from "../decide/types.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import { ApiTokenStore, mintToken } from "./api-tokens.ts";
import { API_V1_LIMITS, API_V1_ROUTES, createApiV1, type ApiSlot } from "./api-v1.ts";
import { createHandler, type ServerOptions } from "./server.ts";

const ROOT = join(import.meta.dir, "..", "..");
const FX = join(ROOT, "src", "decide", "fixtures");
const BASE = "http://localhost:3456";

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, ...path: (string | number)[]): unknown {
  let at: unknown = value;
  for (const key of path) {
    if (typeof key === "number") at = Array.isArray(at) ? at[key] : undefined;
    else at = isRecord(at) ? at[key] : undefined;
  }
  return at;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function json(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

const QUESTIONS = [
  { name: "needs_human", type: "noul", instructions: "Does answering this shop message need a person to check live stock, a booking or a policy?" },
  {
    name: "topic",
    type: "choice",
    instructions: "What is this shop message mainly about?",
    choices: [
      { name: "stock", definition: "Whether an item or size is available." },
      { name: "price", definition: "What something costs." },
      { name: "other", definition: "Anything else." },
    ],
  },
  {
    name: "urgency",
    type: "score",
    instructions: "How urgent is this shop message?",
    levels: [
      { label: "Not urgent", description: "General question." },
      { label: "Somewhat urgent", description: "Wants an answer today." },
      { label: "Very urgent", description: "Safety, injury or a booking about to start." },
    ],
  },
];
const M0_TEXT = "Do you have women's boots in size 6?";
const CASES = [{ id: "m04", input: M0_TEXT }, { id: "m05", input: M0_TEXT }];
const ALL_ARMS = { jev: true, decisions: true, llm: "claude-haiku-5-5" };
const USE_JEV_CSV = readFileSync(join(ROOT, "examples", "d08-verdicts", "r3-use-jev.csv"), "utf8");

function fixtureSet(): FixtureSet {
  const response = (name: string): unknown => {
    const raw = json(readFileSync(join(FX, name), "utf8"));
    return { http: field(raw, "http"), response: field(raw, "response") };
  };
  const parsed = parseFixtures(JSON.stringify({
    hosts: {
      "api.typesafe.ai": response("m0-jev.json"),
      "api.openai.com": response("m0-decisions.json"),
      "api.anthropic.com": response("m0-llm.UNVERIFIED.json"),
    },
    cli: { stdout: readFileSync(join(FX, "m0-llm-cli.jsonl"), "utf8"), exitCode: 0 },
  }));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

interface Harness {
  readonly handler: ReturnType<typeof createHandler>;
  readonly token: string;
  readonly dir: string;
  readonly logs: string[];
  readonly sent: FetchInit[];
  readonly spawned: () => number;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** A handler with a minted token in a temp state file and fixture providers that record every request they get. */
function harness(extra: Partial<ServerOptions> = {}, which: () => string | null = () => "claude"): Harness {
  const dir = mkdtempSync(join(tmpdir(), "jnj-api-v1-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const tokensPath = join(dir, "state", "api-tokens.json");
  const { token } = mintToken(tokensPath, "api-test");
  const fx = fixtureDeps(fixtureSet());
  const sent: FetchInit[] = [];
  const fetch: DecideFetch = async (url, init) => {
    sent.push(init);
    if (fx.fetch === undefined) throw new Error("no fixture fetch");
    return fx.fetch(url, init);
  };
  let spawns = 0;
  const spawn: DecideSpawn = async (argv, stdin) => {
    spawns += 1;
    if (fx.spawn === undefined) throw new Error("no fixture spawn");
    return fx.spawn(argv, stdin);
  };
  const logs: string[] = [];
  const handler = createHandler({
    version: "test",
    staticRoot: join(dir, "site"),
    log: (line) => logs.push(line),
    api: { tokensPath, deps: { fetch, spawn, which } },
    ...extra,
  });
  cleanups.push(() => handler.close());
  return { handler, token, dir, logs, sent, spawned: () => spawns };
}

function call(h: Harness, method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const init: RequestInit = { method, headers: { ...(method === "POST" ? { "content-type": "application/json" } : {}), ...headers } };
  return h.handler(new Request(BASE + path, method === "POST" ? { ...init, body: typeof body === "string" ? body : JSON.stringify(body) } : init));
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** A request per route that the route answers with 200 when the token is valid. */
const GOOD: Readonly<Record<string, unknown>> = {
  "/api/v1/arms": null,
  "/api/v1/estimate": { questions: QUESTIONS, cases: CASES, arms: ALL_ARMS },
  "/api/v1/ask": { questions: QUESTIONS, case: CASES[0], arms: { jev: true, llm: false } },
  "/api/v1/run": { questions: QUESTIONS, cases: CASES, arms: { jev: true, llm: false } },
  "/api/v1/verdict": { records: USE_JEV_CSV },
  "/api/v1/validate": { records: USE_JEV_CSV },
};

describe("API-AUTH", () => {
  test("[unit] API-ROUTES the six routes, one per tool, GET for arms and POST for the rest", () => {
    expect(API_V1_ROUTES.map(([m, p]) => `${m} ${p}`)).toEqual([
      "GET /api/v1/arms", "POST /api/v1/estimate", "POST /api/v1/ask", "POST /api/v1/run", "POST /api/v1/verdict", "POST /api/v1/validate",
    ]);
  });

  for (const [method, path] of API_V1_ROUTES) {
    test(`[integration] API-AUTH ${method} ${path} is 401 without a token and with a wrong one, before any provider call`, async () => {
      const h = harness();
      const wrong = `jnj_${"A".repeat(43)}`;
      const keys = { "x-jev-key": "k-jev", "x-openai-key": "k-openai", "x-anthropic-key": "k-anthropic" };
      for (const headers of [{}, bearer(wrong), bearer(h.token + "x"), { authorization: h.token }, { authorization: `Basic ${h.token}` }, bearer("")]) {
        const res = await call(h, method, path, GOOD[path], { ...keys, ...headers });
        expect(res.status).toBe(401);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="jevnotjev-api"');
        expect(await res.json()).toEqual({ code: "unauthenticated" });
      }
      expect(h.sent).toHaveLength(0);
    });

    test(`[integration] API-AUTH ${method} ${path} answers 200 with a minted token`, async () => {
      const h = harness();
      const res = await call(h, method, path, GOOD[path], { ...bearer(h.token), "x-jev-key": "k-jev" });
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      if (path === "/api/v1/arms") expect(field(body, "types")).toEqual(["noul", "choice", "score"]);
      if (path === "/api/v1/estimate") expect(field(body, "calls")).toBe(6);
      if (path === "/api/v1/ask") expect(list(field(body, "rows")).map((r) => field(r, "outcome"))).toEqual(["answered", "answered", "answered"]);
      if (path === "/api/v1/run") expect(list(field(body, "rows"))).toHaveLength(6);
      if (path === "/api/v1/verdict") expect(field(body, "exit_code")).toBe(0);
      if (path === "/api/v1/validate") expect(field(body, "valid")).toBe(true);
    });
  }
});

describe("API surface", () => {
  test("[integration] API-ERRORS an authed request gets 404, 405, 415 and 400 for unknown routes, wrong methods, non-JSON and bad input", async () => {
    const h = harness();
    const auth = bearer(h.token);
    expect((await call(h, "GET", "/api/v1/nope", null, auth)).status).toBe(404);
    expect((await call(h, "GET", "/api/v1", null, auth)).status).toBe(404);
    const wrongMethod = await call(h, "POST", "/api/v1/arms", {}, auth);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");
    expect((await call(h, "GET", "/api/v1/run", null, auth)).status).toBe(405);
    expect((await h.handler(new Request(BASE + "/api/v1/ask", { method: "POST", headers: { ...auth, "content-type": "text/plain" }, body: "{}" }))).status).toBe(415);
    const notJson = await call(h, "POST", "/api/v1/ask", "{not json", auth);
    expect(notJson.status).toBe(400);
    expect(field(await notJson.json(), "code")).toBe("invalid-json");
    const floating = await call(h, "POST", "/api/v1/ask", { questions: QUESTIONS, case: CASES[0], arms: { llm: "claude-haiku-latest" } }, auth);
    expect(floating.status).toBe(400);
    const floatingBody: unknown = await floating.json();
    expect(field(floatingBody, "code")).toBe("invalid-input");
    expect(field(floatingBody, "exit_code")).toBe(2);
    expect(String(field(floatingBody, "errors", 0))).toContain("claude-haiku-5-5");
    const out = await call(h, "POST", "/api/v1/run", { ...(isRecord(GOOD["/api/v1/run"]) ? GOOD["/api/v1/run"] : {}), out: "/tmp/x.csv" }, auth);
    expect(out.status).toBe(400);
    const broken = await call(h, "POST", "/api/v1/verdict", { records: "not,a,record\n" }, auth);
    expect(broken.status).toBe(400);
    expect(field(await broken.json(), "exit_code")).toBe(2);
    const invalid = await call(h, "POST", "/api/v1/validate", { records: "not,a,record\n" }, auth);
    expect(invalid.status).toBe(200);
    expect(field(await invalid.json(), "exit_code")).toBe(1);
    expect(h.sent).toHaveLength(0);
  });

  test("[integration] API-NOOUT run rejects any `out` (the HTTP run writes no server file), before any provider call or write", async () => {
    const h = harness();
    const before = filesUnder(h.dir);
    const auth = { ...bearer(h.token), "x-jev-key": "k-jev" };
    const run = { questions: QUESTIONS, cases: CASES, arms: { jev: true, llm: false } };
    for (const out of [join(h.dir, "new.csv"), join(h.dir, "state", "api-tokens.json"), "records.csv", "", null]) {
      const res = await call(h, "POST", "/api/v1/run", { ...run, out }, auth);
      expect(res.status).toBe(400);
      const body: unknown = await res.json();
      expect(field(body, "code")).toBe("invalid-input");
      expect(String(field(body, "errors", 0))).toContain("out");
    }
    expect(h.sent).toHaveLength(0);
    expect(filesUnder(h.dir)).toEqual(before);
    const fine = await call(h, "POST", "/api/v1/run", run, auth);
    expect(fine.status).toBe(200);
    expect(field(await fine.json(), "out")).toBeUndefined();
    expect(filesUnder(h.dir)).toEqual(before);
  });

  test("[integration] API-LIMITS cases, questions, budget and body size are capped before any provider call", async () => {
    const h = harness();
    const auth = { ...bearer(h.token), "x-jev-key": "k-jev" };
    const many = Array.from({ length: API_V1_LIMITS.maxCases + 1 }, (_, i) => ({ id: `c${i}`, input: M0_TEXT }));
    expect((await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: many, arms: { jev: true, llm: false } }, auth)).status).toBe(400);
    expect((await call(h, "POST", "/api/v1/estimate", { questions: QUESTIONS, cases: many }, auth)).status).toBe(400);
    const questions = Array.from({ length: API_V1_LIMITS.maxQuestions + 1 }, (_, i) => ({ name: `q${i}`, type: "noul", instructions: "Is it?" }));
    expect((await call(h, "POST", "/api/v1/ask", { questions, case: CASES[0] }, auth)).status).toBe(400);
    const overBudget = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms: { jev: true, llm: false }, options: { budgetUsd: API_V1_LIMITS.maxBudgetUsd + 1 } }, auth);
    expect(overBudget.status).toBe(400);
    expect(String(field(await overBudget.json(), "errors", 0))).toContain(`${API_V1_LIMITS.maxBudgetUsd}`);
    const big = await call(h, "POST", "/api/v1/validate", { records: "x".repeat(API_V1_LIMITS.maxBodyBytes) }, auth);
    expect(big.status).toBe(413);
    expect(h.sent).toHaveLength(0);
    const capped = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms: { jev: true, llm: false }, options: { budgetUsd: 0 } }, auth);
    expect(capped.status).toBe(200);
    expect(field(await capped.json(), "stoppedByBudget")).toBe(true);
    expect(h.sent).toHaveLength(0);
    // The default cap applies when the caller sets none: a run needing more than it stops by budget.
    expect(API_V1_LIMITS.defaultBudgetUsd).toBeGreaterThan(0);
    expect(API_V1_LIMITS.defaultBudgetUsd).toBeLessThanOrEqual(API_V1_LIMITS.maxBudgetUsd);
  });

  test("[integration] API-NOCLI the claude-cli transport is never chosen on HTTP: no x-anthropic-key is a named llm error, 0 spawns", async () => {
    const h = harness({}, () => "claude");
    const auth = { ...bearer(h.token), "x-jev-key": "k-jev" };
    const res = await call(h, "POST", "/api/v1/ask", { questions: QUESTIONS, case: CASES[0], arms: { jev: false, llm: "claude-haiku-5-5" } }, auth);
    expect(res.status).toBe(200);
    const rows = list(field(await res.json(), "rows"));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(field(row, "answerer")).toBe("llm");
      expect(field(row, "outcome")).toBe("error");
      expect(field(row, "evidence", "reason")).toBe("missing key: llm needs keys.anthropic");
    }
    const arms = await call(h, "GET", "/api/v1/arms", null, bearer(h.token));
    const llm = list(field(await arms.json(), "arms")).find((a) => field(a, "arm") === "llm");
    expect(field(llm, "transports")).toEqual(["messages-api"]);
    expect(field(llm, "transportNow")).toBe(null);
    expect(h.spawned()).toBe(0);
    expect(h.sent).toHaveLength(0);
    // With the key the llm answers through the Messages API.
    const keyed = await call(h, "POST", "/api/v1/ask", { questions: QUESTIONS, case: CASES[0], arms: { jev: false, llm: "claude-haiku-5-5" } }, { ...auth, "x-anthropic-key": "k-anthropic" });
    const keyedRows = list(field(await keyed.json(), "rows"));
    expect(keyedRows.map((r) => field(r, "evidence", "transport"))).toEqual(["messages-api", "messages-api", "messages-api"]);
    expect(h.spawned()).toBe(0);
  });

  test("[integration] API-NOSERVERKEYS keys in the server env and the funded trial key are never used for an API caller", async () => {
    const saved = { JEV_API_KEY: process.env.JEV_API_KEY, OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY };
    process.env.JEV_API_KEY = "server-held-jev";
    process.env.OPENAI_API_KEY = "server-held-openai";
    process.env.ANTHROPIC_API_KEY = "server-held-anthropic";
    process.env.TYPESAFE_API_KEY = "server-held-typesafe";
    try {
      const h = harness();
      const res = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms: ALL_ARMS }, bearer(h.token));
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      const reasons = new Set(list(field(body, "rows")).map((r) => field(r, "evidence", "reason")));
      expect([...reasons].sort()).toEqual(["missing key: decisions needs keys.openai", "missing key: jev needs keys.jev", "missing key: llm needs keys.anthropic"]);
      expect(field(body, "calls")).toBe(0);
      expect(h.sent).toHaveLength(0);
      expect(h.spawned()).toBe(0);
      const arms = list(field(await (await call(h, "GET", "/api/v1/arms", null, bearer(h.token))).json(), "arms"));
      expect(arms.map((a) => field(a, "keySet"))).toEqual([false, false, false, false]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("[integration] API-NOCORS no response carries an access-control header, a preflight included", async () => {
    const h = harness();
    const responses = [
      await h.handler(new Request(BASE + "/api/v1/ask", { method: "OPTIONS", headers: { origin: "https://evil.test", "access-control-request-method": "POST" } })),
      await call(h, "GET", "/api/v1/arms", null, { ...bearer(h.token), origin: "https://evil.test" }),
      await call(h, "GET", "/api/v1/arms", null, { origin: "https://evil.test" }),
      await call(h, "POST", "/api/v1/estimate", GOOD["/api/v1/estimate"], { ...bearer(h.token), origin: "https://evil.test" }),
    ];
    expect(responses.map((r) => r.status)).toEqual([401, 200, 401, 200]);
    for (const r of responses) expect([...r.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
  });

  test("[integration] API-SEPARATE a bearer token opens no browser route, and the browser routes answer as before", async () => {
    const h = harness({ requireSession: true });
    const gated = await call(h, "GET", "/api/backstage/health", null, bearer(h.token));
    expect(gated.status).toBe(401);
    expect(await gated.json()).toEqual({ code: "unauthenticated" });
    const page = await call(h, "GET", "/backstage/", null, bearer(h.token));
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toContain("/backstage/sign-in");
    expect((await call(h, "GET", "/api/auth/session", null, bearer(h.token))).status).toBe(401);
    const answer = await h.handler(new Request(BASE + "/api/backstage/answer", { method: "POST", headers: { ...bearer(h.token), "content-type": "application/json", origin: BASE }, body: "{}" }));
    expect(answer.status).toBe(401);
    expect((await call(h, "GET", "/api/elsewhere", null, bearer(h.token))).status).toBe(404);
  });

  test("[integration] API-STATEFILE a token file inside the served directory is refused: every route 401", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jnj-api-v1-served-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const site = join(dir, "site");
    const tokensPath = join(site, "api-tokens.json");
    const { token } = mintToken(tokensPath, "served");
    const handler = createHandler({ version: "test", staticRoot: site, log: () => {}, api: { tokensPath } });
    cleanups.push(() => handler.close());
    expect((await handler(new Request(BASE + "/api/v1/arms", { headers: bearer(token) }))).status).toBe(401);
    const unconfigured = createHandler({ version: "test", staticRoot: site, log: () => {} });
    cleanups.push(() => unconfigured.close());
    expect((await unconfigured(new Request(BASE + "/api/v1/arms", { headers: bearer(token) }))).status).toBe(401);
  });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("API-NGINX", () => {
  test("[integration] API-NGINX the gate header nginx sets on /api/v1/ leaves the bearer routes as they were and closes a ..\\ hop into the gated routes", async () => {
    const h = harness({ auth: { sessionSecret: "s".repeat(32) } });
    const gate = { "x-backstage-gate": "session" };
    expect((await call(h, "GET", "/api/v1/arms", null, { ...bearer(h.token), ...gate })).status).toBe(200);
    const anon = await call(h, "GET", "/api/v1/arms", null, gate);
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBe('Bearer realm="jevnotjev-api"');
    // nginx matches ^~ /api/v1/ on /api/v1/..\backstage/health and forwards it raw; Bun resolves it to /api/backstage/health.
    expect((await call(h, "GET", "/api/v1/..\\backstage/health", null)).status).toBe(200);
    expect((await call(h, "GET", "/api/v1/..\\backstage/health", null, gate)).status).toBe(401);
    const page = await call(h, "GET", "/api/v1/..\\..\\backstage/", null, gate);
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toStartWith("/backstage/sign-in?next=");
  });
});

describe("KEY-CANARY", () => {
  test("[integration] KEY-CANARY-HTTP canary keys in all three headers reach the providers and no body, header, log, stdout, stderr or file (m3 == 0)", async () => {
    const canary = `sk-canary-${crypto.randomUUID().replaceAll("-", "")}`;
    const h = harness();
    const before = filesUnder(h.dir);
    const repoBefore = readdirSync(ROOT).sort();
    const captured: string[] = [];
    const realOut = process.stdout.write.bind(process.stdout);
    const realErr = process.stderr.write.bind(process.stderr);
    const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const grab = (chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    };
    process.stdout.write = grab;
    process.stderr.write = grab;
    const grabArgs = (...args: unknown[]): void => {
      captured.push(args.map((a) => String(a)).join(" "));
    };
    console.log = grabArgs;
    console.info = grabArgs;
    console.warn = grabArgs;
    console.error = grabArgs;
    const outputs: string[] = [];
    try {
      const keys = { "x-jev-key": canary, "x-openai-key": canary, "x-anthropic-key": canary };
      const auth = { ...bearer(h.token), ...keys };
      const requests: [string, string, unknown][] = [
        ["GET", "/api/v1/arms", null],
        ["POST", "/api/v1/estimate", { questions: QUESTIONS, cases: CASES, arms: ALL_ARMS }],
        ["POST", "/api/v1/ask", { questions: QUESTIONS, case: CASES[0], arms: ALL_ARMS }],
        ["POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms: ALL_ARMS }],
        ["POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms: ALL_ARMS, options: { budgetUsd: 0 } }],
        ["POST", "/api/v1/ask", { questions: QUESTIONS, case: CASES[0], arms: { llm: "claude-haiku-latest" } }],
        ["POST", "/api/v1/ask", "{broken"],
        ["POST", "/api/v1/verdict", { records: USE_JEV_CSV }],
        ["POST", "/api/v1/verdict", { records: "broken\n" }],
        ["POST", "/api/v1/validate", { records: USE_JEV_CSV }],
        ["POST", "/api/v1/nope", {}],
      ];
      const statuses: number[] = [];
      for (const [method, path, body] of requests) {
        const res = await call(h, method, path, body, auth);
        statuses.push(res.status);
        outputs.push(await res.text(), JSON.stringify([...res.headers.entries()]));
      }
      // Unauthenticated requests carrying the canary keys.
      for (const headers of [keys, { ...keys, authorization: `Bearer ${canary}` }]) {
        const res = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms: ALL_ARMS }, headers);
        statuses.push(res.status);
        outputs.push(await res.text(), JSON.stringify([...res.headers.entries()]));
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 400, 400, 200, 400, 200, 404, 401, 401]);
      // The keys did their job: every provider request carried the canary, and the arms answered.
      expect(h.sent.length).toBe(3 + 6);
      for (const init of h.sent) expect(Object.values(init.headers).join(" ")).toContain(canary);
      const asked = json(outputs[4] ?? "null");
      expect(list(field(asked, "rows")).every((r) => field(r, "outcome") === "answered")).toBe(true);
    } finally {
      process.stdout.write = realOut;
      process.stderr.write = realErr;
      Object.assign(console, realConsole);
    }
    const written = filesUnder(h.dir);
    expect(written).toEqual(before);
    expect(readdirSync(ROOT).sort()).toEqual(repoBefore);
    const haystack = [...outputs, ...h.logs, ...captured, ...written.map((f) => readFileSync(f, "utf8"))].join("\n");
    const leaks = haystack.split(canary).length - 1;
    expect(leaks).toBe(0);
    expect(h.logs.length).toBeGreaterThan(0);
  });
});

function verdictFixture(name: string): string {
  return readFileSync(join(ROOT, "examples", "d08-verdicts", `${name}.csv`), "utf8");
}

describe("API-VERDICT exit codes over HTTP", () => {
  test("[integration] API-VERDICT-3 r2-jev-worse answers 200 with exit_code 3, don't use Jev", async () => {
    const h = harness();
    const res = await call(h, "POST", "/api/v1/verdict", { records: verdictFixture("r2-jev-worse") }, bearer(h.token));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(field(body, "exit_code")).toBe(3);
    expect(field(body, "verdicts", 0, "verdict")).toBe("don't use Jev");
  });

  test("[integration] API-VERDICT-4 r1-29-paired answers 200 with exit_code 4, not enough evidence", async () => {
    const h = harness();
    const res = await call(h, "POST", "/api/v1/verdict", { records: verdictFixture("r1-29-paired") }, bearer(h.token));
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(field(body, "exit_code")).toBe(4);
    expect(field(body, "verdicts", 0, "verdict")).toBe("not enough evidence");
  });
});

describe("API-HEAD", () => {
  test("[integration] API-HEAD an authenticated HEAD on /arms is 200 with no body; without a token it is 401", async () => {
    const h = harness();
    const res = await call(h, "HEAD", "/api/v1/arms", null, bearer(h.token));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect((await call(h, "HEAD", "/api/v1/arms", null, {})).status).toBe(401);
    const run = await call(h, "HEAD", "/api/v1/run", null, bearer(h.token));
    expect(run.status).toBe(405);
    expect(run.headers.get("allow")).toBe("POST");
  });
});

describe("API-CSV", () => {
  test("[integration] API-CSV run with options.format csv returns records that, once labelled, verdict answers with 200", async () => {
    const h = harness();
    const auth = { ...bearer(h.token), "x-jev-key": "k-jev", "x-anthropic-key": "k-anthropic" };
    const arms = { jev: true, llm: "claude-haiku-5-5" };
    const res = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms, options: { format: "csv" } }, auth);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(field(body, "rows")).toBeUndefined();
    expect(field(body, "calls")).toBe(4);
    const records = field(body, "records");
    if (typeof records !== "string") throw new Error("records is not a string");
    const { header, rows } = readDictRows(records);
    if (header === null) throw new Error("no header");
    expect(rows).toHaveLength(CASES.length * 2 * QUESTIONS.length);
    const at = (name: string): number => header.indexOf(name);
    expect(rows.every((r) => r.fields[at("outcome")] === "answered")).toBe(true);
    // A person labels every answered row as accepted, with the label provenance a labelled 1.2 row carries.
    const labels: Readonly<Record<string, string>> = { label: "accept", label_source: "human", labelled_by: "tester", labelled_at: "2026-10-08", label_blind: "true" };
    const labelled = formatRows([header, ...rows.map((r) => r.fields.map((v, i) => labels[header[i] ?? ""] ?? v))]);
    const verdict = await call(h, "POST", "/api/v1/verdict", { records: labelled }, bearer(h.token));
    expect(verdict.status).toBe(200);
    expect(field(await verdict.json(), "exit_code")).toBe(4);
    const valid = await call(h, "POST", "/api/v1/validate", { records: labelled }, bearer(h.token));
    expect(field(await valid.json(), "valid")).toBe(true);
    // The default is unchanged: rows inline. An unknown format is a 400 before any call.
    const sentBefore = h.sent.length;
    const plain = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms }, auth);
    expect(list(field(await plain.json(), "rows"))).toHaveLength(12);
    const xml = await call(h, "POST", "/api/v1/run", { questions: QUESTIONS, cases: CASES, arms, options: { format: "xml" } }, auth);
    expect(xml.status).toBe(400);
    expect(h.sent.length).toBe(sentBefore + 4);
  });
});

describe("API-ABORT", () => {
  const TEN = Array.from({ length: API_V1_LIMITS.maxCases }, (_, i) => ({ id: `c${i}`, input: M0_TEXT }));

  /** createApiV1 on its own, with a counting slot, so a test can see the slot come back. */
  function direct(fetch: DecideFetch, deadlineMs?: number): { api: ReturnType<typeof createApiV1>; token: string; slot: ApiSlot; slots: { acquired: number; released: number } } {
    const dir = mkdtempSync(join(tmpdir(), "jnj-api-v1-abort-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tokensPath = join(dir, "state", "api-tokens.json");
    const { token } = mintToken(tokensPath, "abort-test");
    const slots = { acquired: 0, released: 0 };
    const slot: ApiSlot = {
      acquire: () => {
        slots.acquired += 1;
        return true;
      },
      release: () => {
        slots.released += 1;
      },
    };
    const api = createApiV1({
      tokens: new ApiTokenStore(tokensPath),
      deps: { fetch, which: () => null },
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    });
    return { api, token, slot, slots };
  }

  /** A provider that answers from the fixture after `delayOf(n)` ms and, like the real fetch, rejects once its signal aborts. */
  function slowProvider(delayOf: (n: number) => number, onCall: (n: number) => void = () => {}): { fetch: DecideFetch; calls: () => number } {
    const fx = fixtureDeps(fixtureSet());
    let n = 0;
    const fetch: DecideFetch = (url, init) => {
      n += 1;
      onCall(n);
      return new Promise<Response>((resolveCall, rejectCall) => {
        if (init.signal?.aborted === true) return rejectCall(new Error("aborted"));
        const timer = setTimeout(() => {
          if (fx.fetch === undefined) rejectCall(new Error("no fixture fetch"));
          else resolveCall(fx.fetch(url, init));
        }, delayOf(n));
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          rejectCall(new Error("aborted"));
        }, { once: true });
      });
    };
    return { fetch, calls: () => n };
  }

  function runRequest(token: string, signal?: AbortSignal): Request {
    return new Request(BASE + "/api/v1/run", {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json", "x-jev-key": "k-jev" },
      body: JSON.stringify({ questions: QUESTIONS, cases: TEN, arms: { jev: true, llm: false } }),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  test("[integration] API-ABORT a client that disconnects mid-run stops new provider calls and frees the slot", async () => {
    const controller = new AbortController();
    // Call 1 answers; call 2 would hang for a minute, and the client goes away while it is in flight.
    const provider = slowProvider((n) => (n === 1 ? 5 : 60_000), (n) => {
      if (n === 2) setTimeout(() => controller.abort(), 20);
    });
    const d = direct(provider.fetch);
    const started = performance.now();
    const done = await d.api(runRequest(d.token, controller.signal), "/api/v1/run", d.slot);
    expect(performance.now() - started).toBeLessThan(5_000);
    await Bun.sleep(50);
    expect(provider.calls()).toBe(2);
    expect(d.slots).toEqual({ acquired: 1, released: 1 });
    const body: unknown = await done.response.json();
    expect(field(body, "stoppedByAbort")).toBe(true);
    expect(field(body, "counts", "jev", "answered")).toBe(QUESTIONS.length);
    expect(field(body, "counts", "jev", "incomplete")).toBe((TEN.length - 1) * QUESTIONS.length);
    const reasons = new Set(list(field(body, "rows")).slice(QUESTIONS.length).map((r) => field(r, "evidence", "reason")));
    expect([...reasons]).toEqual(["aborted"]);
  });

  test("[integration] API-DEADLINE a run past its per-request deadline stops calling and marks the rest incomplete", async () => {
    expect(API_V1_LIMITS.requestDeadlineMs).toBeLessThan(API_V1_LIMITS.requestTimeoutSeconds * 1000);
    expect(API_V1_LIMITS.requestDeadlineMs).toBeGreaterThan(API_V1_LIMITS.providerTimeoutMs);
    const provider = slowProvider(() => 40);
    const d = direct(provider.fetch, 100);
    const done = await d.api(runRequest(d.token), "/api/v1/run", d.slot);
    await Bun.sleep(100);
    expect(provider.calls()).toBeGreaterThan(0);
    expect(provider.calls()).toBeLessThan(TEN.length);
    expect(d.slots).toEqual({ acquired: 1, released: 1 });
    const body: unknown = await done.response.json();
    expect(field(body, "stoppedByAbort")).toBe(true);
    expect(Number(field(body, "counts", "jev", "incomplete"))).toBeGreaterThan(0);
  });
});
