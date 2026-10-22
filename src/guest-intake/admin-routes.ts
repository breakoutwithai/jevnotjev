// Question admin routes (#278): the web counterpart of admin-cli.ts. Every route first asks the caller-supplied access
// check: no session is 401 unauthenticated, a session whose operators.json row lacks `"admin": true` is 403 with no
// question data. Reads and changes call the same QuestionStore methods the CLI calls (list, show, transition, answer),
// so the page and the CLI cannot disagree. The handlers check access themselves rather than trusting nginx's gate
// header. Logs carry an event, a request id, a question id and a reason; never an email, question text or reply.
import { isSameOrigin } from "../backstage/auth.ts";
import { renderAdminDetail, renderAdminList, renderAdminNotFound } from "./admin-page.ts";
import { isQuestionState, isResponseSource, QUESTION_ID, QUESTION_LIMITS, type QuestionLimits, type QuestionState, type ResponseSource } from "./contract.ts";
import { boundedBody } from "./routes.ts";
import { QuestionStore, type ChangeResult, type QueueEntry } from "./store.ts";

export interface AdminRoute {
  readonly method: "GET" | "POST";
  /** `{id}` stands for one question id. */
  readonly pattern: string;
}

export const ADMIN_PAGE = "/backstage/questions/";
export const ADMIN_API = "/api/backstage/questions";

/** Every route this module answers. Anything else under ADMIN_API is still access-checked, then 404. */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { method: "GET", pattern: ADMIN_PAGE },
  { method: "GET", pattern: ADMIN_API },
  { method: "GET", pattern: `${ADMIN_API}/{id}` },
  { method: "POST", pattern: `${ADMIN_API}/{id}/reply` },
];

/** True for every path this module owns, so the server dispatches it here before any other route. */
export function isAdminPath(pathname: string): boolean {
  return pathname === ADMIN_PAGE || pathname === ADMIN_API || pathname.startsWith(`${ADMIN_API}/`);
}

export type AdminAccess = "anonymous" | "forbidden" | "admin";

export type AdminLog =
  | { readonly event: "question.admin.list"; readonly rid: string }
  | { readonly event: "question.admin.read"; readonly rid: string; readonly id: string }
  | { readonly event: "question.admin.changed"; readonly rid: string; readonly id: string }
  | { readonly event: "question.admin.rejected"; readonly rid: string; readonly id?: string; readonly reason: string };

export interface AdminRoutesOptions {
  /** The tickets.sqlite path; without one every admin route answers 503 questions-unavailable after the access check. */
  readonly path: string | undefined;
  readonly origin: string;
  readonly clock: () => number;
  readonly log?: ((line: string) => void) | undefined;
  readonly limits?: Partial<QuestionLimits> | undefined;
}

export interface AdminRoutes {
  readonly handle: (request: Request, pathname: string, rid: string, access: () => AdminAccess) => Promise<Response>;
  readonly close: () => void;
}

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const ACTOR = "operator:web";
const REPLY_FIELDS = new Set(["version", "to", "text", "source"]);

export interface ReplyBody {
  readonly version: number;
  readonly to: QuestionState;
  readonly text: string | undefined;
  readonly source: ResponseSource | undefined;
}

/** `{version, to, text?, source?}` and nothing else, or null. */
export function parseReplyBody(value: unknown): ReplyBody | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Object.keys(value).some((k) => !REPLY_FIELDS.has(k))) return null;
  const version: unknown = Reflect.get(value, "version");
  const to: unknown = Reflect.get(value, "to");
  const text: unknown = Reflect.get(value, "text");
  const source: unknown = Reflect.get(value, "source");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || !isQuestionState(to)) return null;
  if (text !== undefined && typeof text !== "string") return null;
  if (source !== undefined && !isResponseSource(source)) return null;
  return { version, to, text, source };
}

/** HTTP status per store refusal, shared with the bearer API (admin-api.ts). */
export const CHANGE_STATUS: Readonly<Record<string, number>> = { "not-found": 404, "stale-version": 409, "bad-transition": 409, "message-required": 400, "bad-message": 400 };

/**
 * One reply body applied through the store, as the CLI does: a message without a named source is human_reviewed.
 * `guard` runs inside the store's write transaction (QuestionStore.transition).
 */
export function applyReply(store: QuestionStore, id: string, body: ReplyBody, actor: string, now: number, guard?: () => void): ChangeResult {
  const message = body.text === undefined ? undefined : { text: body.text, source: body.source ?? "human_reviewed" };
  return body.to === "answered" && message !== undefined
    ? store.answer(id, body.version, actor, now, message.text, message.source, guard)
    : store.transition(id, body.to, body.version, actor, now, message, guard);
}

/** The CLI's list(), newest first. */
function newestFirst(store: QuestionStore): QueueEntry[] {
  return store.list().reverse();
}

export function createAdminRoutes(opts: AdminRoutesOptions): AdminRoutes {
  const limits: QuestionLimits = { ...QUESTION_LIMITS, ...opts.limits };
  const store = opts.path ? new QuestionStore(opts.path, limits) : null;
  // A reply is at most maxResponseChars characters; four bytes each plus the JSON around it.
  const bodyCap = limits.maxResponseChars * 4 + 1024;
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: AdminLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

  const handle = async (request: Request, pathname: string, rid: string, access: () => AdminAccess): Promise<Response> => {
    const reject = (reason: string, status: number, id?: string): Response => {
      log(id === undefined ? { event: "question.admin.rejected", rid, reason } : { event: "question.admin.rejected", rid, id, reason });
      return reply({ code: reason }, status);
    };
    const who = access();
    if (who === "anonymous") return reject("unauthenticated", 401);
    if (who === "forbidden") return reject("forbidden", 403);
    if (store === null) return reject("questions-unavailable", 503);

    if (pathname === ADMIN_PAGE) {
      if (request.method !== "GET" && request.method !== "HEAD") return reply({ code: "method-not-allowed" }, 405, { allow: "GET" });
      const id = new URL(request.url).searchParams.get("id");
      if (id === null) { log({ event: "question.admin.list", rid }); return renderAdminList(newestFirst(store)); }
      const row = QUESTION_ID.test(id) ? store.show(id) : null;
      if (row === null) { log({ event: "question.admin.rejected", rid, reason: "not-found" }); return renderAdminNotFound(); }
      log({ event: "question.admin.read", rid, id: row.id });
      return renderAdminDetail(row);
    }
    if (pathname === ADMIN_API) {
      if (request.method !== "GET") return reply({ code: "method-not-allowed" }, 405, { allow: "GET" });
      log({ event: "question.admin.list", rid });
      return reply({ questions: newestFirst(store) });
    }
    const rest = pathname.slice(ADMIN_API.length + 1).split("/");
    const id = rest[0] ?? "";
    const known = QUESTION_ID.test(id);
    if (rest.length === 1) {
      if (request.method !== "GET") return reply({ code: "method-not-allowed" }, 405, { allow: "GET" });
      const row = known ? store.show(id) : null;
      if (row === null) return reject("not-found", 404, known ? id : undefined);
      log({ event: "question.admin.read", rid, id });
      return reply({
        id: row.id, kind: row.kind, page: row.page, created_at: row.created_at, updated_at: row.updated_at, scope: row.scope, email: row.email, question: row.question,
        reply_consent: row.reply_consent === 1, marketing_consent: row.marketing_consent === 1, state: row.state, version: row.version,
        response: row.response, response_source: row.response_source,
      });
    }
    if (rest.length !== 2 || rest[1] !== "reply") return reject("not-found", 404);
    if (request.method !== "POST") return reply({ code: "method-not-allowed" }, 405, { allow: "POST" });
    if (!isSameOrigin(request, opts.origin)) return reject("origin-rejected", 403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reject("json-required", 415);
    if (!known) return reject("not-found", 404);
    if (Number(request.headers.get("content-length") ?? 0) > bodyCap) return reject("too-large", 413, id);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await boundedBody(request, bodyCap, 5000));
    } catch (error) {
      return error instanceof SyntaxError ? reject("bad-json", 400, id) : reject("too-large", 413, id);
    }
    const body = parseReplyBody(decoded);
    if (body === null) return reject("bad-body", 400, id);
    let result: ChangeResult;
    try {
      // The store orders the refusals.
      result = applyReply(store, id, body, ACTOR, opts.clock());
    } catch {
      return reject("store-error", 503, id);
    }
    if (!result.ok) return reject(result.reason, CHANGE_STATUS[result.reason] ?? 400, id);
    log({ event: "question.admin.changed", rid, id });
    return reply({ id, state: body.to, version: result.version });
  };

  return { handle, close: () => store?.close() };
}
