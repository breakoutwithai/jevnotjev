import { jevBody, parseJev } from "../../src/decide/jev.ts";
import { parseMessages } from "../../src/decide/llm.ts";
import { callCost, priceFor, PRICE_TABLE_DATE } from "../../src/decide/prices.ts";
import type { CallResult } from "../../src/decide/types.ts";
import { JEV_PIN } from "../../src/jev-answer.ts";
import { DEFAULT_LLM } from "../../src/decide/run.ts";
import { ruleAnswer, RULE_MODEL } from "../../src/decide/rule.ts";
import { answerNames, answerSet, questionText } from '../../src/decide/questions.ts';
import type { DecideRow, QuestionResult, QuestionSpec } from '../../src/decide/types.ts';
export function acceptance(q: QuestionSpec, arm: 'jev' | 'llm' | 'rule', result: QuestionResult, truth: string): { accepted: boolean | null; evaluation: number | null; uncertain: boolean | null } {
  if (!answerNames(q).includes(truth)) throw new Error('truth outside answer set');
  const missing = { accepted: null, evaluation: null, uncertain: null };
  if (result.outcome !== 'answered' || result.output === null || !answerNames(q).includes(result.output)) return missing;
  if (q.type === 'noul' && arm === 'jev') {
    const p = result.probability;
    if (p === undefined || !Number.isFinite(p) || p < 0 || p > 1 || result.output !== (p >= 0.5 ? 'yes' : 'no')) return missing;
    return { accepted: result.output === truth, evaluation: null, uncertain: p >= 0.15 && p <= 0.85 };
  }
  if (q.type === "score") {
    if (arm === "rule") throw new Error("rule only applies to S2");
    const value = arm === "jev" ? result.score : answerNames(q).indexOf(result.output);
    if (value === undefined || !Number.isFinite(value) || value < 0 || value > 3) return missing;
    const truthIndex = answerNames(q).indexOf(truth);
    return { accepted: Math.abs(value - truthIndex) <= 1, evaluation: value, uncertain: null };
  }
  return { accepted: result.output === truth, evaluation: null, uncertain: null };
}
import { plan, hash, type Cv } from './funnel.ts';
import { RULE_KEYWORDS, type Stage } from './questions.ts';
export interface Attempt { readonly id: string; readonly caseId: string; readonly stage: Stage; readonly arm: 'jev' | 'llm'; readonly http: number; readonly raw: unknown; readonly stateHash: string; readonly questionHash: string; }
export interface LedgerEntry extends Attempt { readonly tokensIn: number | null; readonly tokensOut: number | null; readonly costUsd: number | null; readonly selected: boolean; readonly outcomes: readonly string[]; readonly priceTableDate: string; readonly requestedModel: string; readonly responseModel: string | null; readonly transport: string; readonly cacheInputTokens: unknown; }
function record(value: unknown): value is Readonly<Record<string, unknown>> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function evidenceText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v: unknown) => evidenceText(v)).join(" ");
  if (record(value)) return Object.values(value).map(v => evidenceText(v)).join(" ");
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function collect(cvs: readonly Cv[], attempts: readonly Attempt[], runId: string): { rows: readonly DecideRow[]; ledger: readonly LedgerEntry[] } {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(runId)) throw new Error('invalid run ID');
  const batches = plan(cvs);
  const parsed = new Map<string, CallResult>();
  const costs = new Map<string, number | null>();
  const latest = new Map<string, Attempt>();
  const ids = new Set<string>();
  const key = (caseId: string, stage: Stage, arm: string): string => JSON.stringify([caseId, stage, arm]);
  for (const a of attempts) {
    if (ids.has(a.id) || !/^[A-Za-z0-9_.-]{1,64}$/.test(a.id)) throw new Error('duplicate or invalid attempt ID');
    ids.add(a.id);
    const batch = batches.find(b => b.caseId === a.caseId && b.stage === a.stage);
    if (!batch || !['jev', 'llm'].includes(a.arm)) throw new Error('attempt outside plan');
    if (a.questionHash !== hash(JSON.stringify(batch.questions))) throw new Error('attempt question hash mismatch');
    if (a.stateHash !== hash(batch.state)) throw new Error('attempt stage input hash mismatch');
    if (!Number.isInteger(a.http) || a.http < 0 || a.http > 599) throw new Error('invalid observed HTTP status');
    let result = a.arm === 'jev' ? parseJev(a.http, a.raw, jevBody(batch.state, batch.questions), batch.questions) : parseMessages(a.http, a.raw, batch.questions);
    if (a.arm === 'llm' && a.http >= 200 && a.http <= 299 && (!record(a.raw) || a.raw.model !== DEFAULT_LLM)) result = { ...result, results: batch.questions.map(() => ({ outcome: 'error', output: null, confidence: null, reason: 'response model differs from pinned model' })) };
    parsed.set(a.id, result);
    const usage = record(a.raw) && record(a.raw.usage) ? a.raw.usage : {};
    // The reused table does not price cache reads/writes. Unknown caching cost stays unknown.
    const cache = ['cache_creation_input_tokens', 'cache_read_input_tokens'].some(k => usage[k] !== undefined && usage[k] !== 0);
    const pinned = a.arm === 'jev' ? JEV_PIN : DEFAULT_LLM;
    const modelMatches = record(a.raw) && a.raw.model === pinned;
    const cost = result.tokensIn === null || result.tokensOut === null || cache || !modelMatches ? null : callCost(priceFor(a.arm, a.arm === 'jev' ? JEV_PIN : DEFAULT_LLM), result.tokensIn, result.tokensOut);
    costs.set(a.id, cost);
    latest.set(key(a.caseId, a.stage, a.arm), a);
  }
  const rows: DecideRow[] = [];
  for (const batch of batches) for (const arm of (batch.stage === 'S2' ? ['jev', 'llm', 'rule'] : ['jev', 'llm'])) {
    if (arm !== 'jev' && arm !== 'llm' && arm !== 'rule') throw new Error('arm');
    const a = latest.get(key(batch.caseId, batch.stage, arm));
    const call = a ? parsed.get(a.id) : undefined;
    const cost = a ? costs.get(a.id) ?? null : null;
    for (const [i, q] of batch.questions.entries()) {
      const local = arm === 'rule';
      const result: QuestionResult = local ? ruleAnswer({ keywords: RULE_KEYWORDS[q.name] ?? [], match: 'yes', otherwise: 'no' }, evidenceText(JSON.parse(batch.state)), { name: q.name, type: 'choice', instructions: q.instructions, choices: [{ name: 'yes', definition: 'keyword hit' }, { name: 'no', definition: 'no keyword hit' }] }) : call?.results[i] ?? { outcome: 'error', output: null, confidence: null, reason: 'not dispatched' };
      rows.push({ format_version: 'jnj-record/1.2', run_id: runId, prompt_version: 'd06b.proposal.v1', case_id: batch.caseId, case_input: batch.canonical, question_id: q.name, question: questionText(q), answer_set: answerSet(q), answerer: arm, answerer_model: arm === 'jev' ? JEV_PIN : local ? RULE_MODEL : DEFAULT_LLM,
        output: result.output, confidence: result.confidence, label: null, label_source: null, tokens_in: local ? 0 : call?.tokensIn ?? null, tokens_out: local ? 0 : call?.tokensOut ?? null, cost_usd: local ? 0 : cost === null ? null : cost / batch.questions.length, latency_ms: null, price_table_date: local ? null : a ? PRICE_TABLE_DATE : null, outcome: result.outcome,
        evidence: { shared_by: local ? 1 : batch.questions.length, ...(result.reason !== undefined ? { reason: result.reason } : {}), ...(result.probability !== undefined ? { probability: result.probability } : {}), ...(result.score !== undefined ? { score: result.score } : {}), ...(result.probabilities !== undefined ? { probabilities: result.probabilities } : {}), ...(!local ? { call_cost_usd: cost } : {}), ...(a ? { http: a.http } : {}), ...(arm === 'llm' && a ? { transport: 'messages-api' } : {}) },
      });
    }
  }
  const ledger = attempts.map((a): LedgerEntry => {
    const result = parsed.get(a.id); if (!result) throw new Error('missing parsed attempt');
    return { ...a, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: costs.get(a.id) ?? null, selected: latest.get(key(a.caseId, a.stage, a.arm))?.id === a.id, outcomes: result.results.map(r => r.outcome), priceTableDate: PRICE_TABLE_DATE, requestedModel: a.arm === 'jev' ? JEV_PIN : DEFAULT_LLM, responseModel: record(a.raw) && typeof a.raw.model === 'string' ? a.raw.model : null, transport: a.arm === 'jev' ? 'captured-systemone-http' : 'captured-messages-http', cacheInputTokens: record(a.raw) && record(a.raw.usage) ? { creation: a.raw.usage.cache_creation_input_tokens ?? null, read: a.raw.usage.cache_read_input_tokens ?? null } : null };
  });
  return { rows, ledger };
}
