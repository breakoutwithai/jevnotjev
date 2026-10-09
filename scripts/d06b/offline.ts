// Offline-only command. No fetch, spawn, credential resolver or provider dispatch.
import { readFileSync } from 'node:fs';
import { plan, hash, requests, type Cv } from './funnel.ts';
import { collect, type Attempt } from './results.ts';
import { labelledCsv, replay, type Truth } from './audit.ts';
import { descriptive, stageStatus, noulUncertainty, attemptSpend } from './report.ts';
import { checkDescriptions, checkAttemptSpend } from './check.ts';
import { estimate, DEFAULT_LLM } from '../../src/decide/run.ts';
import { verdictOfText } from '../../src/decide/cli.ts';
function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
function read(path: string): unknown { const value: unknown = JSON.parse(readFileSync(path, 'utf8')); return value; }
function corpus(value: unknown): readonly Cv[] {
  if (!Array.isArray(value) || !value.length) throw new Error('corpus must be a nonempty array');
  return value.map((v: unknown) => { if (!record(v) || typeof v.id !== 'string' || !record(v.fields)) throw new Error('invalid CV'); return { id: v.id, fields: v.fields }; });
}
function attempts(value: unknown): readonly Attempt[] {
  if (!Array.isArray(value)) throw new Error('attempt ledger must be an array');
  return value.map((v: unknown) => {
    if (!record(v) || typeof v.id !== 'string' || typeof v.caseId !== 'string' || !['S2', 'S3', 'S4'].includes(String(v.stage)) || (v.arm !== 'jev' && v.arm !== 'llm') || typeof v.http !== 'number' || typeof v.stateHash !== 'string' || typeof v.questionHash !== 'string') throw new Error('invalid attempt');
    const stage = v.stage; if (stage !== 'S2' && stage !== 'S3' && stage !== 'S4') throw new Error('stage');
    return { id: v.id, caseId: v.caseId, stage, arm: v.arm, http: v.http, raw: v.raw, stateHash: v.stateHash, questionHash: v.questionHash };
  });
}
function truths(value: unknown): readonly Truth[] {
  if (!Array.isArray(value)) throw new Error('truths must be an array');
  return value.map((v: unknown) => {
    if (!record(v) || typeof v.caseId !== 'string' || typeof v.questionId !== 'string' || typeof v.truth !== 'string' || (v.source !== 'human' && v.source !== 'human_reviewed' && v.source !== 'agent') || typeof v.by !== 'string' || typeof v.at !== 'string' || typeof v.blind !== 'boolean' || (v.approvalRef !== null && typeof v.approvalRef !== 'string')) throw new Error('invalid truth; blank templates are not completed labels');
    return { caseId: v.caseId, questionId: v.questionId, truth: v.truth, source: v.source, by: v.by, at: v.at, blind: v.blind, approvalRef: v.approvalRef };
  });
}
export async function offline(args: readonly string[]): Promise<{ code: number; body: unknown }> {
  const [cmd, file, attemptFile, labelFile] = args;
  if ((cmd !== 'plan' && cmd !== 'report') || !file || (cmd === 'plan' ? args.length !== 2 : args.length !== 4 || !attemptFile || !labelFile)) throw new Error('Usage: bun scripts/d06b/offline.ts plan CORPUS | report CORPUS ATTEMPTS TRUTHS');
  const cvs = corpus(read(file)); const batches = plan(cvs);
  if (cmd === 'plan') {
    const estimates = batches.map(b => estimate({ cases: [{ id: b.caseId, input: b.state }], questions: b.questions, arms: { jev: true, llm: DEFAULT_LLM, decisions: false, rule: false }, options: { dryRun: true } }));
    const forecast = estimates.reduce((s,e) => s + e.costUsd, 0);
    return { code: 0, body: { status: 'proposed-offline-only', cases: cvs.length, batches: batches.length, logicalRequests: batches.length * 2, plannedSlots: cvs.length * 24, forecastUsd: forecast, forecastBasis: estimates[0]?.basis, caveat: 'List-price offline forecast, not measured usage, invoice or guaranteed monetary cap. Cache pricing and hidden provider overhead unverified. CLI output is unbounded; no CLI reservation guarantee.', calls: batches.flatMap(b => requests(b).map(r => ({ caseId: b.caseId, stage: b.stage, arm: r.arm, stateHash: hash(b.state), questionHash: hash(JSON.stringify(b.questions)), body: r.body }))) } };
  }
  if (!attemptFile || !labelFile) throw new Error('missing files');
  const collected = collect(cvs, attempts(read(attemptFile)), 'd06b-offline-import');
  const csv = labelledCsv(collected.rows, truths(read(labelFile)));
  const summary = descriptive(csv); const arithmetic = checkDescriptions(csv, summary);
  const spending = attemptSpend(collected.rows, collected.ledger);
  const spendingCheck = checkAttemptSpend(collected.rows, collected.ledger, spending);
  const verdict = await verdictOfText(csv, 'offline-import', undefined);
  return { code: arithmetic.mismatches || spendingCheck.mismatches ? 2 : verdict.code, body: { status: 'offline-import; authenticity and approvals require external evidence', csv, ledger: collected.ledger, descriptive: summary, descriptiveBasis: 'selected final-attempt row allocations; total incurred spend is separate', attemptSpend: spending, attemptSpendCheck: spendingCheck, arithmetic, noulUncertainty: noulUncertainty(collected.rows), stageStatus: stageStatus(verdict.body), core: verdict, replay: { jev: replay(cvs, collected.rows, 'jev'), llm: replay(cvs, collected.rows, 'llm'), rule: replay(cvs, collected.rows, 'rule') } } };
}
if (import.meta.main) {
  try { const r = await offline(process.argv.slice(2)); process.stdout.write(JSON.stringify(r.body, null, 2) + '\n'); process.exitCode = r.code; }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2; }
}
