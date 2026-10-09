import { rowsToCsv } from "../../src/decide/rows.ts";
import { readDictRows, formatRows } from "../../src/format/csv.ts";
import { acceptance } from "./results.ts";
import { QUESTIONS, STAGES } from "./questions.ts";
import { answerNames } from "../../src/decide/questions.ts";
import { LABELLER_HANDLE, LABELLED_AT, isCalendarDate } from "../../src/format/validate.ts";
import { plan, type Cv } from './funnel.ts';
import type { DecideRow } from '../../src/decide/types.ts';
export interface Truth { readonly caseId: string; readonly questionId: string; readonly truth: string; readonly source: 'human' | 'human_reviewed' | 'agent'; readonly by: string; readonly at: string; readonly blind: boolean; readonly approvalRef: string | null; }
function checked(cvs: readonly Cv[], truths: readonly Truth[], deviationApproval: string | null): Map<string, Truth> {
  const expected = new Set(cvs.flatMap(c => STAGES.flatMap(stage => QUESTIONS[stage].map(q => JSON.stringify([c.id, q.name])))));
  const map = new Map<string, Truth>();
  for (const t of truths) {
    const key = JSON.stringify([t.caseId, t.questionId]);
    const q = STAGES.flatMap(stage => QUESTIONS[stage]).find(q => q.name === t.questionId);
    if (!q || !expected.has(key) || map.has(key)) throw new Error("label coverage mismatch");
    if (!answerNames(q).includes(t.truth)) throw new Error("truth outside answer set");
    if (t.source === "agent") throw new Error("agent label is not truth");
    if (t.source === "human" && !t.blind) throw new Error("human primary/second labels must be blind");
    if (t.source === "human_reviewed" && (t.blind || !deviationApproval || t.approvalRef !== deviationApproval)) throw new Error("human_reviewed method needs actual matching approval");
    if (!LABELLER_HANDLE.test(t.by) || /[\r\n]/.test(t.by) || !LABELLED_AT.test(t.at) || !isCalendarDate(t.at.slice(0,10)) || /[\r\n]/.test(t.at)) throw new Error("invalid label provenance");
    map.set(key, t);
  }
  if (map.size !== expected.size) throw new Error("label coverage incomplete");
  return map;
}
export function labelAudit(cvs: readonly Cv[], primary: readonly Truth[], second: readonly Truth[], secondIds: readonly string[], deviationApproval: string | null) {
  if (cvs.length !== 36 || secondIds.length !== 12 || new Set(secondIds).size !== 12) throw new Error("label coverage requires 36/12 cases");
  plan(cvs);
  const p = checked(cvs, primary, deviationApproval);
  const subset = secondIds.map(id => { const c = cvs.find(c => c.id === id); if (!c) throw new Error("second label coverage outside corpus"); return c; });
  const s = checked(subset, second, null);
  const agreement = STAGES.flatMap(stage => QUESTIONS[stage]).map(q => {
    let same = 0;
    for (const id of secondIds) {
      const key = JSON.stringify([id, q.name]); const a = p.get(key); const b = s.get(key);
      if (!a || !b) throw new Error("label coverage incomplete");
      if (a.by === b.by) throw new Error("second labels need a different person");
      if (a.truth === b.truth) same++;
    }
    return { questionId: q.name, matched: same, total: 12 };
  });
  return { primary: p.size, second: s.size, agreement };
}
export function labelledCsv(rows: readonly DecideRow[], truths: readonly Truth[], deviationApproval: string | null = null): string {
  const cvs = [...new Set(rows.map(r => r.case_id))].map(id => ({ id, fields: {} }));
  const labels = truths.length === 0 ? new Map<string, Truth>() : checked(cvs, truths, deviationApproval);
  const csv = readDictRows(rowsToCsv(rows)); const header = csv.header;
  if (!header) throw new Error("missing CSV header");
  const cells = csv.rows.map((record, i) => {
    const row = rows[i]; if (!row) throw new Error("row");
    const t = labels.get(JSON.stringify([row.case_id, row.question_id]));
    const q = STAGES.flatMap(stage => QUESTIONS[stage]).find(q => q.name === row.question_id);
    const fields = [...record.fields];
    if (!t || !q || row.answerer === "decisions") return fields;
    const accepted = acceptance(q, row.answerer, { outcome: row.outcome, output: row.output, confidence: row.confidence, ...row.evidence }, t.truth).accepted;
    if (accepted === null) return fields;
    const values: Readonly<Record<string, string>> = { label: accepted ? "accept" : "reject", label_source: t.source, labelled_by: t.by, labelled_at: t.at, label_blind: String(t.blind) };
    for (const [key, value] of Object.entries(values)) { const index = header.indexOf(key); if (index < 0) throw new Error("missing provenance column"); fields[index] = value; }
    return fields;
  });
  return formatRows([header, ...cells]);
}
export function replay(cvs: readonly Cv[], rows: readonly DecideRow[], arm: "jev" | "llm" | "rule") {
  plan(cvs); // Validate identity safety before evidence is quoted.
  const missing: string[] = [];
  const candidates: { caseId: string; score: number | null; evidence: string }[] = [];
  for (const cv of cvs) {
    const f = cv.fields;
    if (f.right_to_work !== "UK" || typeof f.notice_weeks !== "number" || f.notice_weeks < 0 || f.notice_weeks > 13 || typeof f.years_experience !== "number" || f.years_experience < 4 || !Number.isFinite(f.years_experience)) continue;
    const mine = rows.filter(r => r.case_id === cv.id && r.answerer === arm);
    if (new Set(mine.map(r => r.question_id)).size !== mine.length) throw new Error("duplicate replay row");
    const at = (id: string): DecideRow | null => {
      const row = mine.find(r => r.question_id === id);
      if (!row || row.outcome !== "answered" || row.output === null) { missing.push(cv.id + ":" + id); return null; }
      const q = STAGES.flatMap(s => QUESTIONS[s]).find(q => q.name === id);
      const truth = q ? answerNames(q)[0] : undefined;
      if (!q || truth === undefined || acceptance(q, arm, { outcome: row.outcome, output: row.output, confidence: row.confidence, ...row.evidence }, truth).accepted === null) { missing.push(cv.id + ":" + id + ":evidence"); return null; }
      return row;
    };
    const s2 = QUESTIONS.S2.map(q => at(q.name));
    if (s2.some(r => !r) || s2.some(r => r?.output !== "yes")) continue;
    const evidence = typeof f.summary === "string" ? f.summary : "";
    if (arm === "rule") { candidates.push({ caseId: cv.id, score: null, evidence }); continue; }
    const s3 = QUESTIONS.S3.map(q => at(q.name));
    if (s3.some(r => !r) || !["built-and-ran", "contributed"].includes(s3[0]?.output ?? "") || !["team lead", "head-of", "exec"].includes(s3[1]?.output ?? "")) continue;
    const s4 = QUESTIONS.S4.map(q => {
      const r = at(q.name); if (!r) return null;
      const evaluation = acceptance(q, arm, { outcome: r.outcome, output: r.output, confidence: r.confidence, ...r.evidence }, "0").evaluation;
      if (evaluation === null) missing.push(cv.id + ":" + q.name + ":evaluation");
      return evaluation;
    });
    if (s4.some(v => v === null)) continue;
    candidates.push({ caseId: cv.id, score: s4.reduce<number>((sum, v) => sum + (v ?? 0) * 0.25, 0), evidence });
  }
  candidates.sort((a,b) => (b.score ?? 0) - (a.score ?? 0) || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  return { complete: missing.length === 0, candidates: arm === "rule" ? candidates : candidates.slice(0,3), missing };
}
