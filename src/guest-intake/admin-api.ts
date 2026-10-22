// Operator bearer API for submitted /ask/ questions (#282), for an operator's agent (admin-mcp.ts) or a script. Dispatched
// by server.ts before the decide /api/v1 handler; nginx's ^~ /api/v1/ location already forwards it.
//
//   GET  /api/v1/admin/questions             newest first, at most ADMIN_LIST_MAX   { total, questions: [{ id, state, created_at, updated_at, version }] }
//   GET  /api/v1/admin/questions/<id>        one question                           { id, created_at, updated_at, email, question, state, version, response, response_source }
//   POST /api/v1/admin/questions/<id>/reply  { version, to, text?, source? }        { id, state, version }
//
// Auth is an admin bearer (`jna_`, tokens.ts) with scope questions:admin, re-read from the store on every request and
// again inside the reply's write transaction, so a revoke applies at once, a revoke mid-upload changes nothing, and no
// revoke or rotate can commit between that check and the write (#285). A guest or
// decide token, a session cookie, or nothing at all is 401. Unsafe token state is 503 auth-unavailable. Reads and
// replies call the same QuestionStore methods as the CLI and the #278 page (list, show, transition, answer) and reuse
// that page's body parser, refusal statuses and reply dispatch. There is no delete or purge route. Logs carry an event,
// a request id, the token id, a question id and a reason; never a token, an email, question text or a reply.
import { applyReply, CHANGE_STATUS, parseReplyBody } from "./admin-routes.ts";
import { QUESTION_ID, QUESTION_LIMITS, type QuestionLimits } from "./contract.ts";
import { BodyTimeout, boundedBody, TooLarge } from "./routes.ts";
import { QuestionStore, type ChangeResult } from "./store.ts";
import { AdminTokenStore, type AdminPrincipal, type AdminScope } from "./tokens.ts";

export const ADMIN_API_PREFIX = "/api/v1/admin";
export const ADMIN_QUESTIONS_PATH = `${ADMIN_API_PREFIX}/questions`;
/** The longest list one request returns, newest first; `total` counts every row. */
export const ADMIN_LIST_MAX = 200;
/**
 * The reply body cap: the 64 KiB that Bun.serve (maxRequestBodySize) and nginx (client_max_body_size, ^~ /api/v1/) apply
 * before this handler, pinned by AQ-API-EDGE. A maximum reply fits as raw UTF-8 or BMP \u escapes; an all-astral one
 * sent as surrogate-pair escapes (twelve bytes a character) does not (#285).
 */
export const ADMIN_API_BODY_BYTES_MAX = 64 * 1024;

export interface AdminApiRoute {
  readonly method: "GET" | "POST";
  /** `{id}` stands for one question id. */
  readonly pattern: string;
  /** The scope the token must carry. Read routes never write, whatever a client's tool hints say. */
  readonly scope: AdminScope;
}

/** Every route this module answers. Anything else under ADMIN_API_PREFIX is still token-checked, then 404. */
export const ADMIN_API_ROUTES: readonly AdminApiRoute[] = [
  { method: "GET", pattern: ADMIN_QUESTIONS_PATH, scope: "questions:admin" },
  { method: "GET", pattern: `${ADMIN_QUESTIONS_PATH}/{id}`, scope: "questions:admin" },
  { method: "POST", pattern: `${ADMIN_QUESTIONS_PATH}/{id}/reply`, scope: "questions:admin" },
];

/** True for every path this module owns: the prefix itself and anything under it. */
export function isAdminApiPath(pathname: string): boolean {
  return pathname === ADMIN_API_PREFIX || pathname.startsWith(`${ADMIN_API_PREFIX}/`);
}

export type AdminApiLog =
  | { readonly event: "question.api.list"; readonly rid: string; readonly token: string }
  | { readonly event: "question.api.read"; readonly rid: string; readonly token: string; readonly id: string }
  | { readonly event: "question.api.changed"; readonly rid: string; readonly token: string; readonly id: string }
  | { readonly event: "question.api.rejected"; readonly rid: string; readonly token: string | null; readonly id?: string; readonly reason: string };

export interface AdminApiOptions {
  /** The tickets.sqlite path (absolute, in a 0700 directory); without one every route answers 503. */
  readonly path: string | undefined;
  readonly clock: () => number;
  readonly log?: ((line: string) => void) | undefined;
  readonly limits?: Partial<QuestionLimits> | undefined;
}

/** The verified operator, null for a missing or bad token, or "unsafe" when the token state cannot be trusted. */
export type AdminAuth = AdminPrincipal | null | "unsafe";

/** A decoded request body, or the refusal reading it produced. */
export type AdminBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: string; readonly status: number };

/** One admin route call by an already verified operator: what the HTTP routes and the remote MCP (#283) both run. */
export interface AdminCall {
  readonly principal: AdminPrincipal;
  /**
   * Re-verifies the same credential inside the reply's write transaction; it must still be the same operator. It must
   * only read (AdminApi.check): a write there would wait on the transaction's own lock.
   */
  readonly recheck: () => AdminAuth;
  readonly method: string;
  readonly pathname: string;
  /** Read only for the reply route. */
  readonly body: () => Promise<AdminBody>;
  readonly rid: string;
}

export interface AdminOutcome {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface AdminApi {
  readonly handle: (request: Request, pathname: string, rid: string) => Promise<Response>;
  /** The bearer check every admin route uses, exposed for the remote MCP endpoint. Records last use. */
  readonly authenticate: (request: Request) => AdminAuth;
  /** The same check as a read only, for AdminCall.recheck. */
  readonly check: (request: Request) => AdminAuth;
  /** Route one call without HTTP: same scope check, store calls, refusal codes and logs as handle. */
  readonly perform: (call: AdminCall) => Promise<AdminOutcome>;
  readonly close: () => void;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
/** No resource_metadata: there is no OAuth authorization server (#283 phase 1). */
export const ADMIN_CHALLENGE = 'Bearer realm="jevnotjev-admin"';
const CHALLENGE = ADMIN_CHALLENGE;
const BODY_TIMEOUT_MS = 5000;
/** The states whose transition stores the text; any other target refuses text rather than dropping it (#281). */
const CARRIES_TEXT = new Set(["needs_info", "answered"]);

/** Thrown by the reply guard to abort the write transaction, carrying the refusal. */
class AuthRefused extends Error {
  constructor(readonly outcome: AdminOutcome) {
    super("auth-refused");
  }
}

type Target =
  | { readonly kind: "list"; readonly route: AdminApiRoute }
  | { readonly kind: "one" | "reply"; readonly route: AdminApiRoute; readonly id: string }
  | { readonly kind: "none" };

function targetOf(pathname: string): Target {
  const [list, one, reply] = ADMIN_API_ROUTES;
  if (list === undefined || one === undefined || reply === undefined) return { kind: "none" };
  if (pathname === ADMIN_QUESTIONS_PATH) return { kind: "list", route: list };
  if (!pathname.startsWith(`${ADMIN_QUESTIONS_PATH}/`)) return { kind: "none" };
  const rest = pathname.slice(ADMIN_QUESTIONS_PATH.length + 1).split("/");
  const id = rest[0] ?? "";
  if (!QUESTION_ID.test(id)) return { kind: "none" };
  if (rest.length === 1) return { kind: "one", route: one, id };
  return rest.length === 2 && rest[1] === "reply" ? { kind: "reply", route: reply, id } : { kind: "none" };
}

export function createAdminApi(opts: AdminApiOptions): AdminApi {
  const limits: QuestionLimits = { ...QUESTION_LIMITS, ...opts.limits };
  const path = opts.path;
  const questions = path ? new QuestionStore(path, limits) : null;
  const bodyCap = ADMIN_API_BODY_BYTES_MAX;
  // Opened on first use, so an unsafe state directory is a 503 here, not a server that will not start.
  let tokens: AdminTokenStore | null = null;
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: AdminApiLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

  const tokenCheck = (request: Request, touch: boolean): AdminAuth => {
    if (path === undefined) return "unsafe";
    try {
      tokens ??= new AdminTokenStore(path, opts.clock);
      const header = request.headers.get("authorization");
      return touch ? tokens.verify(header) : tokens.check(header);
    } catch {
      return "unsafe";
    }
  };
  const authenticate = (request: Request): AdminAuth => tokenCheck(request, true);
  const check = (request: Request): AdminAuth => tokenCheck(request, false);

  const perform = async (call: AdminCall): Promise<AdminOutcome> => {
    const { principal, rid } = call;
    const token = principal.tokenId;
    const reject = (reason: string, status: number, id?: string, headers: Readonly<Record<string, string>> = {}): AdminOutcome => {
      log(id === undefined ? { event: "question.api.rejected", rid, token, reason } : { event: "question.api.rejected", rid, token, id, reason });
      return { status, body: { code: reason }, headers };
    };
    if (questions === null) return reject("questions-unavailable", 503);
    const target = targetOf(call.pathname);
    if (target.kind === "none") return reject("not-found", 404);
    if (call.method !== target.route.method) return reject("method-not-allowed", 405, undefined, { allow: target.route.method });
    if (!principal.scopes.includes(target.route.scope)) return reject("forbidden", 403);

    if (target.kind === "list") {
      try {
        const rows = questions.list();
        const newest = rows.slice(-ADMIN_LIST_MAX).reverse().map((r) => ({ id: r.id, kind: r.kind, state: r.state, created_at: r.created_at, updated_at: r.updated_at, version: r.version }));
        log({ event: "question.api.list", rid, token });
        return { status: 200, body: { total: rows.length, questions: newest } };
      } catch {
        return reject("store-error", 503);
      }
    }
    const id = target.id;
    if (target.kind === "one") {
      let row;
      try { row = questions.show(id); }
      catch { return reject("store-error", 503, id); }
      if (row === null) return reject("not-found", 404, id);
      log({ event: "question.api.read", rid, token, id });
      return {
        status: 200,
        body: {
          id: row.id, kind: row.kind, page: row.page, created_at: row.created_at, updated_at: row.updated_at, email: row.email, question: row.question,
          state: row.state, version: row.version, response: row.response, response_source: row.response_source,
        },
      };
    }

    const decoded = await call.body();
    if (!decoded.ok) return reject(decoded.reason, decoded.status, id);
    const body = parseReplyBody(decoded.value);
    if (body === null) return reject("bad-body", 400, id);
    if (!CARRIES_TEXT.has(body.to) && (body.text !== undefined || body.source !== undefined)) return reject("text-not-stored", 400, id);
    // The upload can take seconds: the token must still be live, and the same operator, at the moment of writing. The
    // check runs inside the write transaction, so a revoke or rotate commits either before it (refused) or after the write.
    const guard = (): void => {
      const again = call.recheck();
      if (again === "unsafe") throw new AuthRefused(reject("auth-unavailable", 503, id));
      if (again === null || again.tokenId !== token) throw new AuthRefused(reject("unauthenticated", 401, id, { "www-authenticate": CHALLENGE }));
    };
    let result: ChangeResult;
    try { result = applyReply(questions, id, body, `operator:api:${token}`, opts.clock(), guard); }
    catch (error) { return error instanceof AuthRefused ? error.outcome : reject("store-error", 503, id); }
    if (!result.ok) return reject(result.reason, CHANGE_STATUS[result.reason] ?? 400, id);
    log({ event: "question.api.changed", rid, token, id });
    return { status: 200, body: { id, state: body.to, version: result.version } };
  };

  /** The reply route's body as the HTTP API reads it: JSON content type, the byte cap and the upload deadline. */
  const readBody = async (request: Request): Promise<AdminBody> => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return { ok: false, reason: "json-required", status: 415 };
    if (Number(request.headers.get("content-length") ?? 0) > bodyCap) return { ok: false, reason: "too-large", status: 413 };
    try {
      return { ok: true, value: JSON.parse(await boundedBody(request, bodyCap, BODY_TIMEOUT_MS)) };
    } catch (error) {
      if (error instanceof BodyTimeout) return { ok: false, reason: "body-timeout", status: 408 };
      return error instanceof TooLarge || !(error instanceof SyntaxError) ? { ok: false, reason: "too-large", status: 413 } : { ok: false, reason: "bad-json", status: 400 };
    }
  };

  const handle = async (request: Request, pathname: string, rid: string): Promise<Response> => {
    const reject = (reason: string, status: number, extra: Record<string, string> = {}): Response => {
      log({ event: "question.api.rejected", rid, token: null, reason });
      return reply({ code: reason }, status, extra);
    };
    if (questions === null) return reject("questions-unavailable", 503);
    const principal = authenticate(request);
    if (principal === "unsafe") return reject("auth-unavailable", 503);
    if (principal === null) return reject("unauthenticated", 401, { "www-authenticate": CHALLENGE });
    const done = await perform({ principal, recheck: () => check(request), method: request.method, pathname, body: () => readBody(request), rid });
    return reply(done.body, done.status, { ...done.headers });
  };

  return {
    handle,
    authenticate,
    check,
    perform,
    close: () => {
      questions?.close();
      tokens?.close();
    },
  };
}
