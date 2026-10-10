// Independent descriptive arithmetic: a separate CSV parser and literal prompt inventory.
// Runtime imports do not include the production aggregator or its question registry.
import { parseCsv } from '../math-check.ts';
import type { Descriptive, Total } from './report.ts';
const ids: Readonly<Record<string, readonly string[]>> = { S2: ['s2-a1', 's2-a2', 's2-a3', 's2-a4'], S3: ['s3-evidence-type', 's3-seniority'], S4: ['s4-pooling-depth', 's4-metering', 's4-ownership-scale', 's4-leadership'] };
export function checkDescriptions(csv: string, observed: Descriptive) {
  const [header, ...records] = parseCsv(csv); if (!header) throw new Error('missing header');
  const cell = (r: readonly string[], name: string): string => { const i = header.indexOf(name); if (i < 0) throw new Error('missing ' + name); return r[i] ?? ''; };
  let mismatches = 0; let stageFigures = 0; let questionFigures = 0;
  const same = (x: number | null, y: number | null): boolean => x === null || y === null ? x === y : Number.isFinite(y) && Math.abs(x - y) <= Math.max(1e-15, Math.abs(x) * 1e-9);
  const compare = (key: string, questions: readonly string[], arm: string, totals: readonly Total[]): void => {
    const rows = records.filter(r => questions.includes(cell(r, 'question_id')) && cell(r, 'answerer') === arm);
    const found = totals.filter(t => t.key === key);
    if (found.length !== 1) { mismatches++; return; }
    const actual = found[0]; if (!actual) throw new Error('total');
    let cost = 0; let unknown = 0; let accepted = 0; let labelled = 0;
    for (const row of rows) {
      const amount = cell(row, 'cost_usd'); if (amount === '') unknown++; else { const n = Number(amount); if (!Number.isFinite(n) || n < 0) throw new Error('invalid hand cost'); cost += n; }
      const label = cell(row, 'label'); if (cell(row, 'label_source') !== 'agent' && label !== '') { labelled++; if (label === 'accept') accepted++; }
    }
    const spend = unknown ? null : cost; const cpa = unknown || !accepted ? null : cost / accepted;
    if (!same(accepted, actual.accepted)) mismatches++;
    if (!same(spend, actual.spend)) mismatches++;
    if (!same(cpa, actual.cpa)) mismatches++;
    if (actual.missingCosts !== unknown || actual.labelled !== labelled || actual.unlabelled !== rows.length - labelled) mismatches++;
  };
  for (const [stage, questions] of Object.entries(ids)) for (const arm of (stage === 'S2' ? ['jev', 'llm', 'rule'] : ['jev', 'llm'])) {
    compare(stage + '/' + arm, questions, arm, observed.stage); stageFigures += 3;
    for (const id of questions) { compare(id + '/' + arm, [id], arm, observed.question); questionFigures += 3; }
  }
  if (observed.stage.length !== 7 || observed.question.length !== 24) mismatches++;
  return { stageFigures, questionFigures, mismatches };
}
import type { DecideRow } from '../../src/decide/types.ts';
import type { LedgerEntry } from './results.ts';
import type { attemptSpend } from './report.ts';
export function checkAttemptSpend(rows: readonly DecideRow[], ledger: readonly LedgerEntry[], observed: ReturnType<typeof attemptSpend>) {
  let all = 0; let selected = 0; let earlier = 0; let unknown = 0; let earlierUnknown = 0; let allocated = 0;
  for (const a of ledger) { if (a.costUsd === null) { unknown++; if (!a.selected) earlierUnknown++; } else { all += a.costUsd; if (a.selected) selected += a.costUsd; else earlier += a.costUsd; } }
  for (const r of rows) if (r.answerer !== 'rule' && r.cost_usd !== null) allocated += r.cost_usd;
  const expected = [ledger.length, all, unknown, unknown ? null : all, selected, earlier, earlierUnknown, allocated];
  const actual = [observed.attempts, observed.knownUsd, observed.unknownAttempts, observed.totalUsd, observed.selectedKnownUsd, observed.supersededKnownUsd, observed.supersededUnknownAttempts, observed.selectedRowKnownUsd];
  let mismatches = new Set(ledger.map(a => a.id)).size === ledger.length ? 0 : 1;
  for (let i = 0; i < expected.length; i++) { const a = expected[i]; const b = actual[i]; if (a === null || b === null) { if (a !== b) mismatches++; } else if (a === undefined || b === undefined || Math.abs(a-b) > 1e-12) mismatches++; }
  const allocationMismatch = Math.abs(allocated-selected) > 1e-12;
  if (allocationMismatch || observed.allocationMismatch !== allocationMismatch) mismatches++;
  return { compared: 9, mismatches };
}
