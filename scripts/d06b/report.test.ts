import { expect, test } from 'bun:test';
import { descriptive } from './report.ts';
import { collect } from './results.ts';
import { labelledCsv } from './audit.ts';
const cv = { id: 'fixture', fields: { summary: 'pool dashboard budget shipped users' } };
test('[integration] D06b descriptions contain 21 stage and 72 question figures with missing costs explicit', () => {
  const result = descriptive(labelledCsv(collect([cv], [], 'test-descriptive').rows, []));
  expect(result.stage).toHaveLength(7); expect(result.question).toHaveLength(24);
  expect(result.stage.find(t => t.key === 'S2/rule')).toEqual({ key: 'S2/rule', accepted: 0, spend: 0, cpa: null, missingCosts: 0, labelled: 0, unlabelled: 4 });
  expect(result.stage.find(t => t.key === 'S2/jev')?.spend).toBeNull();
});
import { checkDescriptions } from './check.ts';
test('[unit] D06b independent descriptions detect a planted spend fault', () => {
  const csv = labelledCsv(collect([cv], [], 'test-check').rows, []);
  const report = descriptive(csv);
  expect(checkDescriptions(csv, report)).toEqual({ stageFigures: 21, questionFigures: 72, mismatches: 0 });
  const planted = { ...report, stage: report.stage.map(t => t.key === 'S2/rule' ? { ...t, spend: 1 } : t) };
  expect(checkDescriptions(csv, planted).mismatches).toBeGreaterThan(0);
});
import { stageStatus } from './report.ts';
test('[unit] D06b stage display names incomplete questions and never pools statistical verdicts', () => {
  const stages = stageStatus({ verdicts: [{ question_id: 's2-a1', verdict: 'use Jev', numbers: { jevVsLlm: { n: 36 } } }, { question_id: 's2-a2', verdict: "don't use Jev", numbers: { jevVsLlm: { n: 36 } } }] });
  expect(stages[0]?.status).toBe('mixed question verdicts');
  expect(stages[0]?.incomplete).toEqual(['s2-a3', 's2-a4']);
  expect(stages[1]?.incomplete).toEqual(['s3-evidence-type', 's3-seniority']);
});
import { noulUncertainty } from './report.ts';
test('[unit] D06b uncertainty counts raw-p answers and candidates with missing evidence explicit', () => {
  const rows = collect([cv], [], 'test-uncertainty').rows;
  const pending = noulUncertainty(rows);
  expect(pending.observedAnswers).toBe(0); expect(pending.incompleteCandidates).toBe(1);
  const answered = rows.map(r => r.answerer === 'jev' && r.question_id === 's2-a1' ? { ...r, outcome: 'answered', output: 'no', evidence: { shared_by: 4, probability: 0.15 } } : r);
  // Use the public row type to keep the fixture's outcome narrow.
  const typed: import('../../src/decide/types.ts').DecideRow[] = answered.map(r => ({ ...r, outcome: r.outcome === 'answered' ? 'answered' : 'error' }));
  const observed = noulUncertainty(typed);
  expect(observed.uncertainAnswers).toBe(1); expect(observed.candidatesWithAnyUncertainty).toBe(1); expect(observed.incompleteCandidates).toBe(1);
});
import { attemptSpend } from './report.ts';
import { checkAttemptSpend } from './check.ts';
import { hash, plan } from './funnel.ts';
import { QUESTIONS } from './questions.ts';
test('[unit] D06b full attempt spend reconciles known and unknown superseded calls separately', () => {
  const b = plan([cv])[0]; if (!b) throw new Error('fixture');
  const a = { id: 'first', caseId: cv.id, stage: b.stage, arm: 'jev', http: 200, stateHash: hash(b.state), questionHash: hash(JSON.stringify(b.questions)), raw: { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers: Object.fromEntries(QUESTIONS.S2.map(q => [q.name, { type: 'noul', noul: 0.9 }])) } };
  const valid: import('./results.ts').Attempt = { ...a, arm: 'jev' };
  const collected = collect([cv], [valid, { ...valid, id: 'second' }], 'test-spend');
  const spent = attemptSpend(collected.rows, collected.ledger);
  expect(spent.knownUsd).toBeCloseTo(0.0000084, 12); expect(spent.supersededKnownUsd).toBeCloseTo(0.0000042, 12);
  expect(checkAttemptSpend(collected.rows, collected.ledger, spent)).toEqual({ compared: 9, mismatches: 0 });
  const unknown = collect([cv], [{ ...valid, http: 0, raw: null }, { ...valid, id: 'second' }], 'test-unknown');
  const missing = attemptSpend(unknown.rows, unknown.ledger);
  expect(missing.totalUsd).toBeNull(); expect(missing.unknownAttempts).toBe(1); expect(missing.supersededUnknownAttempts).toBe(1);
  expect(checkAttemptSpend(unknown.rows, unknown.ledger, { ...missing, unknownAttempts: 0 }).mismatches).toBeGreaterThan(0);
});
