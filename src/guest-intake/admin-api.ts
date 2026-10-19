// Operator bearer API for submitted /ask/ questions (#282), for an operator's agent (admin-mcp.ts) or a script. Dispatched
// by server.ts before the decide /api/v1 handler; nginx's ^~ /api/v1/ location already forwards it.
//
//   GET  /api/v1/admin/questions             newest first, at most ADMIN_LIST_MAX   { total, questions: [{ id, state, created_at, updated_at, version }] }
//   GET  /api/v1/admin/questions/<id>        one question                           { id, created_at, updated_at, email, question, state, version, response, response_source }
//   POST /api/v1/admin/questions/<id>/reply  { version, to, text?, source? }        { id, state, version }
//
// Auth is an admin bearer (`jna_`, tokens.ts) with scope questions:admin, re-read from the store on every request and
// again after the reply body is read, so a revoke applies at once and a revoke mid-upload changes nothing. A guest or
// decide token, a session cookie, or nothing at all is 401. Unsafe token state is 503 auth-unavailable. Reads and
// replies call the same QuestionStore methods as the CLI and the #278 page (list, show, transition, answer) and reuse
// that page's body parser, refusal statuses and reply dispatch. There is no delete or purge route. Logs carry an event,
// a request id, the token id, a question id and a reason; never a token, an email, question text or a reply.
import { applyReply, CHANGE_STATUS, parseReplyBody } from "./admin-routes.ts";
import { QUESTION_ID, QUESTION_LIMITS, type QuestionLimits } from "./contract.ts";
import { boundedBody, TooLarge } from "./routes.ts";
import { QuestionStore, type ChangeResult } from "./store.ts";
import { AdminTokenStore, type AdminPrincipal, type AdminScope } from "./tokens.ts";

export const ADMIN_API_PREFIX = "/api/v1/admin";
export const ADMIN_QUESTIONS_PATH = `${ADMIN_API_PREFIX}/questions`;
/** The longest list one request returns, newest first; `total` counts every row. */
export const ADMIN_LIST_MAX = 200;

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

export interface AdminApi {
  readonly handle: (request: Request, pathname: string, rid: string) => Promise<Response>;
  readonly close: () => void;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const CHALLENGE = 'Bearer realm="jevnotjev-admin"';
const BODY_TIMEOUT_MS = 5000;
/** The states whose transition stores the text; any other target refuses text rather than dropping it (#281). */
const CARRIES_TEXT = new Set(["needs_info", "answered"]);

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
  // Any reply the store accepts must fit in either JSON encoding (#280): a code point escaped as a surrogate pair is
  // twelve bytes (\uXXXX\uXXXX), plus the fields around the text.
  const bodyCap = limits.maxResponseChars * 12 + 1024;
  // Opened on first use, so an unsafe state directory is a 503 here, not a server that will not start.
  let tokens: AdminTokenStore | null = null;
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: AdminApiLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

  /** The verified operator, null for a bad token, or "unsafe" when the token state cannot be trusted. */
  const authenticate = (request: Request): AdminPrincipal | null | "unsafe" => {
    if (path === undefined) return "unsafe";
    try {
      tokens ??= new AdminTokenStore(path, opts.clock);
      return tokens.verify(request.headers.get("authorization"));
    } catch {
      return "unsafe";
    }
  };

  const handle = async (request: Request, pathname: string, rid: string): Promise<Response> => {
    const reject = (reason: string, status: number, token: string | null, id?: string, extra: Record<string, string> = {}): Response => {
      log(id === undefined ? { event: "question.api.rejected", rid, token, reason } : { event: "question.api.rejected", rid, token, id, reason });
      return reply({ code: reason }, status, extra);
    };
    if (questions === null) return reject("questions-unavailable", 503, null);
    const principal = authenticate(request);
    if (principal === "unsafe") return reject("auth-unavailable", 503, null);
    if (principal === null) return reject("unauthenticated", 401, null, undefined, { "www-authenticate": CHALLENGE });
    const token = principal.tokenId;
    const target = targetOf(pathname);
    if (target.kind === "none") return reject("not-found", 404, token);
    if (request.method !== target.route.method) return reject("method-not-allowed", 405, token, undefined, { allow: target.route.method });
    if (!principal.scopes.includes(target.route.scope)) return reject("forbidden", 403, token);

    if (target.kind === "list") {
      try {
        const rows = questions.list();
        const newest = rows.slice(-ADMIN_LIST_MAX).reverse().map((r) => ({ id: r.id, state: r.state, created_at: r.created_at, updated_at: r.updated_at, version: r.version }));
        log({ event: "question.api.list", rid, token });
        return reply({ total: rows.length, questions: newest });
      } catch {
        return reject("store-error", 503, token);
      }
    }
    const id = target.id;
    if (target.kind === "one") {
      let row;
      try { row = questions.show(id); }
      catch { return reject("store-error", 503, token, id); }
      if (row === null) return reject("not-found", 404, token, id);
      log({ event: "question.api.read", rid, token, id });
      return reply({
        id: row.id, created_at: row.created_at, updated_at: row.updated_at, email: row.email, question: row.question,
        state: row.state, version: row.version, response: row.response, response_source: row.response_source,
      });
    }

    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reject("json-required", 415, token, id);
    if (Number(request.headers.get("content-length") ?? 0) > bodyCap) return reject("too-large", 413, token, id);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await boundedBody(request, bodyCap, BODY_TIMEOUT_MS));
    } catch (error) {
      return error instanceof TooLarge || !(error instanceof SyntaxError) ? reject("too-large", 413, token, id) : reject("bad-json", 400, token, id);
    }
    const body = parseReplyBody(decoded);
    if (body === null) return reject("bad-body", 400, token, id);
    if (!CARRIES_TEXT.has(body.to) && (body.text !== undefined || body.source !== undefined)) return reject("text-not-stored", 400, token, id);
    // The upload can take seconds: the token must still be live, and the same operator, at the moment of writing.
    const again = authenticate(request);
    if (again === "unsafe") return reject("auth-unavailable", 503, token, id);
    if (again === null || again.tokenId !== token) return reject("unauthenticated", 401, token, id, { "www-authenticate": CHALLENGE });
    let result: ChangeResult;
    try { result = applyReply(questions, id, body, `operator:api:${token}`, opts.clock()); }
    catch { return reject("store-error", 503, token, id); }
    if (!result.ok) return reject(result.reason, CHANGE_STATUS[result.reason] ?? 400, token, id);
    log({ event: "question.api.changed", rid, token, id });
    return reply({ id, state: body.to, version: result.version });
  };

  return {
    handle,
    close: () => {
      questions?.close();
      tokens?.close();
    },
  };
}
