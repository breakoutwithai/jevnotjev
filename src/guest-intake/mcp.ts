// The guest question tools as a stdio MCP server, for a selected guest's Claude Code or Codex (#254, child of #253;
// contract: docs/product/guest-intake.md "Guest MCP adapter (PR 3)"; setup: docs/guest-access.md).
//
//   bun src/guest-intake/mcp.ts            (no arguments; any argument is refused)
//
// Three tools: submit_question, get_my_question, list_my_questions. Each is one request to the guest HTTP routes,
// /api/v1/guest/questions, on the fixed origin GUEST_ORIGIN. The entrypoint reads no origin from arguments, env or
// config; the only value it reads from env is the guest token, JNJ_GUEST_TOKEN (jng_ + 43 base64url characters), per
// call. createGuestMcp takes a loopback origin, a fetch function and a timeout for tests only; nothing on the command
// line reaches them, and any origin other than GUEST_ORIGIN or http://127.0.0.1:<port> / http://[::1]:<port> is refused.
//
// Every request uses redirect: "error", so the bearer never follows a redirect to another host, and a 3xx handed back
// anyway is refused. Request bodies are capped at REQUEST_BYTES_MAX, responses at RESPONSE_BYTES_MAX, and the whole
// exchange at TIMEOUT_MS. A failure is { error: { code, status? } } with a fixed code or the server's own code; no
// result or error carries the token, and a response that contains it has it replaced with [redacted].
// This module makes no model call and starts no process. stdout carries MCP only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export const GUEST_ORIGIN = "https://jevnotjev.breakoutwithai.com";
export const TOKEN_ENV = "JNJ_GUEST_TOKEN";
export const GUEST_TOOL_NAMES: readonly string[] = ["get_my_question", "list_my_questions", "submit_question"];
export const REQUEST_BYTES_MAX = 16 * 1024;
export const RESPONSE_BYTES_MAX = 64 * 1024;
export const TIMEOUT_MS = 10_000;

const GUEST_PATH = "/api/v1/guest/";
const QUESTIONS_PATH = `${GUEST_PATH}questions`;
const TOKEN_PATTERN = /^jng_[A-Za-z0-9_-]{43}$/;
const SERVER_CODE = /^[a-z][a-z0-9-]{0,63}$/;
const REDACTED = "[redacted]";

export type GuestFetch = (url: URL, init: RequestInit) => Promise<Response>;

export interface GuestMcpOptions {
  /** Where JNJ_GUEST_TOKEN is read on every call. The entrypoint passes only that one variable. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Test-only: a loopback receiver instead of GUEST_ORIGIN. */
  readonly origin?: string;
  /** Test-only: the fetch used for every request. */
  readonly fetch?: GuestFetch;
  /** Test-only: a shorter deadline than TIMEOUT_MS. */
  readonly timeoutMs?: number;
}

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** A fixed error code (and HTTP status, when there was one) that a tool returns as { error: { code, status? } }. */
export class Refusal extends Error {
  constructor(
    readonly code: string,
    readonly status: number | null = null,
  ) {
    super(code);
  }
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `origin` when it is `pinned` or a loopback test receiver (http://127.0.0.1:<port> or http://[::1]:<port>), else throws. */
export function checkOrigin(origin: string, pinned: string, adapter: string): string {
  if (origin === pinned) return origin;
  let url: URL | null = null;
  try {
    url = new URL(origin);
  } catch {
    url = null;
  }
  const loopback = url !== null && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]") && url.port !== "" && url.origin === origin;
  if (!loopback) throw new Error(`origin refused: the ${adapter} adapter talks to ${pinned} only (tests may inject a loopback receiver)`);
  return origin;
}

/** The request URL for `path` under `prefix`; anything that is not exactly origin + prefix... with no query or hash throws. */
export function pinnedUrl(origin: string, path: string, prefix: string): URL {
  let url: URL | null = null;
  try {
    url = new URL(path, origin);
  } catch {
    url = null;
  }
  if (url === null || url.origin !== origin || url.pathname !== path || !path.startsWith(prefix) || url.search !== "" || url.hash !== "") {
    throw new Error("destination refused");
  }
  return url;
}

/** The request URL for a guest route path; anything that is not exactly origin + /api/v1/guest/... throws. */
export function guestUrl(origin: string, path: string): URL {
  return pinnedUrl(origin, path, GUEST_PATH);
}

async function readCapped(response: Response, signal: AbortSignal, max: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new Refusal("response-too-large");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

function isRedirectError(error: unknown): boolean {
  return error instanceof Error && /redirect/i.test(`${error.name} ${error.message} ${String(Reflect.get(error, "code") ?? "")}`);
}

const ID = z.string().regex(/^Q-[0-9A-F]{12}$/, "id is Q- followed by 12 uppercase hex characters");
const STATE = z.enum(["pending_review", "needs_info", "approved", "declined", "answered"]);
const STAMP = z.string().min(1).max(64);
const SUBMITTED = z.object({ id: ID, state: STATE, replay: z.boolean() });
const READ = z.object({
  id: ID,
  state: STATE,
  updated_at: STAMP,
  response: z.string().max(RESPONSE_BYTES_MAX).nullable(),
  response_source: z.enum(["human_reviewed", "template"]).nullable(),
});
const LISTED = z.object({ questions: z.array(z.object({ id: ID, state: STATE, created_at: STAMP, updated_at: STAMP })).max(50) });

/** `value` as `schema` describes it, extra fields dropped; anything else is invalid-response. */
export function shaped<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Refusal("invalid-response");
  return parsed.data;
}

export interface RequesterOptions {
  readonly origin: string;
  readonly send: GuestFetch;
  readonly timeoutMs: number;
  /** Every request path must start with this, e.g. /api/v1/guest/. */
  readonly prefix: string;
  readonly requestBytesMax: number;
  readonly responseBytesMax: number;
}

export type Requester = (token: string, method: "GET" | "POST", path: string, payload?: Readonly<Record<string, unknown>>) => Promise<unknown>;

/**
 * One bearer request to `origin` + a path under `prefix`: redirect "error" and any 3xx refused, request and response
 * capped, the whole exchange under `timeoutMs`. A non-2xx is a Refusal with the server's code when it is a plain code.
 */
export function createRequester(o: RequesterOptions): Requester {
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");
  return async (token, method, path, payload) => {
    let url: URL;
    try {
      url = pinnedUrl(o.origin, path, o.prefix);
    } catch {
      throw new Refusal("destination-refused");
    }
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    let body: string | null = null;
    if (payload !== undefined) {
      body = JSON.stringify(payload);
      if (new TextEncoder().encode(body).byteLength > o.requestBytesMax) throw new Refusal("request-too-large");
      headers["content-type"] = "application/json";
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), o.timeoutMs);
    const deadline = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(new Refusal("timeout")), { once: true });
    });
    deadline.catch(() => undefined);
    try {
      let response: Response;
      try {
        response = await Promise.race([o.send(url, { method, headers, redirect: "error", signal: abort.signal, ...(body !== null ? { body } : {}) }), deadline]);
      } catch (error) {
        if (error instanceof Refusal) throw error;
        if (abort.signal.aborted) throw new Refusal("timeout");
        throw new Refusal(isRedirectError(error) ? "redirect-refused" : "network-error");
      }
      if ((response.status >= 300 && response.status < 400) || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new Refusal("redirect-refused", response.status);
      }
      const bytes = await Promise.race([readCapped(response, abort.signal, o.responseBytesMax), deadline]);
      const type = response.headers.get("content-type") ?? "";
      let parsed: unknown = undefined;
      let isJson = false;
      if (/^application\/json\s*(;|$)/i.test(type)) {
        try {
          parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          isJson = true;
        } catch {
          isJson = false;
        }
      }
      if (!response.ok) {
        const code = isJson && isRecord(parsed) && typeof parsed["code"] === "string" && SERVER_CODE.test(parsed["code"]) ? parsed["code"] : "http-error";
        throw new Refusal(code, response.status);
      }
      if (!isJson) throw new Refusal("non-json-response");
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  };
}

function fail(code: string, status: number | null, message?: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: { code, ...(status !== null ? { status } : {}), ...(message !== undefined ? { message } : {}) } }, null, 2) }],
    isError: true,
  };
}

/** A tool body given the checked token. The token is read per call, checked before any request, and scrubbed after. */
export type TokenRunner = (fn: (token: string) => Promise<unknown>) => Promise<ToolResult>;

/** `kind` names the token in the refusal ("a guest token: expected jng_ and 43 base64url characters"). */
export function createTokenRunner(env: Readonly<Record<string, string | undefined>>, name: string, pattern: RegExp, kind: string): TokenRunner {
  return async (fn) => {
    const token = env[name];
    if (token === undefined || token === "") return fail("token-missing", null, `Set ${name} in this MCP server's environment.`);
    if (!pattern.test(token)) return fail("token-invalid", null, `${name} is not ${kind}.`);
    let result: ToolResult;
    try {
      result = { content: [{ type: "text", text: JSON.stringify(await fn(token), null, 2) }] };
    } catch (error) {
      result = error instanceof Refusal ? fail(error.code, error.status) : fail("internal-error", null);
    }
    return { ...result, content: result.content.map((c) => ({ ...c, text: c.text.split(token).join(REDACTED) })) };
  };
}

export function createGuestMcp(opts: GuestMcpOptions): McpServer {
  const origin = checkOrigin(opts.origin ?? GUEST_ORIGIN, GUEST_ORIGIN, "guest");
  const request = createRequester({
    origin,
    send: opts.fetch ?? ((url, init) => fetch(url, init)),
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    prefix: GUEST_PATH,
    requestBytesMax: REQUEST_BYTES_MAX,
    responseBytesMax: RESPONSE_BYTES_MAX,
  });
  const run = createTokenRunner(opts.env, TOKEN_ENV, TOKEN_PATTERN, "a guest token: expected jng_ and 43 base64url characters");

  const server = new McpServer({ name: "jevnotjev-guest", version: "1.0.0" });

  server.registerTool(
    "submit_question",
    {
      description:
        "Send one decision question to the Jev!Jev team. A person reviews it and may write a reply; no Jev run happens. " +
        "Do not include credentials, personal data about others, or private client data. " +
        "request_key: 43 base64url characters, new for each new question; send the same key with the same question only to retry, " +
        "which returns the original id (replay: true). The same key with a changed question is refused (request-key-reused). Returns { id, state, replay }.",
      inputSchema: z.strictObject({
        question: z.string().min(1).max(4096).refine((q) => q.trim().length > 0, "question is blank").describe("The decision question, 1 to 4,096 characters"),
        reply_consent: z.literal(true).describe("Must be true: you agree to a reviewed reply being stored for you to read"),
        marketing_consent: z.boolean().optional().describe("Optional, default false"),
        request_key: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "request_key is 43 base64url characters").describe("43 base64url characters; reuse only to retry the same question"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (a): Promise<ToolResult> =>
      run(async (token) =>
        shaped(
          SUBMITTED,
          await request(token, "POST", QUESTIONS_PATH, {
            question: a.question,
            reply_consent: true,
            ...(a.marketing_consent !== undefined ? { marketing_consent: a.marketing_consent } : {}),
            request_key: a.request_key,
          }),
        ),
      ),
  );

  server.registerTool(
    "get_my_question",
    {
      description: "The state of one of your questions and, once answered, the reviewed response: { id, state, updated_at, response, response_source }. Another id is not-found.",
      inputSchema: z.strictObject({ id: ID.describe("The id submit_question returned, e.g. Q-0123456789AB") }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (a): Promise<ToolResult> =>
      run(async (token) => {
        const read = shaped(READ, await request(token, "GET", `${QUESTIONS_PATH}/${a.id}`));
        if (read.id !== a.id) throw new Refusal("invalid-response");
        return read;
      }),
  );

  server.registerTool(
    "list_my_questions",
    {
      description: "Your questions, newest first, at most 50: { questions: [{ id, state, created_at, updated_at }] }. Question text is not returned.",
      inputSchema: z.strictObject({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (): Promise<ToolResult> => run(async (token) => shaped(LISTED, await request(token, "GET", QUESTIONS_PATH))),
  );

  return server;
}

/** Serve over stdin/stdout until stdin ends. */
export async function serveStdio(server: McpServer): Promise<void> {
  process.stdin.on("end", () => {
    void server.close().then(() => process.exit(0));
  });
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    process.stderr.write(`ERROR jevnotjev-guest takes no arguments: the origin is fixed and the token comes from ${TOKEN_ENV}\n`);
    process.exit(2);
  }
  await serveStdio(createGuestMcp({ env: { [TOKEN_ENV]: process.env[TOKEN_ENV] } }));
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write("ERROR jevnotjev-guest failed to start\n");
    process.exit(1);
  });
}
