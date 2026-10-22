// The operator question tools as a stdio MCP server (#282). In-process clients reach the real createHandler through an
// injected fetch, so every tool call runs the real admin API, token store and question store; stdio tests spawn the
// production entrypoint with a stubbed fetch to prove the origin is pinned.
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHandler } from "../backstage/server.ts";
import { ADMIN_ORIGIN, ADMIN_REPLY_CHARS_MAX, ADMIN_REQUEST_BYTES_MAX, ADMIN_RESPONSE_BYTES_MAX, ADMIN_TOKEN_ENV, ADMIN_TOOL_NAMES, adminUrl, createAdminMcp } from "./admin-mcp.ts";
import { QUESTION_LIMITS } from "./contract.ts";
import type { GuestFetch } from "./mcp.ts";
import { QuestionStore } from "./store.ts";
import { AdminTokenStore, GuestTokenStore } from "./tokens.ts";

const ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(ROOT, "src", "guest-intake", "admin-mcp.ts");
const ORIGIN = "http://127.0.0.1:9";
const T0 = Date.parse("2026-10-19T09:00:00.000Z");
const EMAIL = "visitor-mcp282@example.test";
const MARKER = "zq-admin-mcp-marker-282";
const REPLY = "zq-admin-mcp-reply-282: offer the two fixed answers first.";
const CANARY = `jna_${"canary-".repeat(6)}Z`;

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
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { text, isError: result.isError === true, body };
}

const live: { stop: () => unknown }[] = [];
afterEach(async () => {
  for (const item of live.splice(0).reverse()) await item.stop();
});

interface Box {
  readonly handler: ReturnType<typeof createHandler>;
  readonly questions: QuestionStore;
  readonly admins: AdminTokenStore;
  readonly guests: GuestTokenStore;
  readonly seen: string[];
  readonly send: GuestFetch;
}

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), "admin-mcp-"));
  const state = join(root, "state");
  mkdirSync(state, { mode: 0o700 });
  chmodSync(state, 0o700);
  const path = join(state, "tickets.sqlite");
  const handler = createHandler({ version: "test", origin: "http://localhost:3456", staticRoot: join(ROOT, "site"), tickets: { path }, log: () => {}, auth: { clock: () => T0 } });
  const questions = new QuestionStore(path);
  const admins = new AdminTokenStore(path, () => T0);
  const guests = new GuestTokenStore(path, () => T0);
  live.push({ stop: () => rmSync(root, { recursive: true, force: true }) });
  live.push({ stop: () => { questions.close(); admins.close(); guests.close(); handler.close(); } });
  const seen: string[] = [];
  const send: GuestFetch = async (url, init) => {
    seen.push(`${init.method ?? "GET"} ${url.pathname} ${init.redirect ?? ""}`);
    return handler(new Request(url, init), { remoteAddress: "127.0.0.1" });
  };
  return { handler, questions, admins, guests, seen, send };
}

let seq = 0;
function seed(b: Box, question = `Which fixed answers fit? ${MARKER}`): string {
  seq += 1;
  const r = b.questions.submit("public", { email: EMAIL, question, replyConsent: true, marketingConsent: false, requestKey: `${String(seq).padStart(4, "0")}${"m".repeat(39)}` }, T0 + seq);
  if (r.status !== "issued") throw new Error(`seed failed: ${r.status}`);
  return r.id;
}

async function inProcess(env: Readonly<Record<string, string | undefined>>, send: GuestFetch, origin = ORIGIN): Promise<Client> {
  const server = createAdminMcp({ env, origin, fetch: send });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "admin-mcp-test", version: "0.0.0" });
  await client.connect(clientSide);
  live.push({ stop: () => client.close() });
  return client;
}

describe("admin MCP tools against the real admin API", () => {
  test("[integration] AM-1 exactly three titled, strict tools; reads are readOnlyHint, the reply is not destructive", async () => {
    const b = box();
    const client = await inProcess({ [ADMIN_TOKEN_ENV]: b.admins.mint("Operator").token }, b.send);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ADMIN_TOOL_NAMES].sort());
    const tool = (name: string): (typeof tools)[number] | undefined => tools.find((t) => t.name === name);
    for (const name of ADMIN_TOOL_NAMES) {
      expect(typeof tool(name)?.title).toBe("string");
      expect(field(tool(name)?.inputSchema, "additionalProperties")).toBe(false);
    }
    expect(tool("list_questions")?.annotations?.readOnlyHint).toBe(true);
    expect(tool("get_question")?.annotations?.readOnlyHint).toBe(true);
    expect(tool("reply_question")?.annotations?.readOnlyHint).toBe(false);
    expect(tool("reply_question")?.annotations?.destructiveHint).toBe(false);
    expect(field(tool("reply_question")?.inputSchema, "required")).toEqual(["id", "version", "to"]);
  });

  test("[integration] AM-2 list, get and reply run end to end; the public status shows the reply; reads never write", async () => {
    const b = box();
    const id = seed(b);
    const client = await inProcess({ [ADMIN_TOKEN_ENV]: b.admins.mint("Operator").token }, b.send);
    const list = await call(client, "list_questions");
    expect(list.isError).toBe(false);
    expect(list.body).toEqual({ total: 1, questions: [{ id, kind: "question", state: "pending_review", created_at: expect.any(String), updated_at: expect.any(String), version: 1 }] });
    expect(list.text).not.toContain(MARKER);
    const got = await call(client, "get_question", { id });
    expect(got.body).toMatchObject({ id, question: `Which fixed answers fit? ${MARKER}`, email: EMAIL, state: "pending_review", version: 1, response: null });
    // The read tools issued GETs only and left the row as it was.
    expect(b.seen).toEqual([`GET /api/v1/admin/questions error`, `GET /api/v1/admin/questions/${id} error`]);
    expect(b.questions.show(id)?.version).toBe(1);
    const stale = await call(client, "reply_question", { id, version: 2, to: "approved" });
    expect([stale.isError, field(stale.body, "error")]).toEqual([true, { code: "stale-version", status: 409 }]);
    const dropped = await call(client, "reply_question", { id, version: 1, to: "approved", text: "kept nowhere" });
    expect(field(dropped.body, "error")).toEqual({ code: "text-not-stored", status: 400 });
    expect((await call(client, "reply_question", { id, version: 1, to: "approved" })).body).toEqual({ id, state: "approved", version: 2 });
    expect((await call(client, "reply_question", { id, version: 2, to: "answered", text: REPLY })).body).toEqual({ id, state: "answered", version: 3 });
    const key = `${String(seq).padStart(4, "0")}${"m".repeat(39)}`;
    expect(b.questions.publicStatus(id, key)).toMatchObject({ state: "answered", response: REPLY, response_source: "human_reviewed" });
  });

  test("[integration] AM-3 a missing, guest, decide or malformed token is refused before any request, without echoing it", async () => {
    const b = box();
    const guest = b.guests.mint("Guest A").token;
    const cases: [Record<string, string | undefined>, string, string][] = [
      [{}, "token-missing", ""],
      [{ [ADMIN_TOKEN_ENV]: "" }, "token-missing", ""],
      [{ [ADMIN_TOKEN_ENV]: guest }, "token-invalid", guest],
      [{ [ADMIN_TOKEN_ENV]: `jnj_${guest.slice(4)}` }, "token-invalid", guest.slice(4)],
      [{ [ADMIN_TOKEN_ENV]: CANARY.slice(0, -1) }, "token-invalid", CANARY.slice(0, -1)],
      [{ [ADMIN_TOKEN_ENV]: `${CANARY}\n` }, "token-invalid", CANARY],
    ];
    for (const [env, code, value] of cases) {
      const client = await inProcess(env, b.send);
      for (const [tool, args] of [["list_questions", {}], ["get_question", { id: "Q-0123456789AB" }], ["reply_question", { id: "Q-0123456789AB", version: 1, to: "approved" }]] satisfies [string, Record<string, unknown>][]) {
        const got = await call(client, tool, args);
        expect([tool, got.isError, field(got.body, "error", "code")]).toEqual([tool, true, code]);
        if (value !== "") expect(got.text).not.toContain(value);
      }
    }
    expect(b.seen).toHaveLength(0);
    // A well-formed admin token that the server does not know is a server 401, not a local refusal.
    const unknown = await inProcess({ [ADMIN_TOKEN_ENV]: CANARY }, b.send);
    expect(field((await call(unknown, "list_questions")).body, "error")).toEqual({ code: "unauthenticated", status: 401 });
  });

  test("[unit] AM-4 bad arguments are tool errors and send nothing", async () => {
    const b = box();
    const client = await inProcess({ [ADMIN_TOKEN_ENV]: CANARY }, b.send);
    const bad: [string, Record<string, unknown>][] = [
      ["list_questions", { scope: "public" }],
      ["get_question", {}],
      ["get_question", { id: "../ask" }],
      ["get_question", { id: "q-0123456789ab" }],
      ["reply_question", { id: "Q-0123456789AB", to: "approved" }],
      ["reply_question", { id: "Q-0123456789AB", version: 0, to: "approved" }],
      ["reply_question", { id: "Q-0123456789AB", version: 1, to: "deleted" }],
      ["reply_question", { id: "Q-0123456789AB", version: 1, to: "answered", text: "x", source: "model" }],
      ["reply_question", { id: "Q-0123456789AB", version: 1, to: "answered", text: "x".repeat(QUESTION_LIMITS.maxResponseChars + 1) }],
      ["reply_question", { id: "Q-0123456789AB", version: 1, to: "approved", email: "x@example.test" }],
    ];
    for (const [tool, args] of bad) expect([tool, (await call(client, tool, args)).isError]).toEqual([tool, true]);
    expect(b.seen).toHaveLength(0);
    expect(ADMIN_REPLY_CHARS_MAX).toBe(QUESTION_LIMITS.maxResponseChars);
  });

  test("[integration] AM-TRIM the reply length counts trimmed code points, as the store does: 8,000 characters plus a newline is stored (#285)", async () => {
    const b = box();
    const client = await inProcess({ [ADMIN_TOKEN_ENV]: b.admins.mint("Operator").token }, b.send);
    const approved = (): string => {
      const id = seed(b);
      expect(b.questions.transition(id, "approved", 1, "operator:cli", T0).ok).toBe(true);
      return id;
    };
    const text = "\u{1F600}".repeat(ADMIN_REPLY_CHARS_MAX);
    const id = approved();
    const got = await call(client, "reply_question", { id, version: 2, to: "answered", text: `${text}\n` });
    expect([got.isError, got.body]).toEqual([false, { id, state: "answered", version: 3 }]);
    expect(b.questions.show(id)?.response).toBe(text);
    // Negative control: one character over after trimming is still refused locally and sends nothing.
    const sent = b.seen.length;
    const over = await call(client, "reply_question", { id: approved(), version: 2, to: "answered", text: ` ${"x".repeat(ADMIN_REPLY_CHARS_MAX + 1)}\n` });
    expect(over.isError).toBe(true);
    expect(b.seen).toHaveLength(sent);
  });
});

describe("operator token storage recipe", () => {
  test("[integration] AM-ENVFILE-MODE the documented env-file recipes leave the token file 0600 even when it already exists as 0644, and a prompt ended with no token keeps the existing file (#289)", async () => {
    const doc = readFileSync(join(ROOT, "docs", "guest-access.md"), "utf8");
    const blocks = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1] ?? "").filter((s) => s.includes("read -rs T") && /\.env"/.test(s));
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const name = /jevnotjev\/(\w+\.env)"/.exec(block)?.[1] ?? "";
      const variable = /printf '(JNJ_[A-Z]+_TOKEN)=%s/.exec(block)?.[1] ?? "";
      expect([name, variable].every((s) => s !== "")).toBe(true);
      const home = mkdtempSync(join(tmpdir(), "admin-mcp-envfile-"));
      live.push({ stop: () => rmSync(home, { recursive: true, force: true }) });
      const dir = join(home, ".config", "jevnotjev");
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      const file = join(dir, name);
      writeFileSync(file, "OLD=1\n", { mode: 0o644 });
      chmodSync(file, 0o644);
      const script = block.split("\n").filter((line) => !line.startsWith("claude ") && !line.startsWith("codex ")).join("\n");
      // A prompt ended with no token (EOF, as when the operator cancels) must leave the working file as it was.
      const cancelled = Bun.spawn(["bash", "-c", script], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdin: new Uint8Array(0), stdout: "pipe", stderr: "pipe" });
      await cancelled.exited;
      expect([name, readFileSync(file, "utf8")]).toEqual([name, "OLD=1\n"]);
      const proc = Bun.spawn(["bash", "-c", script], { env: { PATH: process.env.PATH ?? "", HOME: home }, stdin: new TextEncoder().encode(`${CANARY}\n`), stdout: "pipe", stderr: "pipe" });
      expect([name, await proc.exited]).toEqual([name, 0]);
      expect([name, (statSync(file).mode & 0o777).toString(8), (statSync(dir).mode & 0o777).toString(8)]).toEqual([name, "600", "700"]);
      expect(readFileSync(file, "utf8")).toBe(`${variable}=${CANARY}\n`);
    }
  });
});

describe("admin MCP adapter boundaries", () => {
  test("[unit] AM-ORIGIN createAdminMcp accepts only the pinned origin or a loopback test receiver; adminUrl only /api/v1/admin/ paths", () => {
    const env = { [ADMIN_TOKEN_ENV]: CANARY };
    expect(ADMIN_ORIGIN).toBe("https://jevnotjev.breakoutwithai.com");
    for (const origin of [ADMIN_ORIGIN, "http://127.0.0.1:5000", "http://[::1]:5000"]) expect(() => createAdminMcp({ env, origin })).not.toThrow();
    for (const origin of ["https://evil.example", "http://jevnotjev.breakoutwithai.com", "http://localhost:5000", "http://127.0.0.1", "https://jevnotjev.breakoutwithai.com.evil.example", ""]) {
      expect(() => createAdminMcp({ env, origin })).toThrow("origin refused");
    }
    expect(adminUrl(ADMIN_ORIGIN, "/api/v1/admin/questions").href).toBe(`${ADMIN_ORIGIN}/api/v1/admin/questions`);
    for (const path of ["/api/v1/guest/questions", "/api/v1/admin/../ask", "//evil.example/api/v1/admin/questions", "/api/v1/admin/questions?x=1", "/api/backstage/questions"]) {
      expect(() => adminUrl(ADMIN_ORIGIN, path)).toThrow("destination refused");
    }
  });

  test("[unit] AM-REDIRECT a redirect is refused; a response over the cap is dropped; an echoed bearer is redacted", async () => {
    const redirect: GuestFetch = async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
    expect(field((await call(await inProcess({ [ADMIN_TOKEN_ENV]: CANARY }, redirect), "list_questions")).body, "error")).toEqual({ code: "redirect-refused", status: 302 });
    const huge: GuestFetch = async () => Response.json({ total: 0, questions: [], pad: "x".repeat(ADMIN_RESPONSE_BYTES_MAX) });
    expect(field((await call(await inProcess({ [ADMIN_TOKEN_ENV]: CANARY }, huge), "list_questions")).body, "error")).toEqual({ code: "response-too-large" });
    const echo: GuestFetch = async (_url, init) => {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      return Response.json({ id: "Q-0123456789AB", created_at: "t", updated_at: "t", email: null, question: `token ${auth}`, state: "pending_review", version: 1, response: null, response_source: null });
    };
    const got = await call(await inProcess({ [ADMIN_TOKEN_ENV]: CANARY }, echo), "get_question", { id: "Q-0123456789AB" });
    expect(got.text).not.toContain(CANARY);
    expect(field(got.body, "question")).toBe("token Bearer [redacted]");
    expect(ADMIN_REQUEST_BYTES_MAX).toBe(64 * 1024);
  });

  test("[unit] AM-IMPORTS the adapter imports only the MCP SDK, zod and the guest adapter helpers, and reads one env variable", () => {
    const source = readFileSync(ENTRY, "utf8");
    const specifiers = [...source.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) expect(spec === "zod" || spec === "./mcp.ts" || spec.startsWith("@modelcontextprotocol/sdk/")).toBe(true);
    expect(source).not.toMatch(/decide|providers|child_process|Bun\.spawn|spawnSync|typesafe|openai|anthropic|_API_KEY/i);
    expect(source.match(/process\.env/g)).toEqual(["process.env"]);
    expect(source).toContain("process.env[ADMIN_TOKEN_ENV]");
  });

  test("[integration] AM-STDIO the production entrypoint sends only to the pinned origin with redirect error, and refuses arguments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "admin-mcp-stdio-"));
    live.push({ stop: () => rmSync(dir, { recursive: true, force: true }) });
    const log = join(dir, "requests.jsonl");
    const stub = join(dir, "stub-fetch.ts");
    writeFileSync(
      stub,
      `import { appendFileSync } from "node:fs";\n` +
        `globalThis.fetch = Object.assign(async (input, init) => {\n` +
        `  appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(input), method: init?.method ?? "GET", redirect: init?.redirect ?? "", authorization: new Headers(init?.headers).get("authorization") }) + "\\n");\n` +
        `  return Response.json({ total: 0, questions: [] });\n` +
        `}, { preconnect: globalThis.fetch.preconnect });\n`,
    );
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--preload", stub, ENTRY], env: { [ADMIN_TOKEN_ENV]: CANARY, JNJ_ADMIN_ORIGIN: "http://127.0.0.1:1", ORIGIN: "http://127.0.0.1:1" }, cwd: dir, stderr: "pipe" });
    let err = "";
    transport.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    const client = new Client({ name: "admin-mcp-stdio-test", version: "0.0.0" });
    await client.connect(transport);
    live.push({ stop: () => client.close() });
    expect((await call(client, "list_questions")).body).toEqual({ total: 0, questions: [] });
    expect(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([{ url: `${ADMIN_ORIGIN}/api/v1/admin/questions`, method: "GET", redirect: "error", authorization: `Bearer ${CANARY}` }]);
    expect(err).not.toContain(CANARY);

    const proc = Bun.spawn([process.execPath, ENTRY, "--origin", "http://127.0.0.1:1"], { env: { PATH: process.env.PATH ?? "", [ADMIN_TOKEN_ENV]: CANARY }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(2);
    const stderr = await new Response(proc.stderr).text();
    expect(stderr).toContain("takes no arguments");
    expect(stderr).not.toContain(CANARY);
  }, 20_000);
});
