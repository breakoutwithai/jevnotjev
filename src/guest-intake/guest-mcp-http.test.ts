// The remote guest MCP endpoint, POST /api/v1/guest/mcp (#362). Every test goes through the real createHandler with a
// real GuestTokenStore, AdminTokenStore, decide token file and QuestionStore on one temporary tickets.sqlite. The SDK's
// own Client reaches the handler through an injected fetch; raw JSON-RPC requests check the wire shape.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { mintToken } from "../backstage/api-tokens.ts";
import { cookie, credentialFingerprint, signSession } from "../backstage/auth.ts";
import { createHandler } from "../backstage/server.ts";
import { createGuestMcpHttp, GUEST_MCP_PATH, GUEST_MCP_REQUEST_BYTES_MAX } from "./guest-mcp-http.ts";
import { createGuestRoutes, GUEST_CHALLENGE, type GuestRoutes } from "./guest-routes.ts";
import { createGuestMcp, GUEST_TOOL_NAMES, TOKEN_ENV } from "./mcp.ts";
import { QuestionStore } from "./store.ts";
import { AdminTokenStore, GuestTokenStore } from "./tokens.ts";

const ORIGIN = "http://localhost:3456";
const SITE = join(import.meta.dir, "..", "..", "site");
const T0 = Date.parse("2026-10-21T09:00:00.000Z");
const SECRET = "s".repeat(48);
const MARKER = "zq-guest-remote-mcp-marker-362";
const REPLY = "zq-guest-remote-mcp-reply-362: start with the fixed choices.";
const ACCEPT = "application/json, text/event-stream";
const URL_MCP = `${ORIGIN}${GUEST_MCP_PATH}`;

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

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

interface Box {
  readonly handler: ReturnType<typeof createHandler>;
  readonly logs: string[];
  readonly guests: GuestTokenStore;
  readonly admins: AdminTokenStore;
  readonly questions: QuestionStore;
  readonly clock: { now: number };
  readonly apiTokensPath: string;
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

function box(opts: { operatorsPath?: string } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), "guest-mcp-http-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const path = join(state, "tickets.sqlite");
  const apiTokensPath = join(root, "api", "api-tokens.json");
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
    auth: { clock: () => clock.now, ...(opts.operatorsPath !== undefined ? { sessionSecret: SECRET, operatorsPath: opts.operatorsPath } : {}) },
  });
  const questions = new QuestionStore(path);
  const guests = new GuestTokenStore(path, () => clock.now);
  const admins = new AdminTokenStore(path, () => clock.now);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => { questions.close(); guests.close(); admins.close(); handler.close(); });
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => handler(new Request(url, init), { remoteAddress: "127.0.0.1" });
  return { handler, logs, guests, admins, questions, clock, apiTokensPath, fetch };
}

let seq = 0;
function freshKey(): string {
  seq += 1;
  return `${String(seq).padStart(4, "0")}${"m".repeat(39)}`;
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-362", version: "0.0.0" } };

function post(token: string | null, body: string, headers: Record<string, string> = {}): Request {
  return new Request(URL_MCP, {
    method: "POST",
    headers: { "content-type": "application/json", accept: ACCEPT, ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    body,
  });
}

async function json(response: Response): Promise<unknown> {
  return JSON.parse(await response.text());
}

/** The SDK's HTTP client transport behind the Transport interface (see admin-mcp-http.test.ts for why). */
function delegate(inner: StreamableHTTPClientTransport): Transport {
  const outer: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion(version),
  };
  inner.onmessage = (message: JSONRPCMessage, extra?: MessageExtraInfo) => outer.onmessage?.(message, extra);
  inner.onerror = (error) => outer.onerror?.(error);
  inner.onclose = () => outer.onclose?.();
  return outer;
}

async function sdkClient(b: Box, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(URL_MCP), { fetch: b.fetch, requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "guest-mcp-http-test", version: "0.0.0" });
  await client.connect(delegate(transport));
  cleanup.push(() => client.close());
  return client;
}

interface Called {
  readonly text: string;
  readonly isError: boolean;
  readonly body: unknown;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content.map((c: unknown) => (typeof field(c, "text") === "string" ? String(field(c, "text")) : "")).join("\n");
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { body = null; }
  return { text, isError: result.isError === true, body };
}

const submitArgs = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ question: `Fixed choices or open help? ${MARKER}`, reply_consent: true, request_key: freshKey(), ...extra });

describe("remote guest MCP credentials and request checks", () => {
  test("[integration] GM-HTTP-1 no token, admin, decide, malformed, unknown, expired, revoked or rotated-away token is 401 with the guest realm", async () => {
    const b = box();
    const live = b.guests.mint("Live");
    const expired = b.guests.mint("Expires", { ttlMs: 60 * 60_000 });
    const revoked = b.guests.mint("Revoked");
    b.guests.revoke(revoked.record.id);
    const rotated = b.guests.mint("Rotated");
    b.guests.rotate(rotated.record.id);
    const admin = b.admins.mint("Operator").token;
    const decide = mintToken(b.apiTokensPath, "decide").token;
    b.clock.now = T0 + 60 * 60_000;
    const bad: (string | null)[] = [null, "", "jng_short", `${live.token}x`, `jng_${"A".repeat(43)}`, admin, decide, expired.token, revoked.token, rotated.token];
    for (const token of bad) {
      for (const req of [post(token, rpc("initialize", INIT)), new Request(URL_MCP, { headers: { accept: "text/event-stream", ...(token === null ? {} : { authorization: `Bearer ${token}` }) } })]) {
        const res = await b.handler(req, { remoteAddress: "127.0.0.1" });
        expect([req.method, String(token).slice(0, 4), res.status]).toEqual([req.method, String(token).slice(0, 4), 401]);
        expect(res.headers.get("www-authenticate")).toBe('Bearer realm="jevnotjev-guest"');
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await json(res)).toEqual({ code: "unauthenticated" });
      }
    }
    expect(GUEST_CHALLENGE).toBe('Bearer realm="jevnotjev-guest"');
    const ok = await b.handler(post(live.token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" });
    expect(ok.status).toBe(200);
    // A token in the query string is not a credential here.
    const query = await b.handler(new Request(`${URL_MCP}?access_token=${live.token}`, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT }, body: rpc("initialize", INIT) }), { remoteAddress: "127.0.0.1" });
    expect(query.status).toBe(401);
  });

  test("[integration] GM-HTTP-COOKIE a signed-in session cookie grants nothing on the remote guest endpoint", async () => {
    const opsDir = mkdtempSync(join(tmpdir(), "guest-mcp-ops-"));
    cleanup.push(() => rmSync(opsDir, { recursive: true, force: true }));
    const operatorsPath = join(opsDir, "operators.json");
    writeFileSync(operatorsPath, JSON.stringify([{ email: "tester@example.test" }]));
    const b = box({ operatorsPath });
    const session = signSession({ email: "tester@example.test", auth: "google", iat: T0, exp: T0 + 3_600_000, sid: "s".repeat(32), cred: credentialFingerprint("google") }, SECRET);
    const sessionCookie = cookie(ORIGIN, "session", session, 3600).split(";")[0] ?? "";
    const check = await b.handler(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: sessionCookie } }), { remoteAddress: "198.51.100.12" });
    expect(check.status).toBe(204);
    const res = await b.handler(post(null, rpc("initialize", INIT), { cookie: sessionCookie }), { remoteAddress: "127.0.0.1" });
    expect([res.status, res.headers.get("www-authenticate"), await json(res)]).toEqual([401, GUEST_CHALLENGE, { code: "unauthenticated" }]);
  });

  test("[integration] GM-HTTP-ORIGIN a foreign Origin is 403 even with a live token; same origin or no Origin passes; a foreign Host is refused", async () => {
    const b = box();
    const { token } = b.guests.mint("Guest");
    for (const origin of ["https://evil.example", "null", "http://localhost:3457", "https://jevnotjev.breakoutwithai.com.evil.example"]) {
      const res = await b.handler(post(token, rpc("initialize", INIT), { origin }), { remoteAddress: "127.0.0.1" });
      expect([origin, res.status]).toEqual([origin, 403]);
      expect(await json(res)).toEqual({ code: "origin-refused" });
    }
    expect((await b.handler(post(token, rpc("initialize", INIT), { origin: ORIGIN }), { remoteAddress: "127.0.0.1" })).status).toBe(200);
    expect((await b.handler(post(token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" })).status).toBe(200);
    const foreignHost = new Request(`http://evil.example${GUEST_MCP_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${token}` }, body: rpc("initialize", INIT) });
    const res = await b.handler(foreignHost, { remoteAddress: "127.0.0.1" });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: "host-refused" });
  });

  test("[integration] GM-HTTP-CAPS an oversize, streamed-oversize, non-JSON or malformed body is refused before any tool runs", async () => {
    const b = box();
    const { token } = b.guests.mint("Guest");
    const big = rpc("tools/call", { name: "list_my_questions", arguments: { pad: "x".repeat(GUEST_MCP_REQUEST_BYTES_MAX) } });
    const declared = await b.handler(post(token, big), { remoteAddress: "127.0.0.1" });
    expect([declared.status, await json(declared)]).toEqual([413, { code: "too-large" }]);
    const encoded = new TextEncoder().encode(big);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoded.slice(0, 40_000)); c.enqueue(encoded.slice(40_000)); c.close(); } });
    const streamed = await b.handler(new Request(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${token}` }, body: stream }), { remoteAddress: "127.0.0.1" });
    expect([streamed.status, await json(streamed)]).toEqual([413, { code: "too-large" }]);
    const text = await b.handler(post(token, rpc("initialize", INIT), { "content-type": "text/plain" }), { remoteAddress: "127.0.0.1" });
    expect([text.status, await json(text)]).toEqual([415, { code: "json-required" }]);
    const broken = await b.handler(post(token, "{not json"), { remoteAddress: "127.0.0.1" });
    expect([broken.status, await json(broken)]).toEqual([400, { code: "bad-json" }]);
    expect(GUEST_MCP_REQUEST_BYTES_MAX).toBe(64 * 1024);
    expect(b.logs.filter((l) => l.includes("guest.mcp.call"))).toHaveLength(0);
  });

  test("[integration] GM-HTTP-GET the stateless endpoint offers no SSE stream: GET and DELETE are 405 Allow: POST once authenticated", async () => {
    const b = box();
    const { token } = b.guests.mint("Guest");
    for (const [method, accept] of [["GET", "text/event-stream"], ["GET", "application/json"], ["DELETE", ACCEPT]] satisfies [string, string][]) {
      const res = await b.handler(new Request(URL_MCP, { method, headers: { accept, authorization: `Bearer ${token}` } }), { remoteAddress: "127.0.0.1" });
      expect([method, accept, res.status, res.headers.get("allow")]).toEqual([method, accept, 405, "POST"]);
      expect(await json(res)).toEqual({ code: "method-not-allowed" });
    }
  });
});

describe("remote guest MCP tools over Streamable HTTP", () => {
  test("[integration] GM-HTTP-2 raw JSON-RPC initialize and tools/list: protocol 2025-11-25, stateless, exactly the three guest tools", async () => {
    const b = box();
    const { token } = b.guests.mint("Guest");
    const init = await b.handler(post(token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initBody = await json(init);
    expect(field(initBody, "result", "protocolVersion")).toBe("2025-11-25");
    expect(field(initBody, "result", "serverInfo", "name")).toBe("jevnotjev-guest");
    const note = await b.handler(post(token, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" });
    expect(note.status).toBe(202);
    const list = await b.handler(post(token, rpc("tools/list", {}, 2), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" });
    const tools = field(await json(list), "result", "tools");
    expect(Array.isArray(tools) ? tools.map((t: unknown) => field(t, "name")).sort() : null).toEqual([...GUEST_TOOL_NAMES].sort());
    const raw = await b.handler(post(token, rpc("tools/call", { name: "list_my_questions", arguments: {} }, 3), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" });
    const text = field(await json(raw), "result", "content", 0, "text");
    expect(typeof text === "string" ? JSON.parse(text) : null).toEqual({ questions: [] });
  });

  test("[integration] GM-HTTP-SHARED the SDK client sees the same tools, schemas and annotations over HTTP as the stdio adapter", async () => {
    const b = box();
    const { token } = b.guests.mint("Guest");
    const remote = await sdkClient(b, token);
    const stdio = createGuestMcp({ env: { [TOKEN_ENV]: token }, origin: "http://127.0.0.1:9", fetch: async (url, init) => b.fetch(url, init) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await stdio.connect(serverSide);
    const local = new Client({ name: "stdio-compare", version: "0.0.0" });
    await local.connect(clientSide);
    cleanup.push(() => local.close());
    const byName = (list: { name: string }[]): { name: string }[] => [...list].sort((x, y) => x.name.localeCompare(y.name));
    const remoteTools = byName((await remote.listTools()).tools);
    expect(remoteTools.map((t) => t.name)).toEqual([...GUEST_TOOL_NAMES].sort());
    expect(remoteTools).toEqual(byName((await local.listTools()).tools));
    const tool = (name: string): unknown => remoteTools.find((t) => t.name === name);
    expect(field(tool("list_my_questions"), "annotations", "readOnlyHint")).toBe(true);
    expect(field(tool("get_my_question"), "annotations", "readOnlyHint")).toBe(true);
    expect(field(tool("submit_question"), "annotations")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(remote.getServerVersion()?.name).toBe("jevnotjev-guest");
  });

  test("[integration] GM-HTTP-3 submit, replay, list and read run end to end; a guest sees only its own rows and another guest's id is 404", async () => {
    const b = box();
    const alice = b.guests.mint("Guest A");
    const bob = b.guests.mint("Guest B");
    const publicRow = b.questions.submit("public", { email: "visitor@example.test", question: "A public question", replyConsent: true, marketingConsent: false, requestKey: freshKey() }, T0);
    if (publicRow.status !== "issued") throw new Error(`seed failed: ${publicRow.status}`);
    const a = await sdkClient(b, alice.token);
    const args = submitArgs();
    const sent = await call(a, "submit_question", args);
    expect([sent.isError, field(sent.body, "state"), field(sent.body, "replay")]).toEqual([false, "pending_review", false]);
    const id = String(field(sent.body, "id"));
    expect((await call(a, "submit_question", args)).body).toEqual({ id, state: "pending_review", replay: true });
    const reused = await call(a, "submit_question", { ...args, question: "A different question" });
    expect([reused.isError, field(reused.body, "error")]).toEqual([true, { code: "request-key-reused", status: 409 }]);
    const listed = await call(a, "list_my_questions");
    expect(listed.body).toEqual({ questions: [{ id, state: "pending_review", created_at: expect.any(String), updated_at: expect.any(String) }] });
    const got = await call(a, "get_my_question", { id });
    expect(got.body).toEqual({ id, state: "pending_review", updated_at: expect.any(String), response: null, response_source: null });
    for (const r of [sent, listed, got]) expect([r.text.includes(MARKER), r.text.includes("email")]).toEqual([false, false]);
    const other = await sdkClient(b, bob.token);
    expect((await call(other, "list_my_questions")).body).toEqual({ questions: [] });
    for (const otherId of [id, publicRow.id]) {
      const miss = await call(other, "get_my_question", { id: otherId });
      expect([miss.isError, field(miss.body, "error")]).toEqual([true, { code: "not-found", status: 404 }]);
    }
    const publicMiss = await call(a, "get_my_question", { id: publicRow.id });
    expect(field(publicMiss.body, "error")).toEqual({ code: "not-found", status: 404 });
    // The stored row is the guest's own, with the guest's principal from the token.
    expect(b.questions.show(id)?.question).toBe(`Fixed choices or open help? ${MARKER}`);
    // The plain guest routes still answer next to the MCP path.
    const plain = await b.handler(new Request(`${ORIGIN}/api/v1/guest/questions`, { headers: { authorization: `Bearer ${alice.token}` } }), { remoteAddress: "127.0.0.1" });
    expect(plain.status).toBe(200);
  });

  test("[integration] GM-HTTP-REVOKE a revoke or expiry applies to the next call of an open client session", async () => {
    const b = box();
    const minted = b.guests.mint("Guest", { ttlMs: 2 * 60 * 60_000 });
    const client = await sdkClient(b, minted.token);
    expect((await call(client, "list_my_questions")).isError).toBe(false);
    b.guests.revoke(minted.record.id);
    await expect(client.callTool({ name: "list_my_questions", arguments: {} })).rejects.toThrow();
    const second = b.guests.mint("Second", { ttlMs: 60 * 60_000 });
    const raw = async (): Promise<number> => (await b.handler(post(second.token, rpc("tools/list", {}, 9), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" })).status;
    expect(await raw()).toBe(200);
    b.clock.now = T0 + 60 * 60_000;
    expect(await raw()).toBe(401);
  });

  test("[integration] GM-HTTP-LOG logs carry event, rid, token id, tool and question id; never the token, question text or request key", async () => {
    const b = box();
    const minted = b.guests.mint("Guest");
    const client = await sdkClient(b, minted.token);
    const args = submitArgs();
    const sent = await call(client, "submit_question", args);
    const id = String(field(sent.body, "id"));
    await call(client, "list_my_questions");
    await call(client, "get_my_question", { id });
    await b.handler(post(b.admins.mint("Operator").token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" });
    await b.handler(post(minted.token, rpc("initialize", INIT), { origin: "https://evil.example" }), { remoteAddress: "127.0.0.1" });
    const text = b.logs.join("\n");
    for (const secret of [minted.token, MARKER, String(args["request_key"]), "Bearer"]) expect([secret.slice(0, 12), text.includes(secret)]).toEqual([secret.slice(0, 12), false]);
    const calls = b.logs.filter((l) => l.includes("guest.mcp.call")).map((l) => JSON.parse(l));
    expect(calls.map((c) => [c.tool, c.id ?? null, c.token])).toEqual([
      ["submit_question", null, minted.record.id],
      ["list_my_questions", null, minted.record.id],
      ["get_my_question", id, minted.record.id],
    ]);
    for (const c of calls) {
      expect(typeof c.rid).toBe("string");
      expect(Object.keys(c).sort()).toEqual(["event", "rid", "token", "tool", "ts", ...(c.id === undefined ? [] : ["id"])].sort());
    }
    const rejected = b.logs.filter((l) => l.includes("guest.mcp.rejected")).map((l) => JSON.parse(l));
    // The SDK client opens its optional GET stream once after initialize; the 405 is the spec's "no stream here".
    expect(rejected.map((r) => r.reason)).toEqual(["method-not-allowed", "unauthenticated", "origin-refused"]);
    for (const r of rejected) expect(Object.keys(r).sort()).toEqual(["event", "reason", "rid", "token", "ts"]);
    expect(b.logs.some((l) => l.includes("guest.question.received"))).toBe(true);
  });

  test("[integration] GM-HTTP-SCRUB the caller's bearer token is redacted from tool results, as the stdio adapter does", async () => {
    const b = box();
    const minted = b.guests.mint("Guest");
    const client = await sdkClient(b, minted.token);
    const id = String(field((await call(client, "submit_question", submitArgs())).body, "id"));
    expect(b.questions.transition(id, "approved", 1, "operator:test", T0).ok).toBe(true);
    expect(b.questions.answer(id, 2, "operator:test", T0, `${REPLY} pasted ${minted.token}`, "human_reviewed").ok).toBe(true);
    const got = await call(client, "get_my_question", { id });
    expect(got.isError).toBe(false);
    expect(got.text).not.toContain(minted.token);
    expect(field(got.body, "response")).toBe(`${REPLY} pasted [redacted]`);
    const stdio = createGuestMcp({ env: { [TOKEN_ENV]: minted.token }, origin: "http://127.0.0.1:9", fetch: async (url, init) => b.fetch(url, init) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await stdio.connect(serverSide);
    const local = new Client({ name: "stdio-scrub", version: "0.0.0" });
    await local.connect(clientSide);
    cleanup.push(() => local.close());
    expect((await call(local, "get_my_question", { id })).text).toBe(got.text);
  });
});

describe("remote guest MCP limits", () => {
  function routesBox(): { routes: GuestRoutes; guests: GuestTokenStore; logs: string[] } {
    const root = mkdtempSync(join(tmpdir(), "guest-mcp-http-limits-"));
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const path = join(state, "tickets.sqlite");
    const logs: string[] = [];
    const routes = createGuestRoutes({ path, clock: () => T0, log: (l) => logs.push(l) });
    const guests = new GuestTokenStore(path, () => T0);
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => { routes.close(); guests.close(); });
    return { routes, guests, logs };
  }

  test("[integration] GM-HTTP-LIMITS a response over the cap is refused; a body that stalls past the deadline is refused", async () => {
    const { routes, guests, logs } = routesBox();
    const { token } = guests.mint("Guest");
    const tiny = createGuestMcpHttp({ routes, origin: ORIGIN, clock: () => T0, log: (l) => logs.push(l), responseBytesMax: 64, timeoutMs: 200 });
    const big = await tiny.handle(post(token, rpc("initialize", INIT)), "127.0.0.1", "rid-1");
    expect([big.status, await json(big)]).toEqual([502, { code: "response-too-large" }]);
    const stall = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"jsonrpc":')); } });
    const slow = await tiny.handle(new Request(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${token}` }, body: stall }), "127.0.0.1", "rid-2");
    expect([slow.status, await json(slow)]).toEqual([408, { code: "body-timeout" }]);
    expect(logs.join("\n")).not.toContain(token);
  });

  test("[integration] GM-HTTP-DEADLINE the deadline starts at request entry: a slow body leaves less time for the tool", async () => {
    const { routes, guests } = routesBox();
    const { token } = guests.mint("Guest");
    // The real guest routes, with 300 ms added before each tool call reaches them.
    const slowRoutes: GuestRoutes = { ...routes, perform: async (c) => { await Bun.sleep(300); return routes.perform(c); } };
    const mcp = createGuestMcpHttp({ routes: slowRoutes, origin: ORIGIN, clock: () => T0, log: () => {}, timeoutMs: 600 });
    const body = new TextEncoder().encode(rpc("tools/call", { name: "list_my_questions", arguments: {} }));
    const send = async (bodyDelayMs: number): Promise<[number, unknown]> => {
      const stream = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(body.slice(0, 10));
          await Bun.sleep(bodyDelayMs);
          c.enqueue(body.slice(10));
          c.close();
        },
      });
      const headers = { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-11-25" };
      const res = await mcp.handle(new Request(URL_MCP, { method: "POST", headers, body: stream }), "127.0.0.1", "rid-deadline");
      return [res.status, res.status === 200 ? field(await json(res), "result", "isError") ?? false : await json(res)];
    };
    // Negative control: a prompt body and the slow tool finish inside 600 ms.
    expect(await send(0)).toEqual([200, false]);
    expect(await send(400)).toEqual([504, { code: "timeout" }]);
  });
});
