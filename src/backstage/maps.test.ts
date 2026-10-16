import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHandler } from "./server.ts";
import { checkMap, MapStore, MAX_MAP_BODY } from "./maps.ts";
import { addClaude, buildShare, newClaudeState, newCodexState, parseClaudeLine, summarise } from "../../skills/tokenmax-map/scripts/map.ts";

const ORIGIN = "http://localhost:3456";
const KEY = "k".repeat(22) + "AbC_-0123456789xyzQRSTU";
const ALIAS = "builder-ab12";

const payload = {
  v: "tm-share/1",
  skill: "0.3.0",
  days: 7,
  sources: "claude+codex",
  sessions: 12,
  subagent_sessions: 4,
  caps: { short: 2, weekly: 1, unknown: 0 },
  output_tokens: { claude: 1_234_567, codex: 89_000 },
  opus_share_pct: 61,
  codex_weekly_pct: 42,
};
const body = { payload, alias: ALIAS, request_key: KEY, nickname: "" };

function setup(withStore = true, start = Date.UTC(2026, 9, 16, 12)): {
  handler: ReturnType<typeof createHandler>;
  path: string;
  logs: string[];
  tick: (ms: number) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "maps-"));
  const path = join(dir, "maps.sqlite");
  const logs: string[] = [];
  let now = start;
  const handler = createHandler({
    version: "test",
    origin: ORIGIN,
    staticRoot: join(dir, "site"),
    ...(withStore ? { maps: { path } } : {}),
    log: (line) => logs.push(line),
    auth: { clock: () => now },
  });
  return { handler, path, logs, tick: (ms) => { now += ms; } };
}

type Init = { ip?: string; origin?: string; type?: string; site?: string; length?: string };
function post(route: string, data: unknown, init: Init = {}): [Request, { remoteAddress: string }] {
  const headers: Record<string, string> = { origin: init.origin ?? ORIGIN, "content-type": init.type ?? "application/json" };
  if (init.site) headers["sec-fetch-site"] = init.site;
  if (init.length) headers["content-length"] = init.length;
  return [
    new Request(`${ORIGIN}${route}`, { method: "POST", headers, body: typeof data === "string" ? data : JSON.stringify(data) }),
    { remoteAddress: init.ip ?? "203.0.113.7" },
  ];
}

async function board(handler: ReturnType<typeof createHandler>): Promise<{ rows: Record<string, unknown>[]; totals: Record<string, unknown> }> {
  const response = await handler(new Request(`${ORIGIN}/api/maps`));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || !("rows" in data) || !("totals" in data) || !Array.isArray(data.rows)) throw new Error("bad board");
  const rows: Record<string, unknown>[] = [];
  for (const row of data.rows) if (typeof row === "object" && row !== null) rows.push(Object.fromEntries(Object.entries(row)));
  const totals = typeof data.totals === "object" && data.totals !== null ? Object.fromEntries(Object.entries(data.totals)) : {};
  return { rows, totals };
}

function rowCount(path: string): number {
  const store = new MapStore(path);
  try { return store.count(); } finally { store.close(); }
}

const withPayload = (patch: Record<string, unknown>): Record<string, unknown> => ({ ...body, payload: { ...payload, ...patch } });
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

// Every schema-breaking body named in the matrix, with the code and field the server must answer.
const REJECTED: { name: string; body: unknown; code: string; field?: string }[] = [
  { name: "1 extra top-level key", body: { ...body, email: "a@b.co" }, code: "bad-body", field: "email" },
  { name: "2 extra payload key", body: withPayload({ project: "acme" }), code: "bad-payload", field: "project" },
  { name: "3 extra caps key", body: withPayload({ caps: { ...payload.caps, daily: 1 } }), code: "bad-payload", field: "caps.daily" },
  { name: "4 __proto__ in payload", body: JSON.parse(JSON.stringify(body).replace('"v":', '"__proto__":{"x":1},"v":')), code: "bad-payload", field: "__proto__" },
  { name: "4 constructor in payload", body: JSON.parse(JSON.stringify(body).replace('"v":', '"constructor":1,"v":')), code: "bad-payload", field: "constructor" },
  { name: "4 __proto__ in caps", body: JSON.parse(JSON.stringify(body).replace('"short":', '"__proto__":{},"short":')), code: "bad-payload", field: "caps.__proto__" },
  { name: "5 string sessions", body: withPayload({ sessions: "5" }), code: "bad-payload", field: "sessions" },
  { name: "6 float days", body: withPayload({ days: 7.5 }), code: "bad-payload", field: "days" },
  { name: "7 negative caps.short", body: withPayload({ caps: { ...payload.caps, short: -1 } }), code: "bad-payload", field: "caps.short" },
  { name: "8 oversize tokens", body: withPayload({ output_tokens: { claude: 1e13, codex: 0 } }), code: "bad-payload", field: "output_tokens.claude" },
  { name: "8 1e400 parsed as Infinity", body: JSON.parse(JSON.stringify(body).replace('"codex":89000', '"codex":1e400')), code: "bad-payload", field: "output_tokens.codex" },
  { name: "9 boolean integer", body: withPayload({ opus_share_pct: true }), code: "bad-payload", field: "opus_share_pct" },
  { name: "9 null integer", body: withPayload({ sessions: null }), code: "bad-payload", field: "sessions" },
  { name: "9 null caps.weekly", body: withPayload({ caps: { ...payload.caps, weekly: null } }), code: "bad-payload", field: "caps.weekly" },
  { name: "10 missing v", body: { ...body, payload: without(payload, "v") }, code: "bad-payload", field: "v" },
  { name: "10 v tm-share/2", body: withPayload({ v: "tm-share/2" }), code: "bad-payload", field: "v" },
  { name: "10 missing skill", body: { ...body, payload: without(payload, "skill") }, code: "bad-payload", field: "skill" },
  { name: "10 skill latest", body: withPayload({ skill: "latest" }), code: "bad-payload", field: "skill" },
  { name: "11 sources gemini", body: withPayload({ sources: "gemini" }), code: "bad-payload", field: "sources" },
  { name: "11 sources array", body: withPayload({ sources: ["claude"] }), code: "bad-payload", field: "sources" },
  { name: "12 subagents over sessions", body: withPayload({ sessions: 3, subagent_sessions: 4 }), code: "bad-payload", field: "subagent_sessions" },
  { name: "13 opus percent 101", body: withPayload({ opus_share_pct: 101 }), code: "bad-payload", field: "opus_share_pct" },
  { name: "13 weekly percent 101", body: withPayload({ codex_weekly_pct: 101 }), code: "bad-payload", field: "codex_weekly_pct" },
  { name: "14 payload array", body: { ...body, payload: [payload] }, code: "bad-payload", field: "payload" },
  { name: "14 payload string", body: { ...body, payload: JSON.stringify(payload) }, code: "bad-payload", field: "payload" },
  ...["ab", "a".repeat(25), "Bob", "bob smith", "bob.smith", "a@b.co", "bob@example.com"].map((alias) => ({ name: `15 alias ${alias}`, body: { ...body, alias }, code: "bad-alias", field: "alias" })),
  { name: "16 short request key", body: { ...body, request_key: "abcdefghij" }, code: "bad-request-key", field: "request_key" },
  { name: "16 request key with /", body: { ...body, request_key: `${KEY.slice(0, 30)}/x` }, code: "bad-request-key", field: "request_key" },
  { name: "17 missing payload", body: without(body, "payload"), code: "bad-payload", field: "payload" },
  { name: "17 missing alias", body: without(body, "alias"), code: "bad-alias", field: "alias" },
  { name: "17 missing request_key", body: without(body, "request_key"), code: "bad-request-key", field: "request_key" },
  { name: "body is an array", body: [body], code: "bad-body" },
  { name: "days out of range", body: withPayload({ days: 91 }), code: "bad-payload", field: "days" },
  { name: "missing codex_weekly_pct", body: { ...body, payload: without(payload, "codex_weekly_pct") }, code: "bad-payload", field: "codex_weekly_pct" },
  { name: "caps missing a key", body: withPayload({ caps: { short: 1, weekly: 1 } }), code: "bad-payload", field: "caps.unknown" },
];

describe("checkMap schema", () => {
  test("[unit] the contract example is accepted and re-serialised in contract order", () => {
    const shuffled = { ...body, payload: { codex_weekly_pct: 42, ...without(payload, "codex_weekly_pct") } };
    const checked = checkMap(shuffled);
    if (!checked.ok || "trap" in checked) throw new Error("expected accept");
    expect(Object.keys(checked.map.payload)).toEqual(Object.keys(payload));
    expect(checked.map.payload).toEqual({ ...payload, v: "tm-share/1", sources: "claude+codex" });
    expect(checked.map.alias).toBe(ALIAS);
  });

  test("[unit] 9 a null codex_weekly_pct is accepted", () => {
    expect(checkMap(withPayload({ codex_weekly_pct: null })).ok).toBe(true);
  });

  for (const row of REJECTED) {
    test(`[unit] rejects ${row.name}`, () => {
      const checked = checkMap(row.body);
      expect(checked.ok).toBe(false);
      if (checked.ok) return;
      expect(String(checked.code)).toBe(row.code);
      if (row.field !== undefined) expect(checked.field).toBe(row.field);
      expect(checked.reason.length).toBeGreaterThan(0);
    });
  }

  test("[unit] 32 M4 every rejected fixture is refused", () => {
    const accepted = REJECTED.filter((row) => checkMap(row.body).ok).length;
    console.info(`M4 accepted_bad=${accepted} of ${REJECTED.length}`);
    expect(accepted).toBe(0);
  });

  test("[unit] a filled honeypot on a valid body is a trap, never a map", () => {
    expect(checkMap({ ...body, nickname: "bot" })).toEqual({ ok: true, trap: true });
  });
});

describe("/api/maps route", () => {
  test("[integration] 18 a valid body stores one row and answers id, delete link and board", async () => {
    const { handler, path } = setup();
    const response = await handler(...post("/api/maps", body));
    expect(response.status).toBe(200);
    const data: unknown = await response.json();
    if (typeof data !== "object" || data === null || !("id" in data) || typeof data.id !== "string") throw new Error("no id");
    expect(data.id).toMatch(/^TM-[0-9A-F]{12}$/);
    expect(data).toMatchObject({ replay: false, delete: `/maps/#delete=${data.id}.${KEY}` });
    expect(data).toHaveProperty("board.rows.0.id", data.id);
    expect(rowCount(path)).toBe(1);
    expect((await board(handler)).rows[0]?.id).toBe(data.id);
  });

  test("[integration] 19 the same key and body replays the same id", async () => {
    const { handler, path } = setup();
    const first: unknown = await (await handler(...post("/api/maps", body))).json();
    const again = await handler(...post("/api/maps", body));
    expect(again.status).toBe(200);
    const second: unknown = await again.json();
    const id = (v: unknown): unknown => (typeof v === "object" && v !== null && "id" in v ? v.id : null);
    expect(id(second)).toBe(id(first));
    expect(second).toMatchObject({ replay: true });
    expect(rowCount(path)).toBe(1);
  });

  test("[integration] 20 the same key with another alias or payload is 409", async () => {
    const { handler, path } = setup();
    await handler(...post("/api/maps", body));
    for (const changed of [{ ...body, alias: "builder-zz99" }, withPayload({ sessions: 13 })]) {
      const response = await handler(...post("/api/maps", changed, { ip: "198.51.100.1" }));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: "request-key-reused" });
    }
    expect(rowCount(path)).toBe(1);
  });

  test("[integration] 21 a filled honeypot answers ok and stores nothing", async () => {
    const { handler, path } = setup();
    const response = await handler(...post("/api/maps", { ...body, nickname: "bot" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(rowCount(path)).toBe(0);
  });

  test("[integration] 22 a foreign origin or a cross-site fetch is 403", async () => {
    const { handler, path } = setup();
    const foreign = await handler(...post("/api/maps", body, { origin: "https://evil.test" }));
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ code: "origin-rejected" });
    expect((await handler(...post("/api/maps", body, { site: "cross-site" }))).status).toBe(403);
    expect(rowCount(path)).toBe(0);
  });

  test("[integration] 23 text/plain is 415", async () => {
    const { handler } = setup();
    const response = await handler(...post("/api/maps", body, { type: "text/plain" }));
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ code: "json-required" });
  });

  test("[integration] 24 a sixth POST from one address inside ten minutes is 429", async () => {
    const { handler, tick } = setup();
    for (let i = 0; i < 5; i++) expect((await handler(...post("/api/maps", { ...body, request_key: `${KEY.slice(0, 40)}${i}` }))).status).toBe(200);
    const limited = await handler(...post("/api/maps", { ...body, request_key: `${KEY.slice(0, 40)}9` }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ code: "rate-limited" });
    tick(10 * 60_000 + 1);
    expect((await handler(...post("/api/maps", { ...body, request_key: `${KEY.slice(0, 40)}9` }))).status).toBe(200);
  });

  test("[integration] 25 a declared or streamed body over 4096 bytes is 413", async () => {
    const { handler, path } = setup();
    expect((await handler(...post("/api/maps", body, { length: String(MAX_MAP_BODY + 1) }))).status).toBe(413);
    const big = JSON.stringify({ ...body, nickname: "x".repeat(MAX_MAP_BODY) });
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(big)); controller.close(); } });
    const request = new Request(`${ORIGIN}/api/maps`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: stream });
    expect(request.headers.get("content-length")).toBeNull();
    const response = await handler(request, { remoteAddress: "198.51.100.2" });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ code: "too-large" });
    expect(rowCount(path)).toBe(0);
  });

  test("[integration] 26 bad JSON is 400 bad-json", async () => {
    const { handler } = setup();
    const response = await handler(...post("/api/maps", "{not json"));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "bad-json" });
  });

  test("[integration] a schema failure answers 400 with code, field and reason", async () => {
    const { handler, path } = setup();
    const response = await handler(...post("/api/maps", withPayload({ caps: { ...payload.caps, daily: 1 } })));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "bad-payload", field: "caps.daily" });
    expect(rowCount(path)).toBe(0);
  });

  test("[integration] 27 without a maps store every maps route is 503 maps-unavailable", async () => {
    const { handler } = setup(false);
    for (const response of [
      await handler(...post("/api/maps", body)),
      await handler(new Request(`${ORIGIN}/api/maps`)),
      await handler(...post("/api/maps/delete", { id: "TM-000000000000", key: KEY })),
    ]) {
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ code: "maps-unavailable" });
    }
  });

  test("[integration] 28 delete with the right key removes the row once", async () => {
    const { handler } = setup();
    const data: unknown = await (await handler(...post("/api/maps", body))).json();
    const id = typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : "";
    const deleted = await handler(...post("/api/maps/delete", { id, key: KEY }));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect((await board(handler)).rows.length).toBe(0);
    const again = await handler(...post("/api/maps/delete", { id, key: KEY }));
    expect(again.status).toBe(404);
    expect(await again.json()).toEqual({ code: "not-found" });
  });

  test("[integration] 29 delete with a wrong key or an unknown id is 404 and keeps the row", async () => {
    const { handler, path } = setup();
    const data: unknown = await (await handler(...post("/api/maps", body))).json();
    const id = typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : "";
    for (const attempt of [{ id, key: `${KEY.slice(0, -1)}Z` }, { id: "TM-0123456789AB", key: KEY }]) {
      const response = await handler(...post("/api/maps/delete", attempt, { ip: "198.51.100.3" }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "not-found" });
    }
    expect(rowCount(path)).toBe(1);
  });

  test("[integration] delete is same-origin JSON with a 1024-byte cap", async () => {
    const { handler } = setup();
    expect((await handler(...post("/api/maps/delete", { id: "TM-0123456789AB", key: KEY }, { origin: "https://evil.test" }))).status).toBe(403);
    expect((await handler(...post("/api/maps/delete", { id: "TM-0123456789AB", key: KEY }, { type: "text/plain" }))).status).toBe(415);
    expect((await handler(...post("/api/maps/delete", { id: "TM-0123456789AB", key: KEY }, { length: "1025" }))).status).toBe(413);
    expect((await handler(...post("/api/maps/delete", { id: "TM-0123456789AB", key: KEY, extra: 1 }))).status).toBe(400);
  });

  test("[integration] 30 the board lists newest first with totals and no private fields", async () => {
    const { handler, tick } = setup();
    const caps = [{ short: 1, weekly: 0, unknown: 0 }, { short: 0, weekly: 2, unknown: 1 }, { short: 3, weekly: 1, unknown: 0 }];
    const ids: string[] = [];
    for (const [i, c] of caps.entries()) {
      const data: unknown = await (await handler(...post("/api/maps", { ...withPayload({ caps: c }), alias: `builder-0${i}`, request_key: `${KEY.slice(0, 40)}${i}` }))).json();
      ids.push(typeof data === "object" && data !== null && "id" in data && typeof data.id === "string" ? data.id : "");
      tick(i === 0 ? 0 : 60_000);
    }
    const { rows, totals } = await board(handler);
    expect(rows.map((r) => r.id)).toEqual([...ids].reverse());
    expect(totals).toEqual({ builders: 3, cap_episodes: 8, with_weekly_cap: 2 });
    expect(Object.keys(rows[0] ?? {})).toEqual(["id", "alias", "day", "skill", "days", "sources", "sessions", "subagent_sessions", "caps", "output_tokens", "opus_share_pct", "codex_weekly_pct"]);
    expect(rows[0]).toMatchObject({ alias: "builder-02", day: "2026-10-16", caps: caps[2] });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(KEY.slice(0, 40));
    expect(text).not.toContain("tm-share/1");
    expect(text).not.toContain("hash");
  });

  test("[integration] the board keeps at most 100 rows while totals count every row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maps-cap-"));
    const path = join(dir, "maps.sqlite");
    const store = new MapStore(path);
    const checked = checkMap(body);
    if (!checked.ok || "trap" in checked) throw new Error("expected accept");
    for (let i = 0; i < 101; i++) store.issue({ ...checked.map, requestKey: `${KEY.slice(0, 40)}${i}` }, Date.UTC(2026, 9, 16) + i);
    const result = store.board();
    expect(result.rows.length).toBe(100);
    expect(result.totals.builders).toBe(101);
    store.close();
  });

  test("[integration] 31 the store file is mode 0600 and logs carry no key, alias or payload", async () => {
    const { handler, path, logs } = setup();
    await handler(...post("/api/maps", body));
    await handler(...post("/api/maps", { ...body, alias: "Bad Alias" }, { ip: "198.51.100.4" }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(logs.some((line) => line.includes("map.stored"))).toBe(true);
    expect(logs.some((line) => line.includes("map.rejected"))).toBe(true);
    expect(logs.filter((line) => line.includes(KEY) || line.includes(ALIAS) || line.includes("Bad Alias") || line.includes("1234567")).length).toBe(0);
  });

  test("[integration] the stored payload is the canonical re-serialisation", async () => {
    const { path } = setup();
    const store = new MapStore(path);
    const checked = checkMap({ ...body, payload: { codex_weekly_pct: 42, ...without(payload, "codex_weekly_pct") } });
    if (!checked.ok || "trap" in checked) throw new Error("expected accept");
    store.issue(checked.map, Date.UTC(2026, 9, 16));
    expect(store.rawPayloads()).toEqual([JSON.stringify(payload)]);
    store.close();
  });
});

describe("cross-contract with the mapper", () => {
  test("[integration] 33 a payload built by tokenmax-map buildShare from a tiny fixture passes checkMap", () => {
    const from = Date.UTC(2026, 9, 9);
    const to = Date.UTC(2026, 9, 16);
    const claude = newClaudeState();
    const line = (id: string, model: string, output: number, sidechain: boolean): string =>
      JSON.stringify({ type: "assistant", timestamp: "2026-10-15T10:00:00Z", sessionId: `s-${id}`, isSidechain: sidechain, cwd: "/home/x/p", message: { id, model, usage: { input_tokens: 10, output_tokens: output } } });
    const lines = [line("m1", "claude-opus-5-5", 3000, false), line("m2", "claude-sonnet-5", 1000, true)];
    for (const [order, text] of lines.entries()) addClaude(claude, parseClaudeLine(text, { subagent: false, order }), from, to);
    const built = buildShare(summarise(claude, newCodexState()), { days: 7, sources: "claude+codex" });
    expect(built.output_tokens.claude).toBe(4000);
    const checked = checkMap({ payload: JSON.parse(JSON.stringify(built)), alias: ALIAS, request_key: KEY });
    expect(checked).toMatchObject({ ok: true });
    if (checked.ok && !("trap" in checked)) expect(JSON.stringify(checked.map.payload)).toBe(JSON.stringify(built));
  });
});
