import { jevBody } from '../../src/decide/jev.ts';
import { messagesBody } from '../../src/decide/llm.ts';
import { DEFAULT_LLM } from '../../src/decide/run.ts';
import { createHash } from 'node:crypto';
import { checkCases, checkQuestions, MAX_CASE_CHARS } from '../../src/decide/questions.ts';
import type { QuestionSpec } from '../../src/decide/types.ts';
import { ALLOWLISTS, EVIDENCE_FIELDS, ELIGIBILITY_FIELDS, IDENTITY_FIELDS, QUESTIONS, STAGES, type Stage } from './questions.ts';
export type { Stage };
export interface Cv { readonly id: string; readonly fields: Readonly<Record<string, unknown>>; }
export interface Batch { readonly caseId: string; readonly stage: Stage; readonly state: string; readonly canonical: string; readonly questions: readonly QuestionSpec[]; }
export function hash(text: string): string { return createHash('sha256').update(text).digest('hex'); }
const keyName = (k: string): string => k.toLowerCase().replace(/[^a-z]/g, '');
const denied = new Set([...IDENTITY_FIELDS, 'full_name', 'first_name', 'last_name', 'date_of_birth', 'email', 'phone', 'passport', 'national_id'].map(keyName));
const modelDenied = new Set([...denied, ...ELIGIBILITY_FIELDS.map(keyName)]);
function collect(value: unknown, identities: Set<string>, insideIdentity = false): void {
  if (insideIdentity && (typeof value === 'string' || typeof value === 'number') && String(value) !== '') identities.add(String(value));
  if (Array.isArray(value)) { for (const item of value) collect(item, identities, insideIdentity); }
  else if (typeof value === 'object' && value !== null) for (const [key, item] of Object.entries(value)) collect(item, identities, insideIdentity || denied.has(keyName(key)));
}
function privateText(text: string, identities: ReadonlySet<string>): boolean {
  if (/IDENTITY_[A-Z_0-9]+/i.test(text)) return true;
  return [...identities].some(v => {
    if (v.length >= 4 && !/^-?\d+(\.\d+)?$/.test(v)) return text.toLowerCase().includes(v.toLowerCase());
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(text);
  });
}
function clean(value: unknown, identities: ReadonlySet<string>, forbidden: ReadonlySet<string> = denied): unknown {
  if (typeof value === 'string') { if (privateText(value, identities)) throw new Error('identity value in allowed evidence'); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) { if (identities.has(String(value))) throw new Error('numeric identity value in allowed evidence'); return value; }
  if (Array.isArray(value)) return value.map(v => clean(v, identities, forbidden));
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).filter(([k]) => !forbidden.has(keyName(k))).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => { if (privateText(k, identities)) throw new Error('identity value in evidence key'); return [k, clean(v, identities, forbidden)]; }));
  throw new Error('CV evidence must contain JSON values');
}
export function plan(cvs: readonly Cv[]): readonly Batch[] {
  checkCases(cvs.map(cv => ({ id: cv.id, input: JSON.stringify(cv.fields) })));
  return cvs.flatMap(cv => {
    const identities = new Set<string>(); collect(cv.fields, identities);
    const stripped = Object.fromEntries([...ELIGIBILITY_FIELDS, ...EVIDENCE_FIELDS].filter(k => Object.hasOwn(cv.fields, k)).map(k => [k, clean(cv.fields[k], identities)]));
    const canonical = JSON.stringify(stripped);
    if ([...canonical].length > MAX_CASE_CHARS) throw new Error('canonical CV exceeds record limit');
    return STAGES.map(stage => {
      const questions = QUESTIONS[stage]; checkQuestions(questions);
      const state = JSON.stringify(Object.fromEntries(ALLOWLISTS[stage].filter(k => Object.hasOwn(stripped, k)).map(k => [k, clean(stripped[k], new Set<string>(), modelDenied)])));
      return { caseId: cv.id, stage, state, canonical, questions };
    });
  });
}
export function requests(batch: Batch): readonly { arm: 'jev' | 'llm'; body: Readonly<Record<string, unknown>> }[] {
  const fields: unknown = JSON.parse(batch.canonical);
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) throw new Error('invalid canonical CV');
  const verified = plan([{ id: batch.caseId, fields: Object.fromEntries(Object.entries(fields)) }]).find(b => b.stage === batch.stage);
  if (!verified || verified.canonical !== batch.canonical || verified.state !== batch.state || JSON.stringify(verified.questions) !== JSON.stringify(batch.questions)) throw new Error('batch differs from isolated proposal');
  return [{ arm: 'jev', body: jevBody(batch.state, batch.questions) }, { arm: 'llm', body: messagesBody(DEFAULT_LLM, batch.state, batch.questions) }];
}
