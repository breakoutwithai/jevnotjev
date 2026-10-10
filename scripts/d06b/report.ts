import { validate, truthLabel, type ParsedRow } from '../../src/format/validate.ts';
import { QUESTIONS, STAGES } from './questions.ts';
export interface Total { readonly key: string; readonly accepted: number; readonly spend: number | null; readonly cpa: number | null; readonly missingCosts: number; readonly labelled: number; readonly unlabelled: number; }
export interface Descriptive { readonly stage: readonly Total[]; readonly question: readonly Total[]; }
export function descriptive(csv: string): Descriptive {
  const validation = validate(csv);
  if (validation.errors.length) throw new Error('invalid records: ' + validation.errors.join('; '));
  if (new Set(validation.rows.map(r => JSON.stringify([r.values.get('run_id'), r.values.get('prompt_version')]))).size !== 1) throw new Error('descriptions require one run and prompt version');
  const known = new Set(STAGES.flatMap(s => QUESTIONS[s].map(q => q.name)));
  for (const r of validation.rows) {
    const id = r.values.get('question_id'); const arm = r.values.get('answerer');
    if (typeof id !== 'string' || !known.has(id) || !['jev', 'llm', 'rule'].includes(String(arm)) || (arm === 'rule' && !id.startsWith('s2-'))) throw new Error('row outside D06b scope');
  }
  const sum = (key: string, rows: readonly ParsedRow[]): Total => {
    let accepted = 0; let knownSpend = 0; let missingCosts = 0; let labelled = 0;
    for (const r of rows) {
      const truth = truthLabel(r.values); if (truth !== null) labelled++; if (truth === 'accept') accepted++;
      const cost = r.values.get('cost_usd'); if (typeof cost !== 'number') missingCosts++; else knownSpend += cost;
    }
    const spend = missingCosts ? null : knownSpend;
    return { key, accepted, spend, cpa: spend === null || accepted === 0 ? null : spend / accepted, missingCosts, labelled, unlabelled: rows.length - labelled };
  };
  return {
    stage: STAGES.flatMap(stage => (stage === 'S2' ? ['jev', 'llm', 'rule'] : ['jev', 'llm']).map(arm => sum(stage + '/' + arm, validation.rows.filter(r => QUESTIONS[stage].some(q => q.name === r.values.get('question_id')) && r.values.get('answerer') === arm)))),
    question: STAGES.flatMap(stage => QUESTIONS[stage].flatMap(q => (stage === 'S2' ? ['jev', 'llm', 'rule'] : ['jev', 'llm']).map(arm => sum(q.name + '/' + arm, validation.rows.filter(r => r.values.get('question_id') === q.name && r.values.get('answerer') === arm))))),
  };
}
export function stageStatus(core: unknown) {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(core) || !Array.isArray(core.verdicts)) throw new Error('missing core verdicts');
  const all: unknown[] = core.verdicts;
  return STAGES.map(stage => {
    const questions = QUESTIONS[stage].map(q => {
      const matches = all.filter(v => record(v) && v.question_id === q.name);
      if (matches.length !== 1) return { questionId: q.name, verdict: null, pairs: null };
      const v = matches[0]; if (!record(v) || !['use Jev', "don\u0027t use Jev", 'not enough evidence'].includes(String(v.verdict))) return { questionId: q.name, verdict: null, pairs: null };
      const comparison = record(v.numbers) && record(v.numbers.jevVsLlm) ? v.numbers.jevVsLlm : null;
      return { questionId: q.name, verdict: String(v.verdict), pairs: comparison && typeof comparison.n === 'number' ? comparison.n : null };
    });
    const names = new Set(questions.map(q => q.verdict));
    return { stage, status: names.size === 1 && !names.has(null) ? questions[0]?.verdict ?? 'incomplete' : 'mixed question verdicts', incomplete: questions.filter(q => q.pairs === null || q.pairs < 30).map(q => q.questionId), questions, scope: 'display only; no pooled stage statistical verdict' };
  });
}
import type { DecideRow } from '../../src/decide/types.ts';
export function noulUncertainty(rows: readonly DecideRow[]) {
  const cases = new Set(rows.map(r => r.case_id));
  const present = rows.filter(r => r.answerer === 'jev' && r.question_id.startsWith('s2-') && r.outcome === 'answered' && typeof r.evidence.probability === 'number' && Number.isFinite(r.evidence.probability) && r.evidence.probability >= 0 && r.evidence.probability <= 1);
  const uncertain = present.filter(r => (r.evidence.probability ?? -1) >= 0.15 && (r.evidence.probability ?? 2) <= 0.85);
  return { basis: 'Jev raw p only; inclusive [0.15,0.85]; no LLM probability equivalent', observedAnswers: present.length, uncertainAnswers: uncertain.length, candidatesWithAnyUncertainty: new Set(uncertain.map(r => r.case_id)).size, incompleteCandidates: [...cases].filter(id => new Set(present.filter(r => r.case_id === id).map(r => r.question_id)).size !== 4).length, questions: QUESTIONS.S2.map(q => ({ questionId: q.name, observed: present.filter(r => r.question_id === q.name).length, uncertain: uncertain.filter(r => r.question_id === q.name).length, missing: cases.size - present.filter(r => r.question_id === q.name).length })) };
}
import type { LedgerEntry } from './results.ts';
export function attemptSpend(rows: readonly DecideRow[], ledger: readonly LedgerEntry[]) {
  if (new Set(ledger.map(a => a.id)).size !== ledger.length) throw new Error('duplicate ledger attempt');
  const knownUsd = ledger.reduce((s,a) => s + (a.costUsd ?? 0), 0);
  const unknownAttempts = ledger.filter(a => a.costUsd === null).length;
  const selectedKnownUsd = ledger.filter(a => a.selected).reduce((s,a) => s + (a.costUsd ?? 0), 0);
  const supersededKnownUsd = ledger.filter(a => !a.selected).reduce((s,a) => s + (a.costUsd ?? 0), 0);
  const selectedRowKnownUsd = rows.filter(r => r.answerer !== 'rule').reduce((s,r) => s + (r.cost_usd ?? 0), 0);
  return { attempts: ledger.length, knownUsd, unknownAttempts, totalUsd: unknownAttempts ? null : knownUsd, selectedKnownUsd, supersededKnownUsd, supersededUnknownAttempts: ledger.filter(a => !a.selected && a.costUsd === null).length, selectedRowKnownUsd, allocationMismatch: Math.abs(selectedRowKnownUsd - selectedKnownUsd) > 1e-12 };
}
