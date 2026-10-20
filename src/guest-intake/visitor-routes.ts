// Visitor HTTP routes (#307): a signed-in Google visitor asks one free question and reads its own rows. Dispatched by
// server.ts before the guest, admin and decide /api/v1 handlers:
//
//   GET  /api/v1/visitor/me                { email, can_ask, reason, waitlist_position }
//   GET  /api/v1/visitor/questions         own rows, newest first, with question and reply
//   GET  /api/v1/visitor/questions/<id>    one own row
//   POST /api/v1/visitor/questions         submit the one free question   { id, state, replay }
//   POST /api/v1/visitor/sign-out          204, cookie cleared, generation rotated
//
// Auth is the visitor cookie only (visitors.ts), re-read from the row on every request and again right before the
// write. The stored email is the row's verified Google email, never the body. Every POST must be strictly same-origin.
// A store throw is 503 store-error; nothing here returns 500. Log lines carry an event, a request id, the visitor id, a
// question id, a reason or a count; never an email, sub, token, cookie, question or reply text. No model call, no mail.
import { TicketLimiter } from "../backstage/tickets.ts";
import { parseCookie, SESSION_TTL_MS } from "../backstage/auth.ts";
import { checkGuestSubmission, MAX_QUESTION_BODY, QUESTION_ID, QUESTION_LIMITS, type QuestionLimits } from "./contract.ts";
import { boundedBody, TooLarge } from "./routes.ts";
import { QuestionStore, type VisitorStanding, type VisitorSubmitResult } from "./store.ts";
import { generationFingerprint, signVisitorToken, verifyVisitorToken, visitorCookie, visitorCookieName, VisitorStore, type VisitorRow } from "./visitors.ts";
import { randomBytes } from "node:crypto";

export const VISITOR_PREFIX = "/api/v1/visitor";
const ME_PATH = `${VISITOR_PREFIX}/me`;
const QUESTIONS_PATH = `${VISITOR_PREFIX}/questions`;
const SIGN_OUT_PATH = `${VISITOR_PREFIX}/sign-out`;

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
const BODY_TIMEOUT_MS = 5000;
const MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;
export const ONE_QUESTION_MESSAGE = "You have already used your free question. Your question and its reply are on this page.";
export const FREE_SLOTS_USED_MESSAGE = "The free places are taken. You are on the waitlist.";

/** True for every path the visitor handler owns: the prefix itself and anything under it. */
export function isVisitorPath(pathname: string): boolean {
  return pathname === VISITOR_PREFIX || pathname.startsWith(`${VISITOR_PREFIX}/`);
}

export type VisitorLog =
  | { readonly event: "visitor.question.received"; readonly rid: string; readonly vid: string; readonly id: string; readonly replay: boolean }
  | { readonly event: "visitor.question.rejected"; readonly rid: string; readonly vid: string | null; readonly reason: string }
  | { readonly event: "visitor.question.read"; readonly rid: string; readonly vid: string; readonly id: string | null }
  | { readonly event: "visitor.question.list"; readonly rid: string; readonly vid: string; readonly count: number }
  | { readonly event: "visitor.signout"; readonly rid: string; readonly vid: string | null };

export interface VisitorRoutesOptions {
  /** The tickets.sqlite path; without one every visitor route answers 503 and no visitor signs in. */
  readonly path: string | undefined;
  readonly origin: string;
  readonly secret: string;
  readonly clock: () => number;
  readonly log?: ((line: string) => void) | undefined;
  readonly limits?: Partial<QuestionLimits> | undefined;
  readonly limiterCapacity?: number | undefined;
}

export type VisitorSignInResult =
  | { readonly ok: true; readonly setCookie: string; readonly vid: string }
  | { readonly ok: false; readonly reason: "disabled" | "full" | "unavailable" };

export interface VisitorRoutes {
  readonly handle: (request: Request, pathname: string, ip: string, rid: string) => Promise<Response>;
  readonly signIn: (sub: string, email: string) => VisitorSignInResult;
  readonly close: () => void;
}

/** An authenticated visitor: its row as read at request start and the cookie token's expiry. */
interface Principal {
  readonly row: VisitorRow;
  readonly exp: number;
}

type Target ={ readonly kind: "me" } | { readonly kind: "list" } | { readonly kind: "one"; readonly id: string } | { readonly kind: "sign-out" } | { readonly kind: "none" };

function targetOf(pathname: string): Target {
  if (pathname === ME_PATH) return { kind: "me" };
  if (pathname === SIGN_OUT_PATH) return { kind: "sign-out" };
  if (pathname === QUESTIONS_PATH) return { kind: "list" };
  if (!pathname.startsWith(`${QUESTIONS_PATH}/`)) return { kind: "none" };
  const id = pathname.slice(QUESTIONS_PATH.length + 1);
  return QUESTION_ID.test(id) ? { kind: "one", id } : { kind: "none" };
}

function methodsOf(target: Target): readonly string[] {
  return target.kind === "list" ? ["GET", "POST"] : target.kind === "sign-out" ? ["POST"] : ["GET"];
}

export function createVisitorRoutes(opts: VisitorRoutesOptions): VisitorRoutes {
  const limits: QuestionLimits = { ...QUESTION_LIMITS, ...opts.limits };
  const path = opts.path;
  const questions = path ? new QuestionStore(path, limits) : null;
  const visitors = path ? new VisitorStore(path) : null;
  const secretOk = opts.secret.length >= 32;
  const limiter = opts.limiterCapacity === undefined ? new TicketLimiter(opts.clock) : new TicketLimiter(opts.clock, opts.limiterCapacity);
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: VisitorLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...HEADERS, ...extra } });
  const scopeOf = (vid: string): string => `visitor:${vid}`;

  /** The live row plus the token's expiry for the request's visitor cookie, null when unauthenticated, or "unsafe" when
   * the store threw. */
  const authenticate = (request: Request): Principal | null | "unsafe" => {
    if (visitors === null || !secretOk) return null;
    const value = parseCookie(request.headers.get("cookie"), visitorCookieName(opts.origin));
    if (!value) return null;
    const token = verifyVisitorToken(value, opts.secret, opts.clock());
    if (token === null) return null;
    try {
      const row = visitors.get(token.vid);
      if (row === null || row.disabled_at !== null || generationFingerprint(row.generation) !== token.gen) return null;
      return { row, exp: token.exp };
    } catch {
      return "unsafe";
    }
  };

  const sameOrigin = (request: Request): boolean => {
    const site = request.headers.get("sec-fetch-site");
    return request.headers.get("origin") === opts.origin && (site === null || site === "same-origin");
  };

  /** The waitlist position when the free places are taken, after marking the visitor waitlisted. */
  const standing = (vid: string): { reason: VisitorStanding; position: number | null } => {
    if (questions === null || visitors === null) throw new Error("questions unavailable");
    const reason = questions.visitorStanding(scopeOf(vid));
    return { reason, position: reason === "free-slots-used" ? visitors.waitlist(vid, opts.clock()) : null };
  };

  const signIn = (sub: string, email: string): VisitorSignInResult => {
    if (visitors === null || questions === null || !secretOk) return { ok: false, reason: "unavailable" };
    try {
      const now = opts.clock();
      const result = visitors.signIn(sub, email, now);
      if (result.status !== "ok") return { ok: false, reason: result.status };
      standing(result.id);
      const token = signVisitorToken({ role: "visitor", vid: result.id, iat: now, exp: now + SESSION_TTL_MS, sid: randomBytes(24).toString("base64url"), gen: generationFingerprint(result.generation) }, opts.secret);
      return { ok: true, setCookie: visitorCookie(opts.origin, token, MAX_AGE_SECONDS), vid: result.id };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  };

  const handle = async (request: Request, pathname: string, ip: string, rid: string): Promise<Response> => {
    const reject = (reason: string, status: number, vid: string | null, extra: Record<string, string> = {}): Response => {
      log({ event: "visitor.question.rejected", rid, vid, reason });
      return reply({ code: reason }, status, extra);
    };
    const target = targetOf(pathname);
    // Sign-out is never counted or refused by the submit limiter: five submits must not keep a session alive.
    if (request.method === "POST" && target.kind !== "sign-out" && !limiter.allow(ip)) return reject("rate-limited", 429, null);
    if (questions === null || visitors === null) return reject("questions-unavailable", 503, null);
    if (!secretOk) return reject("auth-unavailable", 503, null);

    if (target.kind === "sign-out") {
      if (request.method !== "POST") return reject("method-not-allowed", 405, null, { allow: "POST" });
      if (!sameOrigin(request)) return reject("cross-origin", 403, null);
      // A store that cannot read or rotate the row is 503, not a 204 that leaves the session valid. The 503 keeps the
      // cookie, so the retry still carries it and can revoke; only a 204 clears it.
      const principal = authenticate(request);
      if (principal === "unsafe") return reject("store-error", 503, null);
      const vid = principal === null ? null : principal.row.id;
      if (vid !== null) {
        try { visitors.rotate(vid); }
        catch { return reject("store-error", 503, vid); }
      }
      log({ event: "visitor.signout", rid, vid });
      return new Response(null, { status: 204, headers: { ...HEADERS, "set-cookie": visitorCookie(opts.origin, "", 0) } });
    }

    const principal = authenticate(request);
    if (principal === "unsafe") return reject("store-error", 503, null);
    if (principal === null) return reject("unauthenticated", 401, null);
    const vid = principal.row.id;
    const scope = scopeOf(vid);
    if (target.kind === "none") return reject("not-found", 404, vid);
    const methods = methodsOf(target);
    if (!methods.includes(request.method)) return reject("method-not-allowed", 405, vid, { allow: methods.join(", ") });

    if (request.method === "GET") {
      try {
        if (target.kind === "me") {
          const { reason, position } = standing(vid);
          return reply({ email: principal.row.email, can_ask: reason === null, reason, waitlist_position: position });
        }
        if (target.kind === "list") {
          const rows = questions.visitorList(scope);
          log({ event: "visitor.question.list", rid, vid, count: rows.length });
          return reply({ questions: rows });
        }
        if (target.kind !== "one") return reject("not-found", 404, vid);
        const view = questions.visitorRead(scope, target.id);
        log({ event: "visitor.question.read", rid, vid, id: view === null ? null : view.id });
        return view === null ? reply({ code: "not-found" }, 404) : reply(view);
      } catch {
        return reject("store-error", 503, vid);
      }
    }

    if (!sameOrigin(request)) return reject("cross-origin", 403, vid);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reject("json-required", 415, vid);
    if (Number(request.headers.get("content-length") ?? 0) > MAX_QUESTION_BODY) return reject("too-large", 413, vid);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await boundedBody(request, MAX_QUESTION_BODY, BODY_TIMEOUT_MS));
    } catch (error) {
      return error instanceof TooLarge || !(error instanceof SyntaxError) ? reject("too-large", 413, vid) : reject("bad-json", 400, vid);
    }
    const checked = checkGuestSubmission(decoded, limits);
    if (!checked.ok) return reject(checked.reason, 400, vid);
    if ("trap" in checked) return reject("bad-body", 400, vid);
    // The upload can take seconds and the write may wait for the lock: the session is re-checked as the first statement
    // inside the write transaction, so a sign-out (new generation), a disable or a token expiry that lands before the
    // write refuses it, replays included. The stored email is the row's email read there, not the one read at the start.
    const verifiedEmail = (): string | null => {
      const row = visitors.get(vid);
      if (row === null || row.disabled_at !== null || row.generation !== principal.row.generation) return null;
      return principal.exp > opts.clock() ? row.email : null;
    };
    let result: VisitorSubmitResult;
    try { result = questions.visitorSubmit(scope, checked.submission, opts.clock(), verifiedEmail); }
    catch { return reject("store-error", 503, vid); }
    if (result.status === "unauthenticated") return reject("unauthenticated", 401, vid);
    if (result.status === "conflict") return reject("request-key-reused", 409, vid);
    if (result.status === "deleted") return reject("deleted", 410, vid);
    if (result.status === "capacity") return reject("capacity", 503, vid);
    if (result.status === "one-question") {
      log({ event: "visitor.question.rejected", rid, vid, reason: "one-question" });
      return reply({ code: "one-question", message: ONE_QUESTION_MESSAGE }, 409);
    }
    if (result.status === "free-slots-used") {
      let position: number;
      try { position = visitors.waitlist(vid, opts.clock()); }
      catch { return reject("store-error", 503, vid); }
      log({ event: "visitor.question.rejected", rid, vid, reason: "free-slots-used" });
      return reply({ code: "free-slots-used", message: FREE_SLOTS_USED_MESSAGE, waitlist_position: position }, 409);
    }
    log({ event: "visitor.question.received", rid, vid, id: result.id, replay: result.status === "replay" });
    return reply({ id: result.id, state: result.state, replay: result.status === "replay" });
  };

  return {
    handle,
    signIn,
    close: () => {
      questions?.close();
      visitors?.close();
    },
  };
}
