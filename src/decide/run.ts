// estimate(), ask() and run(): plan one call per (case, arm), price it from the table, enforce the budget cap, call through
// the injected fetch or spawn, and write one jnj-record/1.2 row per (case, question, arm). Keys come in per call in `deps`
// and only ever reach a request header; the claude-cli transport uses no key. No row, evidence or error message holds one.
import { MIN_PAIRED } from "../core/verdict.ts";
import { JEV_PIN } from "../jev-answer.ts";
import { bunSpawn, whichClaude } from "./cli-spawn.ts";
import { DECISIONS_MODEL, DECISIONS_URL, decisionsBody, decisionsHeaders, parseDecisions } from "./decisions.ts";
import { JEV_URL, jevBody, jevHeaders, parseJev } from "./jev.ts";
import {
  CLI_COST_BASIS, LLM_MAX_TOKENS, LLM_TRANSPORTS, MESSAGES_URL, cliArgv, llmPrompt, messagesBody, messagesHeaders, parseCli,
  parseMessages, type DecideSpawn, type LlmTransport,
} from "./llm.ts";
import { DecideError, PRICE_TABLE_DATE, callCost, priceFor, resolveLlmModel, type PriceEntry } from "./prices.ts";
import { answerSet, caseInputCell, caseText, checkCases, checkQuestions, questionText } from "./questions.ts";
import { RULE_MODEL, ruleAnswer } from "./rule.ts";
import type {
  ArmName, Arms, CallResult, Case, DecideFetch, DecideRow, Evidence, Outcome, ProviderKeys, QuestionResult, QuestionSpec,
  RuleArm, RunOptions,
} from "./types.ts";

export { DecideError };

export const DEFAULT_LLM = "claude-haiku-5-5";
export const DEFAULT_RUN_ID = "run-001";
export const DEFAULT_PROMPT_VERSION = "decide.v1";
/** Fixed per-call overhead added to the request bytes when estimating input tokens (an upper bound, not a measure). */
export const ESTIMATE_OVERHEAD_TOKENS = 256;
const RUN_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export interface DecideRequest {
  readonly cases: readonly Case[];
  readonly questions: readonly QuestionSpec[];
  readonly arms?: Arms;
  readonly options?: RunOptions;
}

export interface AskRequest {
  readonly case: Case;
  readonly questions: readonly QuestionSpec[];
  readonly arms?: Arms;
  readonly options?: RunOptions;
}

export interface RunDeps {
  readonly keys?: ProviderKeys;
  readonly fetch?: DecideFetch;
  readonly spawn?: DecideSpawn;
  /** Finds the claude binary; null when absent. */
  readonly which?: () => string | null;
  /** llm transports allowed, in preference order. The hosted API passes ["messages-api"] to disable the cli. */
  readonly llmTransports?: readonly LlmTransport[];
  readonly now?: () => number;
  /** Fires when the caller is gone or its deadline passed: no new call starts, the call in flight is aborted, and every
   * call not made is outcome error, reason aborted, counted as incomplete (as the budget cap marks them). */
  readonly signal?: AbortSignal;
}

export interface ArmEstimate {
  readonly arm: ArmName;
  readonly model: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly priceTableDate: string | null;
}

export interface Estimate {
  readonly cases: number;
  readonly calls: number;
  readonly costUsd: number;
  readonly arms: readonly ArmEstimate[];
  readonly priceTableDate: string;
  /** Paired labelled cases the verdict needs (src/core/verdict.ts MIN_PAIRED). */
  readonly casesForVerdict: number;
  readonly casesShort: number;
  readonly basis: string;
}

export interface OutcomeCounts {
  answered: number;
  refused: number;
  unsupported: number;
  error: number;
  /** Not asked: the budget cap or an abort stopped before this call. Counted here, not under error. */
  incomplete: number;
}

export interface RunResult {
  readonly rows: readonly DecideRow[];
  readonly estimate: Estimate;
  readonly calls: number;
  readonly spentUsd: number;
  readonly stoppedByBudget: boolean;
  /** The caller went away or its deadline passed (RunDeps.signal), so the remaining calls were not made. */
  readonly stoppedByAbort: boolean;
  /** Set when the claude-cli transport made a call: its argv has no output cap, so the budget can be overshot by at most one call. */
  readonly budgetNote: string | null;
  readonly counts: Readonly<Record<ArmName, OutcomeCounts>>;
}

type ProviderArm = Exclude<ArmName, "rule">;

type PlannedArm =
  | { readonly arm: ProviderArm; readonly model: string; readonly price: PriceEntry }
  | { readonly arm: "rule"; readonly model: string; readonly rule: RuleArm };

interface Resolved {
  readonly cases: readonly Case[];
  readonly questions: readonly QuestionSpec[];
  readonly arms: readonly PlannedArm[];
  readonly runId: string;
  readonly promptVersion: string;
  readonly budgetUsd: number | undefined;
  readonly dryRun: boolean;
}

function resolveArms(arms: Arms | undefined): PlannedArm[] {
  const out: PlannedArm[] = [];
  if (arms?.jev ?? true) out.push({ arm: "jev", model: JEV_PIN, price: priceFor("jev", JEV_PIN) });
  if (arms?.decisions ?? false) out.push({ arm: "decisions", model: DECISIONS_MODEL, price: priceFor("decisions", DECISIONS_MODEL) });
  const llm = arms?.llm ?? DEFAULT_LLM;
  if (llm !== false) {
    const price = resolveLlmModel(llm);
    out.push({ arm: "llm", model: price.model, price });
  }
  const rule = arms?.rule ?? false;
  if (rule !== false) {
    if (rule.keywords.length === 0) throw new DecideError("rule needs at least one keyword");
    out.push({ arm: "rule", model: RULE_MODEL, rule });
  }
  if (out.length === 0) throw new DecideError("no arms selected");
  return out;
}

function resolve(req: DecideRequest): Resolved {
  checkQuestions(req.questions);
  checkCases(req.cases);
  const runId = req.options?.runId ?? DEFAULT_RUN_ID;
  const promptVersion = req.options?.promptVersion ?? DEFAULT_PROMPT_VERSION;
  if (!RUN_ID.test(runId)) throw new DecideError("runId must match [A-Za-z0-9_.-]{1,64}");
  if (!RUN_ID.test(promptVersion)) throw new DecideError("promptVersion must match [A-Za-z0-9_.-]{1,64}");
  const budgetUsd = req.options?.budgetUsd;
  if (budgetUsd !== undefined && !(Number.isFinite(budgetUsd) && budgetUsd >= 0)) throw new DecideError("budgetUsd must be a number >= 0");
  return { cases: req.cases, questions: req.questions, arms: resolveArms(req.arms), runId, promptVersion, budgetUsd, dryRun: req.options?.dryRun ?? false };
}

function providerBody(arm: ProviderArm, model: string, text: string, questions: readonly QuestionSpec[]): Record<string, unknown> {
  if (arm === "jev") return jevBody(text, questions);
  if (arm === "decisions") return decisionsBody(text, questions);
  return messagesBody(model, text, questions);
}

const CLI_BUDGET_NOTE = `claude-cli sets no output cap, so the ${LLM_MAX_TOKENS}-token output estimate does not bound it: the budget can be overshot by at most one call, then the run stops`;

/**
 * Upper-bound cost of one call: request bytes plus overhead as input tokens; max_tokens as output for the llm.
 * For the claude-cli transport the bound is not enforced (no output cap in its argv): the cap can be overshot by at
 * most one call, because the check runs before each call and spend is added after it.
 */
function estimateCall(arm: ProviderArm, price: PriceEntry, text: string, questions: readonly QuestionSpec[]): number {
  const bytes = new TextEncoder().encode(JSON.stringify(providerBody(arm, price.model, text, questions))).length;
  return callCost(price, bytes + ESTIMATE_OVERHEAD_TOKENS, arm === "llm" ? LLM_MAX_TOKENS : 0);
}

function estimateResolved(r: Resolved): Estimate {
  const arms = r.arms.map((a): ArmEstimate => {
    if (a.arm === "rule") return { arm: "rule", model: a.model, calls: 0, costUsd: 0, priceTableDate: null };
    let calls = 0;
    let costUsd = 0;
    for (const c of r.cases) {
      const text = caseText(c);
      if (text === null) continue;
      calls += 1;
      costUsd += estimateCall(a.arm, a.price, text, r.questions);
    }
    return { arm: a.arm, model: a.model, calls, costUsd, priceTableDate: PRICE_TABLE_DATE };
  });
  return {
    cases: r.cases.length,
    calls: arms.reduce((s, a) => s + a.calls, 0),
    costUsd: arms.reduce((s, a) => s + a.costUsd, 0),
    arms,
    priceTableDate: PRICE_TABLE_DATE,
    casesForVerdict: MIN_PAIRED,
    casesShort: Math.max(0, MIN_PAIRED - r.cases.length),
    basis: `upper bound: request bytes + ${ESTIMATE_OVERHEAD_TOKENS} tokens in, llm max_tokens ${LLM_MAX_TOKENS} out, prices of ${PRICE_TABLE_DATE}`,
  };
}

/** Dry-run price and call count. Makes no provider call; takes no keys. */
export function estimate(req: DecideRequest): Estimate {
  return estimateResolved(resolve(req));
}

function emptyCounts(): Record<ArmName, OutcomeCounts> {
  const zero = (): OutcomeCounts => ({ answered: 0, refused: 0, unsupported: 0, error: 0, incomplete: 0 });
  return { jev: zero(), decisions: zero(), llm: zero(), rule: zero() };
}

interface CallMeta {
  readonly costUsd: number | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly latencyMs: number | null;
  readonly http?: number;
  readonly transport?: LlmTransport;
  readonly costBasis?: string;
}

const NO_CALL: CallMeta = { costUsd: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0 };

const KEY_FIELD: Readonly<Record<ProviderArm, keyof ProviderKeys>> = { jev: "jev", decisions: "openai", llm: "anthropic" };

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function providerHttpReason(arm: ProviderArm, status: number): string {
  if (status === 429) return `${arm}: rate limited by the provider (HTTP 429)`;
  if (status >= 500) return `${arm}: provider server error (HTTP ${status})`;
  return `${arm}: provider returned HTTP ${status}`;
}

/** Run many cases. With options.dryRun it returns the estimate and makes no call. */
export async function run(req: DecideRequest, deps: RunDeps = {}): Promise<RunResult> {
  const r = resolve(req);
  const est = estimateResolved(r);
  const counts = emptyCounts();
  if (r.dryRun) return { rows: [], estimate: est, calls: 0, spentUsd: 0, stoppedByBudget: false, stoppedByAbort: false, budgetNote: null, counts };
  const signal = deps.signal;
  // A function, not a narrowed property: the signal can fire during any await.
  const aborted = (): boolean => signal?.aborted === true;
  let abortStopped = false;
  const keys = deps.keys ?? {};
  const doFetch: DecideFetch = deps.fetch ?? ((url, init) => fetch(url, { method: init.method, headers: { ...init.headers }, body: init.body, ...(init.signal !== undefined ? { signal: init.signal } : {}) }));
  const spawn = deps.spawn ?? bunSpawn;
  const which = deps.which ?? whichClaude;
  const transports = deps.llmTransports ?? LLM_TRANSPORTS;
  const now = deps.now ?? (() => performance.now());
  const rows: DecideRow[] = [];
  let calls = 0;
  let spentUsd = 0;
  let stopped = false;
  let usedCli = false;

  const emit = (c: Case, a: PlannedArm, results: readonly QuestionResult[], meta: CallMeta, budget = false): void => {
    const n = r.questions.length;
    r.questions.forEach((q, i) => {
      const res = results[i] ?? { outcome: "error", output: null, confidence: null, reason: "no result" };
      const evidence: Evidence = {
        shared_by: n,
        ...(res.reason !== undefined ? { reason: res.reason } : {}),
        ...(res.probabilities !== undefined ? { probabilities: res.probabilities } : {}),
        ...(res.score !== undefined ? { score: res.score } : {}),
        ...(res.probability !== undefined ? { probability: res.probability } : {}),
        ...(a.arm !== "rule" ? { call_cost_usd: meta.costUsd } : {}),
        ...(meta.http !== undefined ? { http: meta.http } : {}),
        ...(meta.transport !== undefined ? { transport: meta.transport } : {}),
        ...(meta.costBasis !== undefined ? { cost_basis: meta.costBasis } : {}),
      };
      const outcome: Outcome = res.outcome;
      const tally = counts[a.arm];
      if (budget) tally.incomplete += 1;
      else tally[outcome] += 1;
      rows.push({
        format_version: "jnj-record/1.2",
        run_id: r.runId,
        prompt_version: r.promptVersion,
        case_id: c.id,
        case_input: caseInputCell(c),
        question_id: q.name,
        question: questionText(q),
        answer_set: answerSet(q),
        answerer: a.arm,
        answerer_model: a.model,
        output: outcome === "answered" ? res.output : null,
        confidence: outcome === "answered" ? res.confidence : null,
        label: null,
        label_source: null,
        tokens_in: meta.tokensIn,
        tokens_out: meta.tokensOut,
        cost_usd: meta.costUsd === null ? null : meta.costUsd / n,
        latency_ms: meta.latencyMs,
        price_table_date: a.arm === "rule" ? null : PRICE_TABLE_DATE,
        outcome,
        evidence,
      });
    });
  };
  const all = (outcome: Outcome, reason: string): QuestionResult[] => r.questions.map(() => ({ outcome, output: null, confidence: null, reason }));

  for (const c of r.cases) {
    const text = caseText(c);
    for (const a of r.arms) {
      if (text === null) {
        emit(c, a, all("unsupported", `v1 reads text only; ${caseInputCell(c)}`), NO_CALL);
        continue;
      }
      if (a.arm === "rule") {
        emit(c, a, r.questions.map((q) => ruleAnswer(a.rule, text, q)), NO_CALL);
        continue;
      }
      const key = keys[KEY_FIELD[a.arm]];
      const hasKey = key !== undefined && key !== "";
      let transport: LlmTransport | null = null;
      let binary: string | null = null;
      if (a.arm === "llm") {
        for (const t of transports) {
          if (t === "messages-api" && hasKey) transport = t;
          else if (t === "claude-cli") {
            binary = which();
            if (binary !== null) transport = t;
          }
          if (transport !== null) break;
        }
        if (transport === null) {
          const why = transports.includes("claude-cli") ? " or a claude binary on PATH" : "";
          emit(c, a, all("error", `missing key: llm needs keys.anthropic${why}`), NO_CALL);
          continue;
        }
      } else if (!hasKey) {
        emit(c, a, all("error", `missing key: ${a.arm} needs keys.${KEY_FIELD[a.arm]}`), NO_CALL);
        continue;
      }
      if (aborted()) {
        abortStopped = true;
        emit(c, a, all("error", "aborted"), NO_CALL, true);
        continue;
      }
      const projected = estimateCall(a.arm, a.price, text, r.questions);
      if (stopped || (r.budgetUsd !== undefined && spentUsd + projected > r.budgetUsd)) {
        stopped = true;
        emit(c, a, all("error", "budget"), NO_CALL, true);
        continue;
      }
      const start = now();
      calls += 1;
      if (a.arm === "llm" && transport === "claude-cli" && binary !== null) {
        usedCli = true;
        let parsed;
        try {
          parsed = parseCli(await spawn(cliArgv(binary, a.model), llmPrompt(text, r.questions)), a.model, r.questions);
        } catch {
          parsed = null;
        }
        const latencyMs = Math.max(0, Math.round(now() - start));
        const costUsd = parsed?.costUsd ?? null;
        spentUsd += costUsd ?? projected;
        const meta: CallMeta = { costUsd, tokensIn: parsed?.tokensIn ?? null, tokensOut: parsed?.tokensOut ?? null, latencyMs, transport: "claude-cli", costBasis: CLI_COST_BASIS };
        emit(c, a, parsed?.results ?? all("error", "claude-cli failed to start"), meta);
        continue;
      }
      const body = providerBody(a.arm, a.model, text, r.questions);
      const url = a.arm === "jev" ? JEV_URL : a.arm === "decisions" ? DECISIONS_URL : MESSAGES_URL;
      const secret = key ?? "";
      const headers = a.arm === "jev" ? jevHeaders(secret) : a.arm === "decisions" ? decisionsHeaders(secret) : messagesHeaders(secret);
      let parsed: CallResult | null = null;
      let fetchError: unknown = null;
      try {
        const res = await doFetch(url, { method: "POST", headers, body: JSON.stringify(body), ...(signal !== undefined ? { signal } : {}) });
        const json = await readJson(res);
        parsed = a.arm === "jev" ? parseJev(res.status, json, body, r.questions) : a.arm === "decisions" ? parseDecisions(res.status, json, r.questions) : parseMessages(res.status, json, r.questions);
        if (res.status < 200 || res.status > 299) parsed = { ...parsed, results: all("error", providerHttpReason(a.arm, res.status)) };
      } catch (error) {
        fetchError = error;
        parsed = null;
      }
      const latencyMs = Math.max(0, Math.round(now() - start));
      if (parsed === null && aborted()) {
        // Aborted in flight: the provider may still bill it, so it counts against spend, but it has no answer.
        spentUsd += projected;
        abortStopped = true;
        emit(c, a, all("error", "aborted"), { costUsd: null, tokensIn: null, tokensOut: null, latencyMs, ...(a.arm === "llm" ? { transport: "messages-api" } : {}) }, true);
        continue;
      }
      if (parsed === null) {
        spentUsd += projected;
        const timedOut = fetchError instanceof Error && fetchError.name === "TimeoutError";
        emit(c, a, all("error", timedOut ? `${a.arm}: provider request timed out` : `${a.arm}: network error contacting provider`), { costUsd: null, tokensIn: null, tokensOut: null, latencyMs, ...(a.arm === "llm" ? { transport: "messages-api" } : {}) });
        continue;
      }
      const costUsd = parsed.tokensIn === null ? null : callCost(a.price, parsed.tokensIn, parsed.tokensOut ?? 0);
      spentUsd += costUsd ?? projected;
      emit(c, a, parsed.results, {
        costUsd, tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, latencyMs, http: parsed.http,
        ...(a.arm === "llm" ? { transport: "messages-api" } : {}),
      });
    }
  }
  return { rows, estimate: est, calls, spentUsd, stoppedByBudget: stopped, stoppedByAbort: abortStopped, budgetNote: usedCli ? CLI_BUDGET_NOTE : null, counts };
}

/** One case, the same questions and arms. */
export async function ask(req: AskRequest, deps: RunDeps = {}): Promise<RunResult> {
  return run({ cases: [req.case], questions: req.questions, ...(req.arms ? { arms: req.arms } : {}), ...(req.options ? { options: req.options } : {}) }, deps);
}
