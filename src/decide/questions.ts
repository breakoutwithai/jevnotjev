// Question and case checks, answer sets and the shared wording every arm is asked. Pure.
import { DecideError } from "./prices.ts";
import type { Case, QuestionSpec } from "./types.ts";

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
/** format/record-v1.schema.json case_input maxLength. */
export const MAX_CASE_CHARS = 8000;

/** The allowed answers in order: yes/no, the choice names, or the level labels low to high. */
export function answerNames(q: QuestionSpec): readonly string[] {
  if (q.type === "noul") return ["yes", "no"];
  if (q.type === "choice") return q.choices.map((c) => c.name);
  return q.levels.map((l) => l.label);
}

export function answerSet(q: QuestionSpec): string {
  return answerNames(q).join("|");
}

/** The question text recorded in the row and sent to every arm: instructions, plus a noul's criteria. */
export function questionText(q: QuestionSpec): string {
  return q.type === "noul" && q.criteria !== undefined && q.criteria !== "" ? `${q.instructions}\nCriteria: ${q.criteria}` : q.instructions;
}

function checkNames(q: QuestionSpec, names: readonly string[], what: string): void {
  if (names.length < MIN_OPTIONS || names.length > MAX_OPTIONS) {
    throw new DecideError(`question ${q.name}: ${what} must number 2 to 10, got ${names.length}`);
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (name.trim() === "") throw new DecideError(`question ${q.name}: empty ${what} name`);
    if (name.includes("|")) throw new DecideError(`question ${q.name}: ${what} name ${JSON.stringify(name)} holds |`);
    if (seen.has(name)) throw new DecideError(`question ${q.name}: duplicate ${what} name ${JSON.stringify(name)}`);
    seen.add(name);
  }
}

export function checkQuestions(questions: readonly QuestionSpec[]): void {
  if (questions.length === 0) throw new DecideError("no questions");
  const seen = new Set<string>();
  for (const q of questions) {
    if (!ID.test(q.name)) throw new DecideError(`question name ${JSON.stringify(q.name)} must match [A-Za-z0-9_-]{1,64}`);
    if (seen.has(q.name)) throw new DecideError(`duplicate question name ${q.name}`);
    seen.add(q.name);
    if (q.instructions.trim() === "") throw new DecideError(`question ${q.name}: empty instructions`);
    if (q.type === "choice") checkNames(q, q.choices.map((c) => c.name), "choices");
    else if (q.type === "score") checkNames(q, q.levels.map((l) => l.label), "levels");
  }
}

export function checkCases(cases: readonly Case[]): void {
  if (cases.length === 0) throw new DecideError("no cases");
  const seen = new Set<string>();
  for (const c of cases) {
    if (!ID.test(c.id)) throw new DecideError(`case id ${JSON.stringify(c.id)} must match [A-Za-z0-9_-]{1,64}`);
    if (seen.has(c.id)) throw new DecideError(`duplicate case id ${c.id}`);
    seen.add(c.id);
    if (typeof c.input === "string" && c.input.length === 0) throw new DecideError(`case ${c.id}: empty input`);
  }
}

const DATA_URI = /^data:[a-z]+\/[a-z0-9.+-]+;base64,/i;

/** The case's text, or null for a non-text input (an object, or a base64 data URI). */
export function caseText(c: Case): string | null {
  if (typeof c.input !== "string") return null;
  return DATA_URI.test(c.input) ? null : c.input;
}

/** What the row records as case_input: the text, or a marker naming the non-text kind. */
export function caseInputCell(c: Case): string {
  const text = caseText(c);
  if (text !== null) return text;
  const kind = typeof c.input === "string" ? "data uri" : c.input.type;
  return `[non-text input: ${kind}]`;
}
