// The guest question tools as a remote MCP endpoint, for a guest's Claude custom connector (Cowork, desktop, web) or
// `claude mcp add --transport http` (#362; setup: docs/guest-access.md "Remote connector (guest)").
//
//   POST /api/v1/guest/mcp     MCP Streamable HTTP, stateless, JSON responses (protocol 2025-11-25, SDK 1.32.1)
//   GET, DELETE                405 Allow: POST: no server-initiated SSE stream and no sessions
//
// The tools are mcp.ts's createGuestServer: same names, schemas, annotations and result shapes as the stdio adapter.
// Here each tool calls the guest routes in process (guest-routes.ts perform) with the guest already verified, so no
// credential is forwarded anywhere and the route and store refusals are the HTTP routes' own: own rows only, another
// guest's id is 404, no question text or email is returned. A submit counts against the same per-address limiter.
//
// Order of checks, each refused before the next runs, as the admin endpoint (admin-mcp-http.ts): Host must be the
// configured origin's host (403 host-refused); an Origin header, when present, must equal the configured origin (403
// origin-refused; whether Claude's hosted apps send one is not verified); `Authorization: Bearer jng_...` verified by the
// same GuestTokenStore check as /api/v1/guest/questions (hash lookup, TTL, revoke, scopes), else 401 with
// `WWW-Authenticate: Bearer realm="jevnotjev-guest"` and no resource_metadata, since there is no OAuth server; POST only;
// a JSON body of at most 64 KiB read within the deadline (408 body-timeout past it); the token is re-verified after the
// body is read and again before a submit's write. Results have the caller's token scrubbed, as the stdio adapter does.
// Responses are capped and the whole exchange runs under a deadline counted from request entry. Logs carry event, rid,
// token id, tool name, question id and reason only: never a token, question text, a request key or a reply.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { MAX_QUESTION_BODY } from "./contract.ts";
import { GUEST_CHALLENGE, GUEST_PREFIX, type GuestBody, type GuestRoutes } from "./guest-routes.ts";
import { createGuestServer, fail, redact, Refusal, type GuestSend, type GuestToolName, type GuestToolRunner, type ToolResult } from "./mcp.ts";
import { BodyTimeout, boundedBody, TooLarge } from "./routes.ts";
import type { GuestPrincipal } from "./tokens.ts";

export const GUEST_MCP_PATH = `${GUEST_PREFIX}/mcp`;
/** nginx's client_max_body_size for ^~ /api/v1/. */
export const GUEST_MCP_REQUEST_BYTES_MAX = 64 * 1024;
/** Fits a 50-row list or one question with its full reply. */
export const GUEST_MCP_RESPONSE_BYTES_MAX = 256 * 1024;
/** Inside the hosted apps' 240 s per tool call and the server's 100 s /api/v1 request timeout. */
export const GUEST_MCP_TIMEOUT_MS = 30_000;
const BODY_TIMEOUT_MS = 5000;

export type GuestMcpLog =
  | { readonly event: "guest.mcp.call"; readonly rid: string; readonly token: string; readonly tool: GuestToolName; readonly id?: string }
  | { readonly event: "guest.mcp.rejected"; readonly rid: string; readonly token: string | null; readonly reason: string };

export interface GuestMcpHttpOptions {
  readonly routes: GuestRoutes;
  /** The public origin (BACKSTAGE_ORIGIN): its host is the only Host accepted, and the only Origin when one is sent. */
  readonly origin: string;
  readonly clock: () => number;
  readonly log?: ((line: string) => void) | undefined;
  /** Test-only: a smaller response cap. */
  readonly responseBytesMax?: number;
  /** Test-only: a shorter deadline. */
  readonly timeoutMs?: number;
}

export interface GuestMcpHttp {
  readonly handle: (request: Request, ip: string, rid: string) => Promise<Response>;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class Timeout extends Error {}

export function createGuestMcpHttp(opts: GuestMcpHttpOptions): GuestMcpHttp {
  const pinned = new URL(opts.origin);
  if (pinned.origin !== opts.origin) throw new Error("origin must be an origin");
  const responseMax = opts.responseBytesMax ?? GUEST_MCP_RESPONSE_BYTES_MAX;
  const timeoutMs = opts.timeoutMs ?? GUEST_MCP_TIMEOUT_MS;
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: GuestMcpLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };

  /**
   * Each tool call goes to the guest routes in process as the verified guest; a submit re-verifies before its write.
   * `bearer` is scrubbed from every result, as the stdio adapter's createTokenRunner does.
   */
  const runner = (principal: GuestPrincipal, request: Request, ip: string, rid: string, bearer: string): GuestToolRunner => {
    const send: GuestSend = async (method, pathname, payload) => {
      const body = async (): Promise<GuestBody> =>
        new TextEncoder().encode(JSON.stringify(payload ?? null)).byteLength > MAX_QUESTION_BODY ? { ok: false, reason: "too-large", status: 413 } : { ok: true, value: payload ?? null };
      const done = await opts.routes.perform({ principal, recheck: () => opts.routes.authenticate(request), method, pathname, body, ip, rid });
      if (done.status >= 200 && done.status < 300) return done.body;
      const code = isRecord(done.body) && typeof done.body["code"] === "string" ? done.body["code"] : "http-error";
      throw new Refusal(code, done.status);
    };
    return async (tool, id, fn): Promise<ToolResult> => {
      log(id === undefined ? { event: "guest.mcp.call", rid, token: principal.tokenId, tool } : { event: "guest.mcp.call", rid, token: principal.tokenId, tool, id });
      let result: ToolResult;
      try {
        result = { content: [{ type: "text", text: JSON.stringify(await fn(send), null, 2) }] };
      } catch (error) {
        result = error instanceof Refusal ? fail(error.code, error.status) : fail("internal-error", null);
      }
      return redact(result, bearer);
    };
  };

  const handle = async (request: Request, ip: string, rid: string): Promise<Response> => {
    // The whole-request deadline counts from here, so a slow body leaves less time for the tools.
    const started = performance.now();
    const refuse = (reason: string, status: number, token: string | null, extra: Record<string, string> = {}): Response => {
      log({ event: "guest.mcp.rejected", rid, token, reason });
      return Response.json({ code: reason }, { status, headers: { ...HEADERS, ...extra } });
    };
    const host = request.headers.get("host");
    if (new URL(request.url).host !== pinned.host || (host !== null && host !== pinned.host)) return refuse("host-refused", 403, null);
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== opts.origin) return refuse("origin-refused", 403, null);
    const principal = opts.routes.authenticate(request);
    if (principal === "unsafe") return refuse("auth-unavailable", 503, null);
    if (principal === null) return refuse("unauthenticated", 401, null, { "www-authenticate": GUEST_CHALLENGE });
    const token = principal.tokenId;
    if (request.method !== "POST") return refuse("method-not-allowed", 405, token, { allow: "POST" });
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return refuse("json-required", 415, token);
    if (Number(request.headers.get("content-length") ?? 0) > GUEST_MCP_REQUEST_BYTES_MAX) return refuse("too-large", 413, token);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await boundedBody(request, GUEST_MCP_REQUEST_BYTES_MAX, Math.min(BODY_TIMEOUT_MS, timeoutMs)));
    } catch (error) {
      if (error instanceof BodyTimeout) return refuse("body-timeout", 408, token);
      return error instanceof TooLarge || !(error instanceof SyntaxError) ? refuse("too-large", 413, token) : refuse("bad-json", 400, token);
    }
    // The upload can take seconds: a revoke during it applies here.
    const again = opts.routes.authenticate(request);
    if (again === "unsafe") return refuse("auth-unavailable", 503, token);
    if (again === null || again.tokenId !== token) return refuse("unauthenticated", 401, token, { "www-authenticate": GUEST_CHALLENGE });

    // Verified above, so the header is exactly "Bearer jng_...".
    const bearer = (request.headers.get("authorization") ?? "").slice("Bearer ".length);
    const server = createGuestServer(runner(principal, request, ip, rid, bearer));
    // No sessionIdGenerator: stateless, one transport per request, no Mcp-Session-Id.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), Math.max(0, timeoutMs - (performance.now() - started))); });
      deadline.catch(() => undefined);
      await Promise.race([server.connect(transport), deadline]);
      const response = await Promise.race([transport.handleRequest(request, { parsedBody: parsed }), deadline]);
      const bytes = response.body === null ? null : new Uint8Array(await Promise.race([response.arrayBuffer(), deadline]));
      if (bytes !== null && bytes.byteLength > responseMax) return refuse("response-too-large", 502, token);
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
      return new Response(bytes, { status: response.status, headers });
    } catch (error) {
      return error instanceof Timeout ? refuse("timeout", 504, token) : refuse("internal-error", 500, token);
    } finally {
      clearTimeout(timer);
      await server.close().catch(() => undefined);
    }
  };

  return { handle };
}
