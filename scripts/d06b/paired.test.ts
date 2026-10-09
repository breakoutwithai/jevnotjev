// Static fictional integration oracle. No provider or real human is called.
import { expect, test } from 'bun:test';
import { plan, hash, type Cv } from './funnel.ts';
import { collect, type Attempt } from './results.ts';
import { labelledCsv, type Truth } from './audit.ts';
import { STAGES, QUESTIONS } from './questions.ts';
import { verdictOfText } from '../../src/decide/cli.ts';
import { compareWithApp } from '../math-check.ts';
import { descriptive } from './report.ts';
import { checkDescriptions } from './check.ts';
function record(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
test('[integration] D06b ten exact paired cohorts and independent core arithmetic on a 36-case fictional oracle', async () => {
  const cvs: readonly Cv[] = Array.from({ length: 36 }, (_, i) => ({ id: 'fixture' + i, fields: { summary: 'pool dashboard budget shipped users', right_to_work: 'UK', notice_weeks: 13, years_experience: 4 } }));
  const calls: readonly Attempt[] = plan(cvs).flatMap(b => ['jev', 'llm'].map((arm): Attempt => {
    if (arm !== 'jev' && arm !== 'llm') throw new Error('arm');
    const outputs = Object.fromEntries(b.questions.map(q => [q.name, q.type === 'noul' ? 'yes' : q.type === 'score' ? '2' : q.choices[0]?.name ?? '']));
    const answers = Object.fromEntries(b.questions.map(q => [q.name, q.type === 'noul' ? { type: 'noul', noul: 0.9 } : q.type === 'score' ? { type: 'score', score: 2 } : { type: 'choice', choice: q.choices[0]?.name }]));
    return { id: b.caseId + '-' + b.stage + '-' + arm, caseId: b.caseId, stage: b.stage, arm, http: 200, stateHash: hash(b.state), questionHash: hash(JSON.stringify(b.questions)), raw: arm === 'jev' ? { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers } : { model: 'claude-haiku-5-5', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: JSON.stringify(outputs) }] } };
  }));
  const truths: readonly Truth[] = cvs.flatMap(cv => STAGES.flatMap(stage => QUESTIONS[stage].map(q => ({ caseId: cv.id, questionId: q.name, truth: q.type === 'noul' ? 'yes' : q.type === 'score' ? '2' : q.choices[0]?.name ?? '', source: 'human', by: 'fictional-label-oracle', at: '2026-10-09', blind: true, approvalRef: null }))));
  const result = collect(cvs, calls, 'test-paired'); const csv = labelledCsv(result.rows, truths);
  expect(result.rows).toHaveLength(864); expect(result.ledger).toHaveLength(216);
  expect(result.ledger.reduce((sum, a) => sum + (a.tokensIn ?? 0), 0)).toBe(21600);
  const core = await verdictOfText(csv, 'fictional-oracle', undefined);
  expect(core.errors).toEqual([]); if (!record(core.body) || !Array.isArray(core.body.verdicts)) throw new Error('core');
  const observed: unknown[] = core.body.verdicts;
  expect(observed.map(v => record(v) ? v.question_id : null).sort()).toEqual(['s2-a1', 's2-a2', 's2-a3', 's2-a4', 's3-evidence-type', 's3-seniority', 's4-leadership', 's4-metering', 's4-ownership-scale', 's4-pooling-depth']);
  for (const v of observed) { if (!record(v) || !record(v.numbers) || !record(v.numbers.jevVsLlm)) throw new Error('paired figures'); expect(v.numbers.jevVsLlm.n).toBe(36); }
  expect(checkDescriptions(csv, descriptive(csv))).toEqual({ stageFigures: 21, questionFigures: 72, mismatches: 0 });
  const checked = compareWithApp(csv, core.body, 'fictional-oracle', { text: csv, n: 36, rule: 'all static fictional cases', cases: cvs.map(c => c.id) });
  expect(checked.compared).toBeGreaterThan(0); expect(checked.mismatches).toBe(0);
});
