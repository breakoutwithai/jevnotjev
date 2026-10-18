// Public guest-question routes (#253): POST /api/questions (submit) and POST /api/questions/status (read by status code).
// Public at nginx (exact locations in .deploy/backstage-nginx.conf). Same-origin JSON only, body caps equal to nginx's,
// a bounded per-address attempt limiter on each route, and write quotas in the store. Nothing here sends mail, publishes,
// or calls a provider. Logs carry an event, a request id, a question id and a reason; never an email, question text,
// request key or status code.
import { TicketLimiter } from "../backstage/tickets.ts";
import { checkPublicSubmission, MAX_QUESTION_BODY, MAX_STATUS_BODY, parseStatusBody, QUESTION_LIMITS, type QuestionLimits } from "./contract.ts";
import { QuestionStore, type SubmitResult } from "./store.ts";

export const QUESTION_ROUTES: readonly string[] = ["/api/questions", "/api/questions/status"];

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

export type QuestionLog =
  | { readonly event: "question.received"; readonly rid: string; readonly id: string; readonly replay: boolean }
  | { readonly event: "question.rejected"; readonly rid: string; readonly reason: string }
  | { readonly event: "question.status"; readonly rid: string; readonly found: boolean };

export interface QuestionRoutesOptions {
  /** The tickets.sqlite path; without one both routes answer 503 questions-unavailable. */
  readonly path: string | undefined;
  readonly origin: string;
  readonly clock: () => number;
  readonly log?: ((line: string) => void) | undefined;
  readonly limits?: Partial<QuestionLimits> | undefined;
  /** Addresses each attempt limiter tracks before it refuses new ones. */
  readonly limiterCapacity?: number | undefined;
}

export interface QuestionRoutes {
  readonly handle: (request: Request, pathname: string, ip: string, rid: string) => Promise<Response>;
  readonly close: () => void;
}

export class TooLarge extends Error {}

/** Read at most `cap` bytes of the body within `timeoutMs`; past either, TooLarge. */
export async function boundedBody(request: Request, cap: number, timeoutMs: number): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new TooLarge();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new TooLarge()), left); });
      const next = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > cap) throw new TooLarge();
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof TooLarge ? error : new TooLarge();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createQuestionRoutes(opts: QuestionRoutesOptions): QuestionRoutes {
  const limits: QuestionLimits = { ...QUESTION_LIMITS, ...opts.limits };
  const store = opts.path ? new QuestionStore(opts.path, limits) : null;
  const capacity = opts.limiterCapacity;
  const submitLimiter = capacity === undefined ? new TicketLimiter(opts.clock) : new TicketLimiter(opts.clock, capacity);
  const statusLimiter = capacity === undefined ? new TicketLimiter(opts.clock) : new TicketLimiter(opts.clock, capacity);
  const output = opts.log ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const log = (fields: QuestionLog): void => {
    try { output(JSON.stringify({ ts: new Date(opts.clock()).toISOString(), ...fields })); }
    catch { /* Logging cannot affect a request. */ }
  };
  const reply = (body: unknown, status = 200, extra: Record<string, string> = {}): Response => Response.json(body, { status, headers: { ...HEADERS, ...extra } });

  const handle = async (request: Request, pathname: string, ip: string, rid: string): Promise<Response> => {
    const status = pathname === "/api/questions/status";
    const reject = (reason: string, code: number): Response => { log({ event: "question.rejected", rid, reason }); return reply({ code: reason }, code); };
    if (request.method !== "POST") return reply({ code: "method-not-allowed" }, 405, { allow: "POST" });
    if (!(status ? statusLimiter : submitLimiter).allow(ip)) return reject("rate-limited", 429);
    if (request.headers.get("origin") !== opts.origin || request.headers.get("sec-fetch-site") === "cross-site") return reject("origin-rejected", 403);
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return reject("json-required", 415);
    if (store === null) return reject("questions-unavailable", 503);
    const cap = status ? MAX_STATUS_BODY : MAX_QUESTION_BODY;
    if (Number(request.headers.get("content-length") ?? 0) > cap) return reject("too-large", 413);
    let decoded: unknown;
    try {
      decoded = JSON.parse(await boundedBody(request, cap, 5000));
    } catch (error) {
      return error instanceof SyntaxError ? reject("bad-json", 400) : reject("too-large", 413);
    }
    if (status) {
      const code = parseStatusBody(decoded);
      if (code === null) return reject("bad-code", 400);
      let view;
      try { view = store.publicStatus(code.id, code.key); }
      catch { return reject("store-error", 503); }
      log({ event: "question.status", rid, found: view !== null });
      return view === null ? reply({ code: "not-found" }, 404) : reply(view);
    }
    const checked = checkPublicSubmission(decoded, limits);
    if (!checked.ok) return reject(checked.reason, 400);
    if ("trap" in checked) { log({ event: "question.rejected", rid, reason: "honeypot" }); return reply({ ok: true }); }
    let result: SubmitResult;
    try { result = store.submit("public", checked.submission, opts.clock()); }
    catch { return reject("store-error", 503); }
    if (result.status === "conflict") return reject("request-key-reused", 409);
    if (result.status === "deleted") return reject("deleted", 410);
    if (result.status === "capacity") return reject("capacity", 503);
    log({ event: "question.received", rid, id: result.id, replay: result.status === "replay" });
    return reply({ id: result.id, status_code: `${result.id}.${checked.submission.requestKey}`, state: result.state, replay: result.status === "replay" });
  };

  return { handle, close: () => store?.close() };
}
