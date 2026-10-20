// The remote admin MCP endpoint, POST /api/v1/admin/mcp (#283 phase 1). Every test goes through the real createHandler
// with real AdminTokenStore, GuestTokenStore, decide token file and QuestionStore on one temporary tickets.sqlite. The
// SDK's own Client reaches the handler through an injected fetch; raw JSON-RPC requests check the wire shape.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage, MessageExtraInfo } from "@modelcontextprotocol/sdk/types.js";
import { mintToken } from "../backstage/api-tokens.ts";
import { createHandler } from "../backstage/server.ts";
import { createAdminApi, type AdminApi } from "./admin-api.ts";
import { ADMIN_MCP_PATH, ADMIN_MCP_REQUEST_BYTES_MAX, createAdminMcpHttp } from "./admin-mcp-http.ts";
import { ADMIN_TOKEN_ENV, ADMIN_TOOL_NAMES, createAdminMcp } from "./admin-mcp.ts";
import { QuestionStore } from "./store.ts";
import { AdminTokenStore, GuestTokenStore } from "./tokens.ts";

const ORIGIN = "http://localhost:3456";
const SITE = join(import.meta.dir, "..", "..", "site");
const T0 = Date.parse("2026-10-19T09:00:00.000Z");
const EMAIL = "visitor-mcp283@example.test";
const MARKER = "zq-remote-mcp-marker-283";
const REPLY = "zq-remote-mcp-reply-283: start with the fixed choices.";
const ACCEPT = "application/json, text/event-stream";
const URL_MCP = `${ORIGIN}${ADMIN_MCP_PATH}`;

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
  readonly path: string;
  readonly logs: string[];
  readonly admins: AdminTokenStore;
  readonly guests: GuestTokenStore;
  readonly questions: QuestionStore;
  readonly clock: { now: number };
  readonly apiTokensPath: string;
  readonly fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
}

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), "admin-mcp-http-"));
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
    auth: { clock: () => clock.now },
  });
  const questions = new QuestionStore(path);
  const admins = new AdminTokenStore(path, () => clock.now);
  const guests = new GuestTokenStore(path, () => clock.now);
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  cleanup.push(() => { questions.close(); admins.close(); guests.close(); handler.close(); });
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => handler(new Request(url, init), { remoteAddress: "127.0.0.1" });
  return { handler, path, logs, admins, guests, questions, clock, apiTokensPath, fetch };
}

let seq = 0;
function freshKey(): string {
  seq += 1;
  return `${String(seq).padStart(4, "0")}${"r".repeat(39)}`;
}

function seed(b: Box): { id: string; key: string } {
  const key = freshKey();
  const r = b.questions.submit("public", { email: EMAIL, question: `Fixed choices or open help? ${MARKER}`, replyConsent: true, marketingConsent: false, requestKey: key }, T0 + seq);
  if (r.status !== "issued") throw new Error(`seed failed: ${r.status}`);
  return { id: r.id, key };
}

function rpc(method: string, params: Record<string, unknown> = {}, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INIT = { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-283", version: "0.0.0" } };

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

/** The SDK's own HTTP client transport, delegated through the Transport interface (its sessionId getter returns
 * string | undefined, which exactOptionalPropertyTypes refuses for the optional property). */
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
  const client = new Client({ name: "admin-mcp-http-test", version: "0.0.0" });
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

describe("remote admin MCP credentials and request checks", () => {
  test("[integration] AM-HTTP-1 no token, guest, decide, malformed, unknown, expired, revoked or rotated-away token is 401 with a Bearer challenge", async () => {
    const b = box();
    const live = b.admins.mint("Live");
    const expired = b.admins.mint("Expires", { ttlMs: 60 * 60_000 });
    const revoked = b.admins.mint("Revoked");
    b.admins.revoke(revoked.record.id);
    const rotated = b.admins.mint("Rotated");
    b.admins.rotate(rotated.record.id);
    const guest = b.guests.mint("Guest A").token;
    const decide = mintToken(b.apiTokensPath, "decide").token;
    b.clock.now = T0 + 60 * 60_000;
    const bad: (string | null)[] = [null, "", "jna_short", `${live.token}x`, `jna_${"A".repeat(43)}`, guest, decide, expired.token, revoked.token, rotated.token];
    for (const token of bad) {
      for (const req of [post(token, rpc("initialize", INIT)), new Request(URL_MCP, { headers: { accept: "text/event-stream", ...(token === null ? {} : { authorization: `Bearer ${token}` }) } })]) {
        const res = await b.handler(req, { remoteAddress: "127.0.0.1" });
        expect([req.method, String(token).slice(0, 4), res.status]).toEqual([req.method, String(token).slice(0, 4), 401]);
        const challenge = res.headers.get("www-authenticate") ?? "";
        expect(challenge.startsWith("Bearer")).toBe(true);
        expect(challenge).not.toContain("resource_metadata");
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(await json(res)).toEqual({ code: "unauthenticated" });
      }
    }
    const ok = await b.handler(post(live.token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" });
    expect(ok.status).toBe(200);
    // A session cookie or a token in the query string is not a credential here.
    expect((await b.handler(new Request(`${URL_MCP}?access_token=${live.token}`, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT }, body: rpc("initialize", INIT) }), { remoteAddress: "127.0.0.1" })).status).toBe(401);
  });

  test("[integration] AM-HTTP-ORIGIN a foreign Origin is 403 even with a live token; same origin or no Origin passes; a foreign Host is refused", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    for (const origin of ["https://evil.example", "null", "http://localhost:3457", "https://jevnotjev.breakoutwithai.com.evil.example"]) {
      const res = await b.handler(post(token, rpc("initialize", INIT), { origin }), { remoteAddress: "127.0.0.1" });
      expect([origin, res.status]).toEqual([origin, 403]);
      expect(await json(res)).toEqual({ code: "origin-refused" });
    }
    expect((await b.handler(post(token, rpc("initialize", INIT), { origin: ORIGIN }), { remoteAddress: "127.0.0.1" })).status).toBe(200);
    expect((await b.handler(post(token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" })).status).toBe(200);
    const foreignHost = new Request(`http://evil.example${ADMIN_MCP_PATH}`, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${token}` }, body: rpc("initialize", INIT) });
    const res = await b.handler(foreignHost, { remoteAddress: "127.0.0.1" });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ code: "host-refused" });
  });

  test("[integration] AM-HTTP-CAPS an oversize, streamed-oversize, non-JSON or malformed body is refused before any tool runs", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    const big = rpc("tools/call", { name: "list_questions", arguments: { pad: "x".repeat(ADMIN_MCP_REQUEST_BYTES_MAX) } });
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
    expect(ADMIN_MCP_REQUEST_BYTES_MAX).toBe(64 * 1024);
    expect(b.logs.filter((l) => l.includes("admin.mcp.call"))).toHaveLength(0);
  });

  test("[integration] AM-HTTP-GET the stateless endpoint offers no SSE stream: GET and DELETE are 405 Allow: POST once authenticated", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    for (const [method, accept] of [["GET", "text/event-stream"], ["GET", "application/json"], ["DELETE", ACCEPT]] satisfies [string, string][]) {
      const res = await b.handler(new Request(URL_MCP, { method, headers: { accept, authorization: `Bearer ${token}` } }), { remoteAddress: "127.0.0.1" });
      expect([method, accept, res.status, res.headers.get("allow")]).toEqual([method, accept, 405, "POST"]);
      expect(await json(res)).toEqual({ code: "method-not-allowed" });
    }
  });
});

describe("remote admin MCP tools over Streamable HTTP", () => {
  test("[integration] AM-HTTP-2 raw JSON-RPC initialize and tools/list: protocol 2025-11-25, stateless, exactly the three tools", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    const init = await b.handler(post(token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.headers.get("mcp-session-id")).toBeNull();
    const initBody = await json(init);
    expect(field(initBody, "result", "protocolVersion")).toBe("2025-11-25");
    expect(field(initBody, "result", "serverInfo", "name")).toBe("jevnotjev-admin");
    expect(isRecord(field(initBody, "result", "capabilities", "tools"))).toBe(true);
    const note = await b.handler(post(token, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" });
    expect(note.status).toBe(202);
    const list = await b.handler(post(token, rpc("tools/list", {}, 2), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" });
    expect(list.status).toBe(200);
    const tools = field(await json(list), "result", "tools");
    expect(Array.isArray(tools) ? tools.map((t: unknown) => field(t, "name")).sort() : null).toEqual([...ADMIN_TOOL_NAMES].sort());
    const raw = await b.handler(post(token, rpc("tools/call", { name: "list_questions", arguments: {} }, 3), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" });
    const text = field(await json(raw), "result", "content", 0, "text");
    expect(typeof text === "string" ? JSON.parse(text) : null).toEqual({ total: 0, questions: [] });
  });

  test("[integration] AM-HTTP-SHARED the SDK client sees the same tools, schemas and annotations over HTTP as the stdio adapter", async () => {
    const b = box();
    const { token } = b.admins.mint("Operator");
    const remote = await sdkClient(b, token);
    const stdio = createAdminMcp({ env: { [ADMIN_TOKEN_ENV]: token }, origin: "http://127.0.0.1:9", fetch: async (url, init) => b.fetch(url, init) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await stdio.connect(serverSide);
    const local = new Client({ name: "stdio-compare", version: "0.0.0" });
    await local.connect(clientSide);
    cleanup.push(() => local.close());
    const byName = (list: { name: string }[]): { name: string }[] => [...list].sort((x, y) => x.name.localeCompare(y.name));
    const remoteTools = byName((await remote.listTools()).tools);
    expect(remoteTools.map((t) => t.name)).toEqual([...ADMIN_TOOL_NAMES].sort());
    expect(remoteTools).toEqual(byName((await local.listTools()).tools));
    const tool = (name: string): unknown => remoteTools.find((t) => t.name === name);
    expect(field(tool("list_questions"), "annotations", "readOnlyHint")).toBe(true);
    expect(field(tool("get_question"), "annotations", "readOnlyHint")).toBe(true);
    expect(field(tool("reply_question"), "annotations")).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    expect(remote.getServerVersion()?.name).toBe("jevnotjev-admin");
  });

  test("[integration] AM-HTTP-3 list, get and reply run end to end; stale and bad moves are refused; the public status shows the reply", async () => {
    const b = box();
    const { id, key } = seed(b);
    const minted = b.admins.mint("Operator");
    const client = await sdkClient(b, minted.token);
    const list = await call(client, "list_questions");
    expect(list.body).toEqual({ total: 1, questions: [{ id, state: "pending_review", created_at: expect.any(String), updated_at: expect.any(String), version: 1 }] });
    expect(list.text).not.toContain(MARKER);
    const got = await call(client, "get_question", { id });
    expect(got.body).toMatchObject({ id, question: `Fixed choices or open help? ${MARKER}`, email: EMAIL, state: "pending_review", version: 1, response: null });
    expect(b.questions.show(id)?.version).toBe(1);
    const missing = await call(client, "get_question", { id: "Q-0123456789AB" });
    expect([missing.isError, field(missing.body, "error")]).toEqual([true, { code: "not-found", status: 404 }]);
    const stale = await call(client, "reply_question", { id, version: 2, to: "approved" });
    expect([stale.isError, field(stale.body, "error")]).toEqual([true, { code: "stale-version", status: 409 }]);
    const jump = await call(client, "reply_question", { id, version: 1, to: "answered", text: REPLY });
    expect([jump.isError, field(jump.body, "error")]).toEqual([true, { code: "bad-transition", status: 409 }]);
    const dropped = await call(client, "reply_question", { id, version: 1, to: "approved", text: "kept nowhere" });
    expect(field(dropped.body, "error")).toEqual({ code: "text-not-stored", status: 400 });
    const badArgs = await call(client, "reply_question", { id, version: 1, to: "deleted" });
    expect(badArgs.isError).toBe(true);
    expect(b.questions.show(id)?.version).toBe(1);
    expect((await call(client, "reply_question", { id, version: 1, to: "approved" })).body).toEqual({ id, state: "approved", version: 2 });
    expect((await call(client, "reply_question", { id, version: 2, to: "answered", text: REPLY })).body).toEqual({ id, state: "answered", version: 3 });
    expect(b.questions.publicStatus(id, key)).toMatchObject({ state: "answered", response: REPLY, response_source: "human_reviewed" });
    const actor = b.questions.show(id);
    expect(actor?.state).toBe("answered");
    for (const r of [list, got, stale, jump]) expect(r.text).not.toContain(minted.token);
  });

  test("[integration] AM-HTTP-REVOKE a revoke or expiry applies to the next call of an open client session", async () => {
    const b = box();
    const minted = b.admins.mint("Operator", { ttlMs: 2 * 60 * 60_000 });
    const client = await sdkClient(b, minted.token);
    expect((await call(client, "list_questions")).isError).toBe(false);
    b.admins.revoke(minted.record.id);
    await expect(client.callTool({ name: "list_questions", arguments: {} })).rejects.toThrow();
    const second = b.admins.mint("Second", { ttlMs: 60 * 60_000 });
    const raw = async (): Promise<number> => (await b.handler(post(second.token, rpc("tools/list", {}, 9), { "mcp-protocol-version": "2025-11-25" }), { remoteAddress: "127.0.0.1" })).status;
    expect(await raw()).toBe(200);
    b.clock.now = T0 + 60 * 60_000;
    expect(await raw()).toBe(401);
  });

  test("[integration] AM-HTTP-LOG logs carry event, rid, token id, tool and question id; never the token, question text, email or reply", async () => {
    const b = box();
    const { id } = seed(b);
    const minted = b.admins.mint("Operator");
    const client = await sdkClient(b, minted.token);
    await call(client, "list_questions");
    await call(client, "get_question", { id });
    await call(client, "reply_question", { id, version: 1, to: "approved" });
    await call(client, "reply_question", { id, version: 2, to: "answered", text: REPLY });
    await b.handler(post(b.guests.mint("Guest").token, rpc("initialize", INIT)), { remoteAddress: "127.0.0.1" });
    await b.handler(post(minted.token, rpc("initialize", INIT), { origin: "https://evil.example" }), { remoteAddress: "127.0.0.1" });
    const text = b.logs.join("\n");
    for (const secret of [minted.token, MARKER, EMAIL, REPLY, "Bearer"]) expect([secret.slice(0, 12), text.includes(secret)]).toEqual([secret.slice(0, 12), false]);
    const calls = b.logs.filter((l) => l.includes("admin.mcp.call")).map((l) => JSON.parse(l));
    expect(calls.map((c) => [c.tool, c.id ?? null, c.token])).toEqual([
      ["list_questions", null, minted.record.id],
      ["get_question", id, minted.record.id],
      ["reply_question", id, minted.record.id],
      ["reply_question", id, minted.record.id],
    ]);
    for (const c of calls) {
      expect(typeof c.rid).toBe("string");
      expect(Object.keys(c).sort()).toEqual(["event", "rid", "token", "tool", "ts", ...(c.id === undefined ? [] : ["id"])].sort());
    }
    const rejected = b.logs.filter((l) => l.includes("admin.mcp.rejected")).map((l) => JSON.parse(l));
    // The SDK client opens its optional GET stream once after initialize; the 405 is the spec's "no stream here".
    expect(rejected.map((r) => r.reason)).toEqual(["method-not-allowed", "unauthenticated", "origin-refused"]);
    for (const r of rejected) expect(Object.keys(r).sort()).toEqual(["event", "reason", "rid", "token", "ts"]);
    expect(b.logs.some((l) => l.includes("question.api.changed"))).toBe(true);
  });
});

describe("remote admin MCP limits", () => {
  test("[integration] AM-HTTP-LIMITS a response over the cap is refused; a body that stalls past the deadline is refused", async () => {
    const root = mkdtempSync(join(tmpdir(), "admin-mcp-http-limits-"));
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const path = join(state, "tickets.sqlite");
    const logs: string[] = [];
    const api = createAdminApi({ path, clock: () => T0, log: (l) => logs.push(l) });
    const admins = new AdminTokenStore(path, () => T0);
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => { api.close(); admins.close(); });
    const { token } = admins.mint("Operator");
    const tiny = createAdminMcpHttp({ api, origin: ORIGIN, clock: () => T0, log: (l) => logs.push(l), responseBytesMax: 64, timeoutMs: 200 });
    const big = await tiny.handle(post(token, rpc("initialize", INIT)), "rid-1");
    expect([big.status, await json(big)]).toEqual([502, { code: "response-too-large" }]);
    const stall = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"jsonrpc":')); } });
    const slow = await tiny.handle(new Request(URL_MCP, { method: "POST", headers: { "content-type": "application/json", accept: ACCEPT, authorization: `Bearer ${token}` }, body: stall }), "rid-2");
    expect([slow.status, await json(slow)]).toEqual([408, { code: "body-timeout" }]);
    expect(logs.join("\n")).not.toContain(token);
  });

  test("[integration] AM-HTTP-DEADLINE the deadline starts at request entry: a slow body leaves less time for the tool, not a fresh allowance (#289)", async () => {
    const root = mkdtempSync(join(tmpdir(), "admin-mcp-http-deadline-"));
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    const path = join(state, "tickets.sqlite");
    const api = createAdminApi({ path, clock: () => T0, log: () => {} });
    const admins = new AdminTokenStore(path, () => T0);
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    cleanup.push(() => { api.close(); admins.close(); });
    const { token } = admins.mint("Operator");
    // The real admin API, with 300 ms added before each tool call reaches it.
    const slowApi: AdminApi = { ...api, perform: async (c) => { await Bun.sleep(300); return api.perform(c); } };
    const mcp = createAdminMcpHttp({ api: slowApi, origin: ORIGIN, clock: () => T0, log: () => {}, timeoutMs: 600 });
    const body = new TextEncoder().encode(rpc("tools/call", { name: "list_questions", arguments: {} }));
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
      const res = await mcp.handle(new Request(URL_MCP, { method: "POST", headers, body: stream }), "rid-deadline");
      return [res.status, res.status === 200 ? field(await json(res), "result", "isError") ?? false : await json(res)];
    };
    // Negative control: a prompt body and the slow tool finish inside 600 ms.
    expect(await send(0)).toEqual([200, false]);
    // 400 ms of upload (inside the 600 ms body cap) plus 300 ms of tool is past 600 ms from entry.
    expect(await send(400)).toEqual([504, { code: "timeout" }]);
  });

  test("[integration] AM-HTTP-SCRUB the caller's bearer token is redacted from tool results, as the stdio adapter does (#289)", async () => {
    const b = box();
    const minted = b.admins.mint("Operator");
    const r = b.questions.submit("public", { email: EMAIL, question: `Pasted by mistake: ${minted.token} ${MARKER}`, replyConsent: true, marketingConsent: false, requestKey: freshKey() }, T0);
    if (r.status !== "issued") throw new Error(`seed failed: ${r.status}`);
    const client = await sdkClient(b, minted.token);
    const got = await call(client, "get_question", { id: r.id });
    expect(got.isError).toBe(false);
    expect(got.text).not.toContain(minted.token);
    expect(field(got.body, "question")).toBe(`Pasted by mistake: [redacted] ${MARKER}`);
    // The stdio adapter, on the same row, returns the same redacted text.
    const stdio = createAdminMcp({ env: { [ADMIN_TOKEN_ENV]: minted.token }, origin: "http://127.0.0.1:9", fetch: async (url, init) => b.fetch(url, init) });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await stdio.connect(serverSide);
    const local = new Client({ name: "stdio-scrub", version: "0.0.0" });
    await local.connect(clientSide);
    cleanup.push(() => local.close());
    expect((await call(local, "get_question", { id: r.id })).text).toBe(got.text);
  });
});
