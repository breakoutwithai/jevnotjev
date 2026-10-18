// src/guest-intake/mcp.ts (#254, child of #253, PR 3 of docs/product/guest-intake.md): the guest stdio MCP adapter.
// The stdio tests spawn real processes and talk to them with the SDK's own client. The HTTP side is a loopback CONTRACT
// RECEIVER written here from the guest HTTP schema in the contract; it is not the server and passing against it is not
// server acceptance (that is GI-18 against PR 2's routes). No test reaches any host but 127.0.0.1, and the production
// entrypoint test swaps fetch with a --preload stub that records requests and sends nothing.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGuestMcp, GUEST_ORIGIN, GUEST_TOOL_NAMES, guestUrl, REQUEST_BYTES_MAX, RESPONSE_BYTES_MAX, TOKEN_ENV, type GuestFetch, type GuestMcpOptions } from "./mcp.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "src", "guest-intake", "mcp.ts");
// Shape-valid canary tokens, minted nowhere. No output may ever contain one.
const TOKEN = `jng_${"canary-".repeat(6)}Z`;
const DECIDE_TOKEN = `jnj_${"canary-".repeat(6)}Z`;
const KEY = "k".repeat(43);
const KEY2 = `${"A".repeat(42)}b`;

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

function keys(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value).sort() : [];
}

function json(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
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
  try {
    body = json(text);
  } catch {
    body = null;
  }
  return { text, isError: result.isError === true, body };
}

// ---- loopback receivers ----

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface Receiver {
  readonly origin: string;
  readonly seen: Seen[];
  readonly stop: () => void;
}

const live: { stop: () => unknown }[] = [];
afterEach(async () => {
  for (const item of live.splice(0)) await item.stop();
});

function receiver(route: (req: Request, url: URL) => Response | Promise<Response>): Receiver {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.text() : "";
      seen.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body });
      return route(new Request(req.url, { method: req.method, headers: req.headers, ...(req.method === "POST" ? { body } : {}) }), url);
    },
  });
  const stop = (): void => {
    void server.stop(true);
  };
  live.push({ stop });
  return { origin: `http://127.0.0.1:${server.port}`, seen, stop };
}

const STATES = ["pending_review", "needs_info", "approved", "declined", "answered"];

interface Row {
  readonly id: string;
  readonly key: string;
  readonly hash: string;
  readonly created_at: string;
  state: string;
  updated_at: string;
  response: string | null;
  response_source: string | null;
}

interface ContractReceiver extends Receiver {
  readonly answer: (id: string, text: string) => void;
}

// The guest HTTP schema from docs/product/guest-intake.md ("Guest HTTP schema (PR 2)"), one guest, in memory.
function contractReceiver(token: string): ContractReceiver {
  const rows = new Map<string, Row>();
  const byKey = new Map<string, string>();
  let clock = Date.parse("2026-10-18T10:00:00Z");
  const now = (): string => new Date((clock += 1000)).toISOString();
  const code = (status: number, value: string): Response => Response.json({ code: value }, { status });
  const r = receiver(async (req, url) => {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return code(401, "unauthorized");
    if (url.pathname === "/api/v1/guest/questions" && req.method === "POST") {
      if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return code(415, "unsupported-media-type");
      let body: unknown;
      try {
        body = json(await req.text());
      } catch {
        return code(400, "invalid-json");
      }
      if (!isRecord(body)) return code(400, "invalid-body");
      const allowed = ["question", "reply_consent", "marketing_consent", "request_key"];
      if (Object.keys(body).some((k) => !allowed.includes(k))) return code(400, "unknown-field");
      const { question, reply_consent, marketing_consent, request_key } = body;
      if (typeof question !== "string" || question.trim().length === 0 || question.length > 4096) return code(400, "invalid-question");
      if (reply_consent !== true) return code(400, "reply-consent-required");
      if (marketing_consent !== undefined && typeof marketing_consent !== "boolean") return code(400, "invalid-marketing-consent");
      if (typeof request_key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(request_key)) return code(400, "invalid-request-key");
      const hash = JSON.stringify([null, question.trim(), true, marketing_consent === true]);
      const existing = byKey.get(request_key);
      if (existing !== undefined) {
        const row = rows.get(existing);
        if (row === undefined || row.hash !== hash) return code(409, "request-key-reused");
        return Response.json({ id: row.id, state: row.state, replay: true }, { status: 200 });
      }
      const id = `Q-${(rows.size + 1).toString(16).padStart(12, "0")}`;
      const at = now();
      rows.set(id, { id, key: request_key, hash, created_at: at, state: "pending_review", updated_at: at, response: null, response_source: null });
      byKey.set(request_key, id);
      return Response.json({ id, state: "pending_review", replay: false }, { status: 201 });
    }
    if (url.pathname === "/api/v1/guest/questions" && req.method === "GET") {
      const questions = [...rows.values()].reverse().slice(0, 50).map((row) => ({ id: row.id, state: row.state, created_at: row.created_at, updated_at: row.updated_at }));
      return Response.json({ questions });
    }
    const one = /^\/api\/v1\/guest\/questions\/(Q-[0-9A-F]{12})$/.exec(url.pathname);
    if (one !== null && req.method === "GET") {
      const row = rows.get(one[1] ?? "");
      if (row === undefined) return code(404, "not-found");
      return Response.json({ id: row.id, state: row.state, updated_at: row.updated_at, response: row.response, response_source: row.response_source });
    }
    return code(404, "not-found");
  });
  const answer = (id: string, text: string): void => {
    const row = rows.get(id);
    if (row === undefined) throw new Error(`no row ${id}`);
    row.state = "answered";
    row.response = text;
    row.response_source = "human_reviewed";
    row.updated_at = now();
  };
  return { ...r, answer };
}

// ---- clients ----

type Overrides = Partial<Pick<GuestMcpOptions, "fetch" | "timeoutMs">> & { readonly env?: GuestMcpOptions["env"] };

async function inProcess(origin: string, overrides: Overrides = {}): Promise<Client> {
  const server = createGuestMcp({
    env: overrides.env ?? { [TOKEN_ENV]: TOKEN },
    origin,
    ...(overrides.fetch !== undefined ? { fetch: overrides.fetch } : {}),
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "guest-mcp-test", version: "0.0.0" });
  await client.connect(clientSide);
  live.push({ stop: () => client.close() });
  return client;
}

interface Spawned {
  readonly client: Client;
  readonly stderr: () => string;
}

async function spawnStdio(args: string[], env: Readonly<Record<string, string>>, cwd: string): Promise<Spawned> {
  const transport = new StdioClientTransport({ command: process.execPath, args, env: { ...env }, cwd, stderr: "pipe" });
  let err = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const client = new Client({ name: "guest-mcp-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  live.push({ stop: () => client.close() });
  return { client, stderr: () => err };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "guest-mcp-"));
  live.push({ stop: () => rmSync(dir, { recursive: true, force: true }) });
  return dir;
}

// A test-only process that serves createGuestMcp over the same stdio wiring as the entrypoint, with a loopback origin.
function harness(dir: string): string {
  const path = join(dir, "harness.ts");
  writeFileSync(
    path,
    `import { createGuestMcp, serveStdio } from ${JSON.stringify(ENTRY)};\n` +
      `await serveStdio(createGuestMcp({ env: { JNJ_GUEST_TOKEN: process.env.JNJ_GUEST_TOKEN }, origin: process.argv[2] ?? "" }));\n`,
  );
  return path;
}

const SUBMIT = { question: "Should we move our shop's booking system to a hosted service this quarter?", reply_consent: true, request_key: KEY };

function errorOf(got: Called): unknown {
  return field(got.body, "error");
}

// ---- stdio ----

describe("guest MCP over stdio", () => {
  test("[integration] GI-18 a stdio client lists exactly the three strict tools, then submits, replays, reads and lists against the contract receiver", async () => {
    const r = contractReceiver(TOKEN);
    const dir = tempDir();
    const { client, stderr } = await spawnStdio([harness(dir), r.origin], { [TOKEN_ENV]: TOKEN }, dir);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...GUEST_TOOL_NAMES]);
    const schema = (name: string): unknown => tools.find((t) => t.name === name)?.inputSchema;
    expect(field(schema("submit_question"), "additionalProperties")).toBe(false);
    expect(keys(field(schema("submit_question"), "properties"))).toEqual(["marketing_consent", "question", "reply_consent", "request_key"]);
    expect(field(schema("submit_question"), "required")).toEqual(["question", "reply_consent", "request_key"]);
    expect(field(schema("get_my_question"), "required")).toEqual(["id"]);
    expect(field(schema("get_my_question"), "additionalProperties")).toBe(false);
    expect(field(schema("list_my_questions"), "additionalProperties")).toBe(false);

    const first = await call(client, "submit_question", { ...SUBMIT, marketing_consent: false });
    expect(first.isError).toBe(false);
    expect(first.body).toEqual({ id: "Q-000000000001", state: "pending_review", replay: false });

    const again = await call(client, "submit_question", { ...SUBMIT, marketing_consent: false });
    expect(again.body).toEqual({ id: "Q-000000000001", state: "pending_review", replay: true });

    // The bytes the adapter sent are the contract body: the same key and payload over plain HTTP replays the same row.
    const http = await fetch(`${r.origin}/api/v1/guest/questions`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ ...SUBMIT, marketing_consent: false }),
    });
    expect(await http.json()).toEqual({ id: "Q-000000000001", state: "pending_review", replay: true });
    expect(json(r.seen[0]?.body ?? "")).toEqual({ question: SUBMIT.question, reply_consent: true, marketing_consent: false, request_key: KEY });

    const pending = await call(client, "get_my_question", { id: "Q-000000000001" });
    expect(field(pending.body, "state")).toBe("pending_review");
    expect(field(pending.body, "response")).toBeNull();

    r.answer("Q-000000000001", "Run the hosted trial on one site for two weeks before moving the rest.");
    const read = await call(client, "get_my_question", { id: "Q-000000000001" });
    expect(read.isError).toBe(false);
    expect(read.body).toEqual({
      id: "Q-000000000001",
      state: "answered",
      updated_at: "2026-10-18T10:00:02.000Z",
      response: "Run the hosted trial on one site for two weeks before moving the rest.",
      response_source: "human_reviewed",
    });

    const second = await call(client, "submit_question", { question: "Second question", reply_consent: true, request_key: KEY2 });
    expect(field(second.body, "id")).toBe("Q-000000000002");
    const list = await call(client, "list_my_questions");
    expect(list.isError).toBe(false);
    expect(field(list.body, "questions", 0, "id")).toBe("Q-000000000002");
    expect(field(list.body, "questions", 1, "id")).toBe("Q-000000000001");
    expect(field(list.body, "questions", 1, "state")).toBe("answered");

    // Writes happen only on submit_question; every request carried the bearer to the guest paths and nowhere else.
    const viaAdapter = r.seen.filter((_, i) => i !== 2);
    expect(viaAdapter.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /api/v1/guest/questions",
      "POST /api/v1/guest/questions",
      "GET /api/v1/guest/questions/Q-000000000001",
      "GET /api/v1/guest/questions/Q-000000000001",
      "POST /api/v1/guest/questions",
      "GET /api/v1/guest/questions",
    ]);
    expect(viaAdapter.every((s) => s.authorization === `Bearer ${TOKEN}`)).toBe(true);
    for (const got of [first, again, pending, read, second, list]) expect(got.text).not.toContain(TOKEN);
    expect(stderr()).not.toContain(TOKEN);
  }, 20_000);

  test("[integration] GI-18-ORIGIN the production entrypoint sends only to the pinned origin while env names a loopback receiver", async () => {
    const r = contractReceiver(TOKEN);
    const dir = tempDir();
    const log = join(dir, "requests.jsonl");
    const stub = join(dir, "stub-fetch.ts");
    writeFileSync(
      stub,
      `import { appendFileSync } from "node:fs";\n` +
        `const log = process.env.STUB_LOG ?? "";\n` +
        `globalThis.fetch = Object.assign(async (input, init) => {\n` +
        `  const headers = new Headers(init?.headers);\n` +
        `  appendFileSync(log, JSON.stringify({ url: String(input), method: init?.method ?? "GET", redirect: init?.redirect ?? "", authorization: headers.get("authorization") }) + "\\n");\n` +
        `  return Response.json({ questions: [] });\n` +
        `}, { preconnect: globalThis.fetch.preconnect });\n`,
    );
    const env = {
      [TOKEN_ENV]: TOKEN,
      STUB_LOG: log,
      JNJ_GUEST_ORIGIN: r.origin,
      JNJ_GUEST_URL: r.origin,
      JNJ_ORIGIN: r.origin,
      GUEST_ORIGIN: r.origin,
      ORIGIN: r.origin,
    };
    const { client, stderr } = await spawnStdio(["--preload", stub, ENTRY], env, dir);
    const got = await call(client, "list_my_questions");
    expect(got.isError).toBe(false);
    expect(got.body).toEqual({ questions: [] });
    const sent = readFileSync(log, "utf8").trim().split("\n").map(json);
    expect(sent).toEqual([{ url: `${GUEST_ORIGIN}/api/v1/guest/questions`, method: "GET", redirect: "error", authorization: `Bearer ${TOKEN}` }]);
    expect(r.seen).toHaveLength(0);
    expect(stderr()).not.toContain(TOKEN);
  }, 20_000);

  test("[integration] GI-18-ENVFILE the documented host command reads the token from a private --env-file, not the host config", async () => {
    const dir = tempDir();
    const log = join(dir, "requests.jsonl");
    const stub = join(dir, "stub-fetch.ts");
    writeFileSync(
      stub,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = Object.assign(async (input, init) => {\n` +
        `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(input), authorization: new Headers(init?.headers).get("authorization") }) + "\\n");\n` +
        `  return Response.json({ questions: [] });\n` +
        `}, { preconnect: globalThis.fetch.preconnect });\n`,
    );
    const envFile = join(dir, "guest.env");
    writeFileSync(envFile, `${TOKEN_ENV}=${TOKEN}\n`, { mode: 0o600 });
    const { client, stderr } = await spawnStdio([`--env-file=${envFile}`, "--preload", stub, ENTRY], {}, dir);
    expect((await call(client, "list_my_questions")).body).toEqual({ questions: [] });
    expect(readFileSync(log, "utf8").trim().split("\n").map(json)).toEqual([{ url: `${GUEST_ORIGIN}/api/v1/guest/questions`, authorization: `Bearer ${TOKEN}` }]);
    expect(stderr()).not.toContain(TOKEN);
  }, 20_000);

  test("[integration] GI-18-ARGS the production entrypoint refuses any argument and sends nothing", async () => {
    const r = contractReceiver(TOKEN);
    const proc = Bun.spawn([process.execPath, ENTRY, "--origin", r.origin], {
      env: { PATH: process.env.PATH ?? "", [TOKEN_ENV]: TOKEN },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const err = await new Response(proc.stderr).text();
    const out = await new Response(proc.stdout).text();
    expect(code).toBe(2);
    expect(err).toContain("takes no arguments");
    expect(out).toBe("");
    expect(err).not.toContain(TOKEN);
    expect(r.seen).toHaveLength(0);
  }, 20_000);
});

// ---- in-process ----

describe("guest MCP adapter boundaries", () => {
  test("[unit] GI-18-INJECT createGuestMcp accepts only the pinned origin or a loopback test receiver", () => {
    const env = { [TOKEN_ENV]: TOKEN };
    for (const origin of [GUEST_ORIGIN, "http://127.0.0.1:5000", "http://[::1]:5000"]) expect(() => createGuestMcp({ env, origin })).not.toThrow();
    for (const origin of [
      "https://evil.example",
      "http://jevnotjev.breakoutwithai.com",
      "https://jevnotjev.breakoutwithai.com/",
      "https://jevnotjev.breakoutwithai.com.evil.example",
      "http://localhost:5000",
      "http://127.0.0.1.nip.io:5000",
      "http://127.0.0.2:5000",
      "http://127.0.0.1:5000/api",
      "http://user@127.0.0.1:5000",
      "https://127.0.0.1:5000",
      "http://127.0.0.1",
      "not a url",
      "",
    ]) {
      expect(() => createGuestMcp({ env, origin })).toThrow("origin refused");
    }
  });

  test("[unit] GI-18-PATH guestUrl builds only same-origin /api/v1/guest/ paths", () => {
    expect(guestUrl(GUEST_ORIGIN, "/api/v1/guest/questions").href).toBe(`${GUEST_ORIGIN}/api/v1/guest/questions`);
    expect(guestUrl(GUEST_ORIGIN, "/api/v1/guest/questions/Q-000000000001").href).toBe(`${GUEST_ORIGIN}/api/v1/guest/questions/Q-000000000001`);
    for (const path of [
      "/api/v1/ask",
      "/api/v1/guest/../ask",
      "//evil.example/api/v1/guest/questions",
      "https://evil.example/api/v1/guest/questions",
      "/api/v1/guest/questions?scope=public",
      "/api/v1/guest/questions#x",
      "api/v1/guest/questions",
    ]) {
      expect(() => guestUrl(GUEST_ORIGIN, path)).toThrow("destination refused");
    }
  });

  test("[unit] GI-18-ARGS bad arguments are tool errors and send nothing", async () => {
    const r = contractReceiver(TOKEN);
    const client = await inProcess(r.origin);
    const bad: [string, Record<string, unknown>][] = [
      ["submit_question", { question: "q", reply_consent: true }],
      ["submit_question", { question: "q", reply_consent: true, request_key: "k".repeat(42) }],
      ["submit_question", { question: "q", reply_consent: true, request_key: `${"k".repeat(42)}+` }],
      ["submit_question", { question: "q", reply_consent: false, request_key: KEY }],
      ["submit_question", { question: "q", request_key: KEY }],
      ["submit_question", { question: "", reply_consent: true, request_key: KEY }],
      ["submit_question", { question: "   \n ", reply_consent: true, request_key: KEY }],
      ["submit_question", { question: "x".repeat(4097), reply_consent: true, request_key: KEY }],
      ["submit_question", { question: "q", reply_consent: true, request_key: KEY, marketing_consent: "yes" }],
      ["submit_question", { question: "q", reply_consent: true, request_key: KEY, email: "guest@example.com" }],
      ["submit_question", { question: "q", reply_consent: true, request_key: KEY, scope: "public" }],
      ["submit_question", { question: "q", reply_consent: true, request_key: KEY, guest: "someone" }],
      ["get_my_question", {}],
      ["get_my_question", { id: "../ask" }],
      ["get_my_question", { id: "Q-00000000000G" }],
      ["get_my_question", { id: "Q-000000000001", request_key: KEY }],
      ["list_my_questions", { scope: "public" }],
    ];
    for (const [tool, args] of bad) {
      const got = await call(client, tool, args);
      expect([tool, got.isError]).toEqual([tool, true]);
    }
    expect(r.seen).toHaveLength(0);
    const ok = await call(client, "submit_question", { question: "x".repeat(4096), reply_consent: true, request_key: KEY });
    expect(ok.isError).toBe(false);
    expect(keys(json(r.seen[0]?.body ?? ""))).toEqual(["question", "reply_consent", "request_key"]);
  });

  test("[unit] GI-18-TOKEN a missing, decide-format or malformed token is refused before any request, without echoing it", async () => {
    const r = contractReceiver(TOKEN);
    const cases: [Record<string, string | undefined>, string, string][] = [
      [{}, "token-missing", ""],
      [{ [TOKEN_ENV]: "" }, "token-missing", ""],
      [{ [TOKEN_ENV]: DECIDE_TOKEN }, "token-invalid", DECIDE_TOKEN],
      [{ [TOKEN_ENV]: TOKEN.slice(0, -1) }, "token-invalid", TOKEN.slice(0, -1)],
      [{ [TOKEN_ENV]: `${TOKEN.slice(0, -1)}+` }, "token-invalid", `${TOKEN.slice(0, -1)}+`],
      [{ [TOKEN_ENV]: ` ${TOKEN}` }, "token-invalid", TOKEN],
      [{ [TOKEN_ENV]: `${TOKEN}\n` }, "token-invalid", TOKEN],
    ];
    for (const [env, code, value] of cases) {
      const client = await inProcess(r.origin, { env });
      const calls: [string, Record<string, unknown>][] = [["submit_question", SUBMIT], ["get_my_question", { id: "Q-000000000001" }], ["list_my_questions", {}]];
      for (const [tool, args] of calls) {
        const got = await call(client, tool, args);
        expect(got.isError).toBe(true);
        expect(field(errorOf(got), "code")).toBe(code);
        if (value !== "") expect(got.text).not.toContain(value);
      }
    }
    expect(r.seen).toHaveLength(0);
  });

  test("[unit] GI-18-REDIRECT a redirect is refused and the bearer never reaches the other host", async () => {
    const other = receiver(() => Response.json({ questions: [] }));
    const first = receiver(() => new Response(null, { status: 302, headers: { location: `${other.origin}/api/v1/guest/questions` } }));
    const client = await inProcess(first.origin);
    const got = await call(client, "list_my_questions");
    expect(got.isError).toBe(true);
    expect(errorOf(got)).toEqual({ code: "redirect-refused" });
    expect(first.seen).toHaveLength(1);
    expect(other.seen).toHaveLength(0);

    // A fetch that ignores redirect: "error" and hands back the 3xx is refused on the status.
    for (const status of [301, 302, 303, 307, 308]) {
      const lax: GuestFetch = async () => new Response(null, { status, headers: { location: "https://evil.example/" } });
      const laxClient = await inProcess(first.origin, { fetch: lax });
      expect(errorOf(await call(laxClient, "get_my_question", { id: "Q-000000000001" }))).toEqual({ code: "redirect-refused", status });
    }
  });

  test("[unit] GI-18-ID the adapter takes the server's id shape, Q- and 12 uppercase hex characters, and refuses lowercase", async () => {
    const id = "Q-0A1B2C3D4E5F";
    const served: GuestFetch = async (url, init) => {
      if (init.method === "POST") return Response.json({ id, state: "pending_review", replay: false });
      if (url.pathname.endsWith(id)) return Response.json({ id, state: "answered", updated_at: "2026-10-18T10:00:00.000Z", response: "Reviewed.", response_source: "human_reviewed" });
      return Response.json({ questions: [{ id, state: "answered", created_at: "2026-10-18T09:00:00.000Z", updated_at: "2026-10-18T10:00:00.000Z" }] });
    };
    const client = await inProcess("http://127.0.0.1:9", { fetch: served });
    expect((await call(client, "submit_question", SUBMIT)).body).toEqual({ id, state: "pending_review", replay: false });
    expect(field((await call(client, "get_my_question", { id })).body, "response")).toBe("Reviewed.");
    expect(field((await call(client, "list_my_questions")).body, "questions", 0, "id")).toBe(id);
    expect((await call(client, "get_my_question", { id: id.toLowerCase() })).isError).toBe(true);
  });

  test("[unit] GI-12 every request goes to the injected origin's guest paths with redirect error, and nowhere else", async () => {
    const r = contractReceiver(TOKEN);
    const urls: string[] = [];
    const redirects: string[] = [];
    const spy: GuestFetch = (url, init) => {
      urls.push(url.href);
      redirects.push(init.redirect ?? "");
      return fetch(url, init);
    };
    const client = await inProcess(r.origin, { fetch: spy });
    await call(client, "submit_question", SUBMIT);
    await call(client, "get_my_question", { id: "Q-000000000001" });
    await call(client, "list_my_questions");
    expect(urls).toEqual([`${r.origin}/api/v1/guest/questions`, `${r.origin}/api/v1/guest/questions/Q-000000000001`, `${r.origin}/api/v1/guest/questions`]);
    expect(redirects).toEqual(["error", "error", "error"]);
  });

  test("[unit] GI-13 the adapter imports only the MCP SDK and zod, and names no provider host, key or spawn", () => {
    const source = readFileSync(ENTRY, "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) expect(spec === "zod" || spec.startsWith("@modelcontextprotocol/sdk/")).toBe(true);
    expect(source).not.toMatch(/decide|providers|child_process|Bun\.spawn|spawnSync|typesafe|openai|anthropic|_API_KEY/i);
    expect(source.match(/process\.env/g)).toEqual(["process.env"]);
    expect(source).toContain("process.env[TOKEN_ENV]");
  });

  test("[unit] GI-18-CAP an oversize request is refused before sending; an oversize response is refused with or without a length", async () => {
    const r = contractReceiver(TOKEN);
    const client = await inProcess(r.origin);
    const escaped = "\u0001".repeat(4096);
    expect(JSON.stringify(escaped).length).toBeGreaterThan(REQUEST_BYTES_MAX);
    const big = await call(client, "submit_question", { question: escaped, reply_consent: true, request_key: KEY });
    expect(errorOf(big)).toEqual({ code: "request-too-large" });
    expect(r.seen).toHaveLength(0);

    const sized = receiver(() => Response.json({ questions: [], pad: "x".repeat(RESPONSE_BYTES_MAX) }));
    expect(errorOf(await call(await inProcess(sized.origin), "list_my_questions"))).toEqual({ code: "response-too-large" });

    // Five 16 KiB chunks, no content-length: just over the cap, so only the running count can catch it.
    const chunk = new TextEncoder().encode(" ".repeat(16 * 1024));
    const streamed = receiver(() => {
      let sent = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            if (sent++ < 5) controller.enqueue(chunk);
            else controller.close();
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    expect(errorOf(await call(await inProcess(streamed.origin), "list_my_questions"))).toEqual({ code: "response-too-large" });
  });

  test("[unit] GI-18-JSON a non-JSON or malformed body is a named error, and a wrong shape is invalid-response", async () => {
    const html = receiver(() => new Response("<html>ok</html>", { headers: { "content-type": "text/html" } }));
    expect(errorOf(await call(await inProcess(html.origin), "list_my_questions"))).toEqual({ code: "non-json-response" });
    const broken = receiver(() => new Response("{not json", { headers: { "content-type": "application/json" } }));
    expect(errorOf(await call(await inProcess(broken.origin), "list_my_questions"))).toEqual({ code: "non-json-response" });
    const gateway = receiver(() => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    expect(errorOf(await call(await inProcess(gateway.origin), "list_my_questions"))).toEqual({ code: "http-error", status: 502 });

    const shapes = receiver((_, url) =>
      url.pathname.endsWith("/questions")
        ? Response.json({
            questions: [{ id: "Q-000000000001", state: "pending_review", created_at: "2026-10-18T10:00:00.000Z", updated_at: "2026-10-18T10:00:00.000Z", question: "PRIVATE-QUESTION-TEXT", email: "guest@example.com" }],
            scope: "guest:t1",
          })
        : Response.json({ id: "Q-000000000002", state: "answered", updated_at: "2026-10-18T10:00:00.000Z", response: "r", response_source: "human_reviewed" }),
    );
    const client = await inProcess(shapes.origin);
    const list = await call(client, "list_my_questions");
    expect(list.body).toEqual({ questions: [{ id: "Q-000000000001", state: "pending_review", created_at: "2026-10-18T10:00:00.000Z", updated_at: "2026-10-18T10:00:00.000Z" }] });
    expect(list.text).not.toContain("PRIVATE-QUESTION-TEXT");
    expect(list.text).not.toContain("guest@example.com");
    // A read that answers for another id than the one asked is not passed through.
    expect(errorOf(await call(client, "get_my_question", { id: "Q-000000000001" }))).toEqual({ code: "invalid-response" });
    const wrong = receiver(() => Response.json({ id: "nope", state: "pending_review", replay: false }, { status: 201 }));
    expect(errorOf(await call(await inProcess(wrong.origin), "submit_question", SUBMIT))).toEqual({ code: "invalid-response" });
  });

  test("[unit] GI-18-TIMEOUT a server that never answers, or stalls mid-body, times out", async () => {
    const silent = receiver(() => new Promise<Response>(() => {}));
    const started = Date.now();
    expect(errorOf(await call(await inProcess(silent.origin, { timeoutMs: 200 }), "list_my_questions"))).toEqual({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
    const stall = receiver(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(errorOf(await call(await inProcess(stall.origin, { timeoutMs: 200 }), "list_my_questions"))).toEqual({ code: "timeout" });
  });

  test("[unit] GI-18-ERRORS server error codes pass through as { code, status }; anything else is http-error; a dead port is network-error", async () => {
    let next: [number, unknown] = [409, { code: "request-key-reused" }];
    const r = receiver(() => Response.json(next[1], { status: next[0] }));
    const client = await inProcess(r.origin);
    const passed: [number, string][] = [[409, "request-key-reused"], [410, "deleted"], [503, "capacity"], [401, "unauthorized"], [404, "not-found"], [400, "unknown-field"]];
    for (const [status, code] of passed) {
      next = [status, { code }];
      expect(errorOf(await call(client, "submit_question", SUBMIT))).toEqual({ code, status });
    }
    for (const body of [{ code: "Has Spaces" }, { code: 7 }, { message: "no code" }, { code: "x".repeat(65) }]) {
      next = [500, body];
      expect(errorOf(await call(client, "list_my_questions"))).toEqual({ code: "http-error", status: 500 });
    }
    expect(errorOf(await call(await inProcess("http://127.0.0.1:1"), "list_my_questions"))).toEqual({ code: "network-error" });
  });

  test("[unit] GI-18-LEAK a server that echoes the bearer cannot get it into any tool result", async () => {
    const echo = receiver((req, url) => {
      const auth = req.headers.get("authorization") ?? "";
      if (url.pathname.endsWith("/questions")) return Response.json({ code: auth.slice(7) }, { status: 400 });
      if (url.pathname.endsWith("01")) return new Response(`denied ${auth}`, { status: 403, headers: { "content-type": "text/plain" } });
      return Response.json({ id: "Q-000000000002", state: "answered", updated_at: "2026-10-18T10:00:00.000Z", response: `your token is ${auth}`, response_source: "template" });
    });
    const client = await inProcess(echo.origin);
    const results = [
      await call(client, "list_my_questions"),
      await call(client, "submit_question", SUBMIT),
      await call(client, "get_my_question", { id: "Q-000000000001" }),
      await call(client, "get_my_question", { id: "Q-000000000002" }),
    ];
    expect(echo.seen).toHaveLength(4);
    for (const got of results) expect(got.text).not.toContain(TOKEN);
    expect(field(results[3]?.body, "response")).toBe("your token is Bearer [redacted]");
  });
});
