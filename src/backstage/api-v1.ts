// /api/v1: the six decide tools over HTTP, for scripts, CI jobs and agents. The same contract as the CLI and the MCP
// server: this file maps a JSON body onto the shared argument schemas (src/decide/tool-args.ts) and the CLI's tool
// functions (src/decide/cli.ts); it holds no decide logic.
//
// Auth: `Authorization: Bearer <token>` on every route, GET /arms included, checked before anything else. Tokens are
// operator-minted (scripts/api-token-mint.ts) and stored as sha256 hashes (src/backstage/api-tokens.ts).
// Keys: the caller's, per request, from x-jev-key, x-openai-key and x-anthropic-key. Never logged, stored, echoed or put in
// an error body. The server's own env keys and the funded trial key are never read here.
// The llm arm runs only through the Messages API: the claude-cli transport would spend the operator's subscription on a
// caller's behalf, so it is not offered, and with no x-anthropic-key the llm rows are outcome error, a named reason.
// run returns the rows inline (or, with options.format "csv", as one records CSV string) and writes no file. A run stops
// starting provider calls when the client disconnects or the per-request deadline passes. No CORS header is set: v1 has
// no browser callers.
import { z } from "zod";
import { armsReport, CliInputError, spendTool, validateOfText, verdictOfText, type ToolAnswer } from "../decide/cli.ts";
import { KEY_ENV } from "../decide/cli-args.ts";
import type { LlmTransport } from "../decide/llm.ts";
import { DecideError, type DecideRequest, type RunDeps } from "../decide/run.ts";
import { armsArg, caseArg, caseOf, casesOf, optionsArg, questionArg, requestOf } from "../decide/tool-args.ts";
import type { DecideFetch, ProviderKeys } from "../decide/types.ts";
import type { ApiTokenStore } from "./api-tokens.ts";
import { boundedText } from "./providers.ts";

export const API_V1_PREFIX = "/api/v1";

export const API_V1_LIMITS = {
  /** Cases per estimate or run request. */
  maxCases: 10,
  /** Questions per request. */
  maxQuestions: 5,
  /** The budget cap applied to ask and run when the caller sets none (USD). */
  defaultBudgetUsd: 1,
  /** The highest budgetUsd a caller may set (USD). */
  maxBudgetUsd: 5,
  /** Request body cap, the same as the Backstage routes and Bun.serve's maxRequestBodySize. */
  maxBodyBytes: 65536,
  /** /api/v1 requests in flight at once (inside the server's overall cap). */
  maxConcurrent: 4,
  /** Per provider call. */
  providerTimeoutMs: 30_000,
  /** One /api/v1 request, under the idle timeout: past it no new provider call starts and the rest are incomplete. */
  requestDeadlineMs: 100_000,
  /** Idle timeout of one /api/v1 connection on the Bun server (seconds). */
  requestTimeoutSeconds: 120,
} as const;

export const API_KEY_HEADERS: Readonly<Record<keyof ProviderKeys, string>> = { jev: "x-jev-key", openai: "x-openai-key", anthropic: "x-anthropic-key" };

/** The HTTP surface allows only the Messages API for the llm arm. */
export const API_LLM_TRANSPORTS: readonly LlmTransport[] = ["messages-api"];

type Route = "arms" | "estimate" | "ask" | "run" | "verdict" | "validate";
export const API_V1_ROUTES: readonly (readonly ["GET" | "POST", string])[] = [
  ["GET", `${API_V1_PREFIX}/arms`],
  ["POST", `${API_V1_PREFIX}/estimate`],
  ["POST", `${API_V1_PREFIX}/ask`],
  ["POST", `${API_V1_PREFIX}/run`],
  ["POST", `${API_V1_PREFIX}/verdict`],
  ["POST", `${API_V1_PREFIX}/validate`],
];

const questions = z.array(questionArg).min(1).max(API_V1_LIMITS.maxQuestions);
const cases = z.array(caseArg).min(1, "no cases").max(API_V1_LIMITS.maxCases);
const spendShape = { questions, arms: armsArg.optional(), options: optionsArg.optional() };
const BODIES = {
  estimate: z.strictObject({ ...spendShape, cases }),
  ask: z.strictObject({ ...spendShape, case: caseArg }),
  // No `out`: the HTTP run writes no server file. A body naming one is rejected as an unknown key.
  // options.format "csv" returns the rows as one `records` CSV string, the text verdict and validate take.
  run: z.strictObject({ ...spendShape, cases, options: optionsArg.extend({ format: z.enum(["rows", "csv"]).optional().describe("rows (default) or csv") }).optional() }),
  verdict: z.strictObject({ records: z.string().describe("jnj-record CSV text"), question: z.string().optional() }),
  validate: z.strictObject({ records: z.string().describe("jnj-record CSV text") }),
};

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

function reply(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

function invalid(errors: readonly string[], exitCode = 2): Response {
  return reply({ code: "invalid-input", exit_code: exitCode, errors }, 400);
}

function answer(a: ToolAnswer): Response {
  return a.body === null ? invalid(a.errors, a.code) : reply(a.body);
}

export interface ApiV1Options {
  readonly tokens: ApiTokenStore;
  /** Test-only: provider fetch, spawn and which in place of the network and the claude binary. */
  readonly deps?: Pick<RunDeps, "fetch" | "spawn" | "which">;
  readonly timeoutMs?: number;
  /** Test-only: the per-request deadline in place of API_V1_LIMITS.requestDeadlineMs. */
  readonly deadlineMs?: number;
}

/** One slot of the server's overall concurrency cap. */
export interface ApiSlot {
  readonly acquire: () => boolean;
  readonly release: () => void;
}

export interface ApiOutcome {
  readonly response: Response;
  readonly route: string;
  /** The token id that authenticated the request, or null. Never the token. */
  readonly tokenId: string | null;
}

function keysFrom(request: Request): ProviderKeys {
  const pick = (name: string): string | undefined => {
    const v = request.headers.get(name)?.trim();
    return v === undefined || v === "" ? undefined : v;
  };
  const jev = pick(API_KEY_HEADERS.jev);
  const openai = pick(API_KEY_HEADERS.openai);
  const anthropic = pick(API_KEY_HEADERS.anthropic);
  return { ...(jev !== undefined ? { jev } : {}), ...(openai !== undefined ? { openai } : {}), ...(anthropic !== undefined ? { anthropic } : {}) };
}

/** The env shape armsReport reads, built from the request's key headers: it reports which are set, never a value. */
function keyEnvOf(keys: ProviderKeys): Record<string, string | undefined> {
  return { [KEY_ENV.jev]: keys.jev, [KEY_ENV.openai]: keys.openai, [KEY_ENV.anthropic]: keys.anthropic };
}

function zodErrors(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`);
}

/** ask and run: the caller's budget, capped; the default cap when none is set. estimate spends 0 and is left as asked. */
function capped(request: DecideRequest): DecideRequest {
  const asked = request.options?.budgetUsd;
  if (asked !== undefined && asked > API_V1_LIMITS.maxBudgetUsd) {
    throw new CliInputError(`options.budgetUsd ${asked} is above the HTTP cap of ${API_V1_LIMITS.maxBudgetUsd} USD`);
  }
  return { ...request, options: { ...request.options, budgetUsd: asked ?? API_V1_LIMITS.defaultBudgetUsd } };
}

export function createApiV1(opts: ApiV1Options): (request: Request, pathname: string, slot: ApiSlot) => Promise<ApiOutcome> {
  let active = 0;
  const timeoutMs = opts.timeoutMs ?? API_V1_LIMITS.providerTimeoutMs;
  const deadlineMs = opts.deadlineMs ?? API_V1_LIMITS.requestDeadlineMs;
  // Each call ends at its own timeout or when the request's signal fires (client gone, or the request deadline).
  const timedFetch: DecideFetch = (url, init) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal !== undefined ? AbortSignal.any([timeout, init.signal]) : timeout;
    return fetch(url, { method: init.method, headers: { ...init.headers }, body: init.body, signal });
  };
  const refuseSpawn: RunDeps["spawn"] = async () => {
    throw new Error("claude-cli is not offered over HTTP");
  };
  const depsFor = (keys: ProviderKeys, signal: AbortSignal): RunDeps => ({
    keys,
    fetch: opts.deps?.fetch ?? timedFetch,
    spawn: opts.deps?.spawn ?? refuseSpawn,
    which: opts.deps?.which ?? (() => null),
    llmTransports: API_LLM_TRANSPORTS,
    signal,
  });

  const routeOf = (pathname: string): Route | null => {
    const name = pathname.slice(API_V1_PREFIX.length + 1);
    return name === "arms" || name === "estimate" || name === "ask" || name === "run" || name === "verdict" || name === "validate" ? name : null;
  };

  const body = async (request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      return { ok: false, response: reply({ code: "json-required" }, 415) };
    }
    if (Number(request.headers.get("content-length") ?? 0) > API_V1_LIMITS.maxBodyBytes) return { ok: false, response: reply({ code: "too-large" }, 413) };
    let raw: string;
    try {
      raw = await boundedText(new Response(request.body), API_V1_LIMITS.maxBodyBytes, AbortSignal.timeout(5000));
    } catch {
      return { ok: false, response: reply({ code: "too-large" }, 413) };
    }
    try {
      const value: unknown = JSON.parse(raw);
      return { ok: true, value };
    } catch {
      return { ok: false, response: reply({ code: "invalid-json", exit_code: 2, errors: ["body is not JSON"] }, 400) };
    }
  };

  const dispatch = async (route: Exclude<Route, "arms">, value: unknown, keys: ProviderKeys, signal: AbortSignal): Promise<Response> => {
    const deps = async (): Promise<RunDeps> => depsFor(keys, signal);
    if (route === "verdict") {
      const b = BODIES.verdict.safeParse(value);
      if (!b.success) return invalid(zodErrors(b.error));
      return answer(await verdictOfText(b.data.records, "records", b.data.question));
    }
    if (route === "validate") {
      const b = BODIES.validate.safeParse(value);
      if (!b.success) return invalid(zodErrors(b.error));
      return reply(validateOfText(b.data.records).body);
    }
    if (route === "ask") {
      const b = BODIES.ask.safeParse(value);
      if (!b.success) return invalid(zodErrors(b.error));
      return answer(await spendTool("ask", capped(requestOf(b.data.questions, [caseOf(b.data.case)], b.data.arms, b.data.options)), undefined, deps, {}));
    }
    if (route === "run") {
      const b = BODIES.run.safeParse(value);
      if (!b.success) return invalid(zodErrors(b.error));
      const { format, ...options } = b.data.options ?? {};
      const request = requestOf(b.data.questions, casesOf(b.data.cases), b.data.arms, options);
      return answer(await spendTool("run", capped(request), undefined, deps, {}, format ?? "rows"));
    }
    const b = BODIES.estimate.safeParse(value);
    if (!b.success) return invalid(zodErrors(b.error));
    return answer(await spendTool("estimate", requestOf(b.data.questions, casesOf(b.data.cases), b.data.arms, b.data.options), undefined, deps, {}));
  };

  return async (request, pathname, slot) => {
    const tokenId = opts.tokens.verify(request.headers.get("authorization"));
    const route = routeOf(pathname);
    const label = route ?? "unknown";
    if (tokenId === null) {
      return { route: label, tokenId, response: reply({ code: "unauthenticated" }, 401, { "www-authenticate": 'Bearer realm="jevnotjev-api"' }) };
    }
    if (route === null) return { route: label, tokenId, response: reply({ code: "not-found" }, 404) };
    const methods = route === "arms" ? ["GET", "HEAD"] : ["POST"];
    if (!methods.includes(request.method)) return { route, tokenId, response: reply({ code: "method-not-allowed" }, 405, { allow: methods.join(", ") }) };
    const keys = keysFrom(request);
    if (route === "arms") {
      const arms = reply({ ...armsReport(keyEnvOf(keys), API_LLM_TRANSPORTS), keyHeaders: API_KEY_HEADERS, limits: API_V1_LIMITS });
      return { route, tokenId, response: request.method === "HEAD" ? new Response(null, { status: 200, headers: arms.headers }) : arms };
    }
    if (active >= API_V1_LIMITS.maxConcurrent || !slot.acquire()) {
      return { route, tokenId, response: reply({ code: "runner-busy" }, 503) };
    }
    active++;
    try {
      const parsed = await body(request);
      if (!parsed.ok) return { route, tokenId, response: parsed.response };
      // The client going away (Bun aborts request.signal) or the request deadline stops the run before its next call.
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(deadlineMs)]);
      return { route, tokenId, response: await dispatch(route, parsed.value, keys, signal) };
    } catch (error) {
      if (error instanceof CliInputError || error instanceof DecideError) return { route, tokenId, response: invalid([error.message]) };
      // Unexpected: no message is echoed (it could hold anything); the status says what kind of failure it was.
      return { route, tokenId, response: reply({ code: "internal-error" }, 500) };
    } finally {
      active--;
      slot.release();
    }
  };
}
