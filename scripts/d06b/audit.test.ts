import type { DecideRow } from "../../src/decide/types.ts";
import { expect, test } from 'bun:test';
import { labelAudit, type Truth } from './audit.ts';
import type { Cv } from './funnel.ts';
import { QUESTIONS, STAGES } from './questions.ts';
const cvs: readonly Cv[] = Array.from({ length: 36 }, (_, i) => ({ id: `cv${i}`, fields: { summary: 'Fictional evidence', right_to_work: 'UK', notice_weeks: 13, years_experience: 4 } }));
// Static provenance oracles, never experiment approvals or human-label evidence.
const fixtureTruths = (cases: readonly Cv[], by: string): readonly Truth[] => cases.flatMap(cv => STAGES.flatMap(stage => QUESTIONS[stage].map(q => ({ caseId: cv.id, questionId: q.name, truth: q.type === 'noul' ? 'yes' : q.type === 'score' ? '2' : q.choices[0]?.name ?? '', source: 'human', by, at: '2026-10-09T10:00:00Z', blind: true, approvalRef: null }))));
const primary = fixtureTruths(cvs, 'fictional-primary'); const second = fixtureTruths(cvs.slice(0, 12), 'fictional-second'); const ids = cvs.slice(0, 12).map(c => c.id);
test('[unit] D06b audit requires exact 360 primary and 120 independent second labels', () => {
  const audit = labelAudit(cvs, primary, second, ids, null);
  expect(audit.primary).toBe(360); expect(audit.second).toBe(120);
  expect(audit.agreement).toHaveLength(10);
  expect(() => labelAudit(cvs, primary.slice(1), second, ids, null)).toThrow('coverage');
  expect(() => labelAudit(cvs, primary, fixtureTruths(cvs.slice(0, 12), 'fictional-primary'), ids, null)).toThrow('different person');
});
import { labelledCsv, replay } from './audit.ts';
import { collect } from './results.ts';
import { validate } from '../../src/format/validate.ts';
test('[integration] D06b CSV labels only answered results and preserves valid provenance', () => {
  const rows = collect([cvs[0] ?? { id: 'bad', fields: {} }], [], 'test-labels').rows;
  const csv = labelledCsv(rows, primary.filter(t => t.caseId === 'cv0'));
  const result = validate(csv);
  expect(result.errors).toEqual([]);
  expect(result.rows.filter(r => r.values.get('label_source') === 'human').length).toBe(4);
  expect(result.rows.filter(r => r.values.get('answerer') === 'jev' && r.values.get('label') !== null).length).toBe(0);
});
test('[unit] D06b replay reports missing required model answers and rule stops after S2', () => {
  const c: Cv = { id: 'only', fields: { right_to_work: 'UK', notice_weeks: 13, years_experience: 4, summary: 'pool dashboard budget shipped users' } };
  const rows = collect([c], [], 'test-replay').rows;
  expect(replay([c], rows, 'jev').complete).toBe(false);
  expect(replay([c], rows, 'rule')).toEqual({ complete: true, candidates: [{ caseId: 'only', score: null, evidence: 'pool dashboard budget shipped users' }], missing: [] });
});
test('[unit] D06b rejects agent labels and unapproved human-reviewed method deviations', () => {
  expect(() => labelAudit(cvs, primary.map(t => ({ ...t, source: 'agent' })), second, ids, null)).toThrow('not truth');
  const reviewed: readonly Truth[] = primary.map(t => ({ ...t, source: 'human_reviewed', blind: false, approvalRef: 'fixture-method' }));
  expect(() => labelAudit(cvs, reviewed, second, ids, null)).toThrow('approval');
  expect(labelAudit(cvs, reviewed, second, ids, 'fixture-method').primary).toBe(360);
  expect(() => labelAudit(cvs, primary.map(t => ({ ...t, by: 'email@example.invalid' })), second, ids, null)).toThrow('provenance');
});
test('[unit] D06b replay ranks raw scores, ties deterministically and never fabricates three survivors', () => {
  const c: Cv = { id: 'one', fields: { right_to_work: 'UK', notice_weeks: 13, years_experience: 4, summary: 'Fictional quoted evidence' } };
  const rows = collect([c], [], 'test-ranking').rows.filter(r => r.answerer === 'jev').map((r): DecideRow => ({ ...r, outcome: 'answered', output: r.question_id.startsWith('s2-') ? 'yes' : r.question_id === 's3-evidence-type' ? 'built-and-ran' : r.question_id === 's3-seniority' ? 'team lead' : '0', evidence: { shared_by: r.evidence.shared_by, probability: 0.9, score: 2.5 } }));
  expect(replay([c], rows, 'jev')).toEqual({ complete: true, candidates: [{ caseId: 'one', score: 2.5, evidence: 'Fictional quoted evidence' }], missing: [] });
});
test('[unit] D06b replay marks contradictory raw Noul evidence incomplete', () => {
  const c: Cv = { id: 'bad-probability', fields: { right_to_work: 'UK', notice_weeks: 1, years_experience: 4 } };
  const rows = collect([c], [], 'test-probability').rows.filter(r => r.answerer === 'jev').map((r): DecideRow => ({ ...r, outcome: 'answered', output: 'yes', evidence: { shared_by: 4, probability: 0.1 } }));
  expect(replay([c], rows, 'jev').complete).toBe(false);
});
