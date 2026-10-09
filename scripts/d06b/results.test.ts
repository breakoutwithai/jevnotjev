import { hash, plan } from "./funnel.ts";
import { expect, test } from 'bun:test';
import { acceptance } from './results.ts';
import { QUESTIONS } from './questions.ts';
const s2 = QUESTIONS.S2[0]; const s4 = QUESTIONS.S4[0];
if (!s2 || !s4) throw new Error('fixture');
test('[unit] D06b raw probability and inclusive uncertainty are distinct from confidence', () => {
  expect(acceptance(s2, 'jev', { outcome: 'answered', output: 'no', confidence: 0.85, probability: 0.15 }, 'no')).toEqual({ accepted: true, evaluation: null, uncertain: true });
  expect(acceptance(s2, 'jev', { outcome: 'answered', output: 'yes', confidence: 0.5, probability: 0.5 }, 'yes').accepted).toBe(true);
  expect(acceptance(s2, 'jev', { outcome: 'answered', output: 'yes', confidence: 0.85, probability: 0.85 }, 'yes').uncertain).toBe(true);
  expect(acceptance(s2, 'llm', { outcome: 'answered', output: 'no', confidence: null }, 'no').uncertain).toBeNull();
});
test('[unit] D06b raw Score differs from mode and the one-level tolerance is inclusive', () => {
  expect(acceptance(s4, 'jev', { outcome: 'answered', output: '0', confidence: null, score: 1 }, '2')).toEqual({ accepted: true, evaluation: 1, uncertain: null });
  expect(acceptance(s4, 'jev', { outcome: 'answered', output: '0', confidence: null, score: 0.999 }, '2').accepted).toBe(false);
  expect(acceptance(s4, 'llm', { outcome: 'answered', output: '1', confidence: null }, '2').evaluation).toBe(1);
  expect(acceptance(s4, 'jev', { outcome: 'answered', output: '1', confidence: null }, '2').accepted).toBeNull();
  expect(acceptance(s4, 'jev', { outcome: 'error', output: null, confidence: null }, '2').accepted).toBeNull();
});
import { collect } from './results.ts';
import type { Cv } from './funnel.ts';
const cv: Cv = { id: 'cv01', fields: { summary: 'Fictional token pool dashboard shipped to users', right_to_work: 'UK', notice_weeks: 13, years_experience: 4, team_size_led: 4 } };
test('[integration] D06b coverage includes 864 slots with S2-only rule and explicit missing model outcomes', () => {
  const cvs = Array.from({ length: 36 }, (_, i) => ({ ...cv, id: `cv${i + 1}` }));
  const result = collect(cvs, [], 'test-coverage');
  expect(result.rows.length).toBe(864);
  expect(result.rows.filter(r => r.answerer === 'rule').length).toBe(144);
  expect(result.rows.filter(r => r.answerer === 'rule' && !r.question_id.startsWith('s2-')).length).toBe(0);
  expect(result.rows.filter(r => r.answerer === 'jev' && r.outcome === 'error').length).toBe(360);
});
import type { Attempt } from './results.ts';
const raw = { model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 0 }, answers: { 's2-a1': { type: 'noul', noul: 0.1 }, 's2-a2': { type: 'noul', noul: 0.9 }, 's2-a3': { type: 'noul', noul: 0.5 }, 's2-a4': { type: 'noul', noul: 1 } } };
const attempt: Attempt = { id: 'a1', caseId: 'cv01', stage: 'S2', arm: 'jev', http: 200, raw, stateHash: hash(plan([cv])[0]?.state ?? ""), questionHash: hash(JSON.stringify(QUESTIONS.S2)) };
test('[integration] D06b batched usage is ledgered once and allocated across four rows', () => {
  const result = collect([cv], [attempt], 'test-attempt');
  expect(result.ledger.length).toBe(1);
  const rows = result.rows.filter(r => r.answerer === 'jev' && r.question_id.startsWith('s2-'));
  expect(rows.map(r => r.output)).toEqual(['no', 'yes', 'yes', 'yes']);
  for (const row of rows) expect(row.cost_usd).toBeCloseTo(0.00000105, 12);
  expect(new Set(result.rows.map(r => r.case_input)).size).toBe(1);
});
test('[unit] D06b unknown failures and superseded attempts remain in the unique ledger', () => {
  const result = collect([cv], [{ ...attempt, id: 'failed', http: 0, raw: null }, attempt], 'test-retries');
  expect(result.ledger.map(a => a.selected)).toEqual([false, true]);
  expect(result.ledger[0]?.costUsd).toBeNull();
  expect(result.ledger[1]?.costUsd).toBeCloseTo(0.0000042, 12);
  expect(() => collect([cv], [attempt, attempt], 'test-duplicate')).toThrow('duplicate');
  expect(() => collect([cv], [{ ...attempt, stateHash: 'wrong' }], 'test-mismatch')).toThrow('hash mismatch');
});
test('[unit] D06b cached usage has unknown cost and wrong LLM model cannot count as answered', () => {
  const cached = collect([cv], [{ ...attempt, raw: { ...raw, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 1000 } } }], 'test-cache');
  expect(cached.ledger[0]?.costUsd).toBeNull();
  const wrong = collect([cv], [{ ...attempt, arm: 'llm', raw: { model: 'floating-alias', usage: { input_tokens: 100, output_tokens: 2 }, content: [{ type: 'text', text: '{"s2-a1":"yes"}' }] } }], 'test-pin');
  expect(wrong.rows.filter(r => r.answerer === 'llm' && r.outcome === 'answered')).toHaveLength(0);
});
test('[integration] D06b shared parser preserves raw weighted Score and mode separately', () => {
  const scoreRaw = { model: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 0 }, answers: Object.fromEntries(QUESTIONS.S4.map(q => [q.name, { type: 'score', score: 1.2, probabilities: { '0': 0.4, '1': 0.1, '2': 0.4, '3': 0.1 } }])) };
  const state = plan([cv]).find(b => b.stage === 'S4')?.state ?? '';
  const rows = collect([cv], [{ ...attempt, stage: 'S4', questionHash: hash(JSON.stringify(QUESTIONS.S4)), stateHash: hash(state), raw: scoreRaw }], 'test-score-shape').rows.filter(r => r.question_id.startsWith('s4-') && r.answerer === 'jev');
  expect(rows.map(r => r.output)).toEqual(['0', '0', '0', '0']);
  expect(rows.map(r => r.evidence.score)).toEqual([1.2, 1.2, 1.2, 1.2]);
  expect(acceptance(s4, 'jev', { outcome: rows[0]?.outcome ?? 'error', output: rows[0]?.output ?? null, confidence: null, ...rows[0]?.evidence }, '2').accepted).toBe(true);
});
test('[unit] D06b rule matches CV values rather than schema field names', () => {
  const rows = collect([{ id: 'empty', fields: { summary: 'No relevant experience', budget_owned: '', users_shipped_to: 0 } }], [], 'test-values').rows;
  expect(rows.filter(r => r.answerer === 'rule').map(r => r.output)).toEqual(['no', 'no', 'no', 'no']);
});
test('[unit] D06b captures with different question criteria are rejected', () => {
  expect(() => collect([cv], [{ ...attempt, questionHash: 'different-criteria' }], 'test-criteria')).toThrow('question hash');
});
