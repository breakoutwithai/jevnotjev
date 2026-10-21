// Guest HTTP routes (#256, child of #253; contract: docs/product/guest-intake.md "Guest HTTP schema"). Dispatched by
// server.ts before the decide /api/v1 handler, so a guest token never reaches ask or run:
//
//   POST /api/v1/guest/questions          submit one question      { id, state, replay }
//   GET  /api/v1/guest/questions          own rows, newest first   { questions: [{ id, state, created_at, updated_at }] }
//   GET  /api/v1/guest/questions/<id>     one own row              { id, state, updated_at, response, response_source }
//
// Auth is a guest bearer (tokens.ts) on every request, re-read from the store each time, and checked again after the
// body is read and right before the write, so a revoke or rotation that lands mid-upload stores nothing. The principal
// (`guest:<token id>`) comes from the token, never the body. A session cookie grants nothing here. Unsafe token state is
// 503 auth-unavailable; a bad token is 401; another guest's id, a public id or a deleted id is 404. No route returns
// question text, an email or events, and there is no edit, withdraw or delete route. Nothing here sends mail, publishes
// or calls a provider. Logs carry an event, a request id, the token id, a question id and a reason; never a token,
// question text or request key. `perform` runs one route call for an already verified guest; handle and the remote guest
// MCP (guest-mcp-http.ts, #362) both use it.
import { TicketLimiter } from "../backstage/tickets.ts";
import { checkGuestSubmission, MAX_QUESTION_BODY, QUESTION_ID, QUESTION_LIMITS, type QuestionLimits } from "./contract.ts";
import { boundedBody, TooLarge } from "./routes.ts";
import { QuestionStore, type SubmitResult } from "./store.ts";
import { GuestTokenStore, type GuestPrincipal } from "./tokens.ts";

export const GUEST_PREFIX = "/api/v1/guest";
export const GUEST_QUESTIONS_PATH = `${GUEST_PREFIX}/questions`;

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
/** No resource_metadata: there is no OAuth authorization server. */
export const GUEST_CHALLENGE = 'Bearer realm="jevnotjev-guest"';
const CHALLENGE = GUEST_CHALLENGE;
const BODY_TIMEOUT_MS = 5000;

/** True for every path the guest handler owns: the prefix itself and anything under it. */
export function isGuestPath(pathname: string): boolean {
  return pathname === GUEST_PREFIX || pathname.startsWith(`${GUEST_PREFIX}/`);
}

export type GuestLog =
  | { readonly event: "guest.question.received"; readonly rid: string; readonly token: string; readonly id: string; readonly replay: boolean }
  | { readonly event: "guest.question.rejected"; readonly rid: string; readonly token: string | null; readonly reason: string }
  | { readonly event: "guest.question.read"; readonly rid: string; readonly token: string; readonly id: string | null; readonly found: boolean }
  | { readonly event: "guest.question.list"; readonly rid: string; readonly token: string; readonly count: number };

export interface GuestRoutesOptions {
  /** The tickets.sqlite path (absolute, in a 0700 directory); without one every guest route answers 503. */
  readonly path: string | undefined;
  readonly clock: () => number;
  readonly log?: ((line: string) => void) | undefined;
  readonly limits?: Partial<QuestionLimits> | undefined;
  /** Addresses the submit attempt limiter tracks before it refuses new ones. */
  readonly limiterCapacity?: number | undefined;
}

/** The verified guest, null for a missing or bad token, or "unsafe" when the token state cannot be trusted. */
export type GuestAuth = GuestPrincipal | null | "unsafe";

/** A decoded request body, or the refusal reading it produced. */
export type GuestBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string; readonly status: number };

/** One guest route call by an already verified guest: what the HTTP routes and the remote MCP (#362) both run. */
export interface GuestCall {
  readonly principal: GuestPrincipal;
  /** Re-verifies the same credential after the body is read; it must still be the same guest. */
  readonly recheck: () => GuestAuth;
  readonly method: string;
  readonly pathname: string;
  /** Read only for a submit. */
  readonly body: () => Promise<GuestBody>;
  /** The address a submit counts against the attempt limiter, or null when the caller has already counted it. */
  readonly ip: string | null;
  readonly rid: string;
}

export interface GuestOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GuestRoutes {
  readonly handle: (request: Request, pathname: string, ip: string, rid: string) => Promise<Response>;
  /** The bearer check every guest route uses, exposed for the remote MCP endpoint. Records last use. */
  readonly authenticate: (request: Request) => GuestAuth;
  /** Route one call without HTTP: same store calls, refusal codes and logs as handle. */
  readonly perform: (call: GuestCall) => Promise<GuestOutcome>;
  readonly close: () => void;
}

type Target = { readonly kind: "list" } | { readonly kind: "one"; readonly id: string } | { readonly kind: "none" };

function targetOf(pathname: string): Target {
  if (pathname === GUEST_QUESTIONS_PATH) return { kind: "list" };
  if (!pathname.startsWith(`${GUEST_QUESTIONS_PATH}/`)) return { kind: "none" };
  const id = pathname.slice(GUEST_QUESTIONS_PATH.length + 1);
  return QUESTION_ID.test(id) ? { kind: "one", id } : { kind: "none" };
}

export function createGuestRoutes(opts: GuestRoutesOptions): GuestRoutes {
  const limits: QuestionLimits = { ...QUESTION_LIMITS, ...opts.limits };
  const path = opts.path;
  const questions = path ? new QuestionStore(path, limits) : null;
  const limiter = opts.limiterCapacity === undefined ? new TicketLimiter(opts.clock) : new TicketLimiter(opts.clock, opts.limiterCapacity);
  // Opened on first use, so an unsafe state directory is a 503 on the guest routes, not a server that will not start.
  let tokens: GuestTokenStore | null = null;
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: GuestLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

  /** The verified principal, null for a bad token, or "unsafe" when the token state cannot be trusted. */
  const authenticate = (request: Request): GuestAuth => {
    if (path === undefined) return "unsafe";
    try {
      tokens ??= new GuestTokenStore(path, opts.clock);
      return tokens.verify(request.headers.get("authorization"));
    } catch {
      return "unsafe";
    }
  };

  const perform = async (call: GuestCall): Promise<GuestOutcome> => {
    const { principal, rid } = call;
    const token = principal.tokenId;
    const reject = (reason: string, status: number, headers: Readonly<Record<string, string>> = {}): GuestOutcome => {
      log({ event: "guest.question.rejected", rid, token, reason });
      return { status, body: { code: reason }, headers };
    };
    if (questions === null) return reject("questions-unavailable", 503);
    const target = targetOf(call.pathname);
    if (target.kind === "none") return reject("not-found", 404);
    const methods = target.kind === "list" ? ["GET", "POST"] : ["GET"];
    if (!methods.includes(call.method)) return reject("method-not-allowed", 405, { allow: methods.join(", ") });

    if (call.method === "GET") {
      try {
        if (target.kind === "list") {
          const rows = questions.guestList(principal.scope);
          log({ event: "guest.question.list", rid, token, count: rows.length });
          return { status: 200, body: { questions: rows } };
        }
        const view = questions.guestRead(principal.scope, target.id);
        log({ event: "guest.question.read", rid, token, id: view === null ? null : view.id, found: view !== null });
        return view === null ? { status: 404, body: { code: "not-found" } } : { status: 200, body: view };
      } catch {
        return reject("store-error", 503);
      }
    }

    if (call.ip !== null && !limiter.allow(call.ip)) return reject("rate-limited", 429);
    const decoded = await call.body();
    if (!decoded.ok) return reject(decoded.reason, decoded.status);
    const checked = checkGuestSubmission(decoded.value, limits);
    if (!checked.ok) return reject(checked.reason, 400);
    if ("trap" in checked) return reject("bad-body", 400);
    // The upload can take seconds: the token must still be live, and still the same principal, at the moment of writing.
    const again = call.recheck();
    if (again === "unsafe") return reject("auth-unavailable", 503);
    if (again === null || again.tokenId !== token) return reject("unauthenticated", 401, { "www-authenticate": CHALLENGE });
    let result: SubmitResult;
    try { result = questions.submit(again.scope, checked.submission, opts.clock()); }
    catch { return reject("store-error", 503); }
    if (result.status === "conflict") return reject("request-key-reused", 409);
    if (result.status === "deleted") return reject("deleted", 410);
    if (result.status === "capacity") return reject("capacity", 503);
    log({ event: "guest.question.received", rid, token, id: result.id, replay: result.status === "replay" });
    return { status: 200, body: { id: result.id, state: result.state, replay: result.status === "replay" } };
  };

  /** The submit body as the HTTP route reads it: JSON content type, the byte cap and the upload deadline. */
  const readBody = async (request: Request): Promise<GuestBody> => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return { ok: false, reason: "json-required", status: 415 };
    if (Number(request.headers.get("content-length") ?? 0) > MAX_QUESTION_BODY) return { ok: false, reason: "too-large", status: 413 };
    try {
      return { ok: true, value: JSON.parse(await boundedBody(request, MAX_QUESTION_BODY, BODY_TIMEOUT_MS)) };
    } catch (error) {
      return error instanceof TooLarge || !(error instanceof SyntaxError) ? { ok: false, reason: "too-large", status: 413 } : { ok: false, reason: "bad-json", status: 400 };
    }
  };

  const handle = async (request: Request, pathname: string, ip: string, rid: string): Promise<Response> => {
    const reject = (reason: string, status: number, extra: Record<string, string> = {}): Response => {
      log({ event: "guest.question.rejected", rid, token: null, reason });
      return reply({ code: reason }, status, extra);
    };
    // Counted before the token is checked (GI-5a), so perform is told not to count it again.
    if (request.method === "POST" && !limiter.allow(ip)) return reject("rate-limited", 429);
    if (questions === null) return reject("questions-unavailable", 503);
    const principal = authenticate(request);
    if (principal === "unsafe") return reject("auth-unavailable", 503);
    if (principal === null) return reject("unauthenticated", 401, { "www-authenticate": CHALLENGE });
    const done = await perform({ principal, recheck: () => authenticate(request), method: request.method, pathname, body: () => readBody(request), ip: null, rid });
    return reply(done.body, done.status, { ...done.headers });
  };

  return {
    handle,
    authenticate,
    perform,
    close: () => {
      questions?.close();
      tokens?.close();
    },
  };
}
