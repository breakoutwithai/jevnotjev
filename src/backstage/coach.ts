export const COACH_PROMPT_VERSION = "coach.2";
export const CASES_PROMPT_VERSION = "cases.1";
export const COACH_REPLY_ERROR = "Could not read that reply. Nothing was changed.";
export const COACH_UNSAFE_MESSAGE = "A provider key appears in the scene. Remove it before running.";

export interface CoachAnswer { readonly name: string; readonly meaning: string }
interface DraftBase {
  readonly question: string;
  readonly keepRule: string;
  readonly ruleToBeat: readonly string[];
  readonly exclusions: string;
  readonly cases: readonly string[];
}
export type CoachDraft = DraftBase & (
  { readonly type: "choice"; readonly answers: readonly CoachAnswer[] } |
  { readonly type: "score"; readonly levels: readonly CoachAnswer[] } |
  { readonly type: "noul"; readonly statement: string; readonly answers: readonly CoachAnswer[] }
);
export type CoachReply = { readonly ok: true; readonly drafts: readonly CoachDraft[] } |
  { readonly ok: false; readonly reason: string };

export function coachPrompt(question: string): string {
  return `Prompt version: ${COACH_PROMPT_VERSION}\nYou are drafting Jev question shapes for a tester. Their plain-language question is:\n${JSON.stringify(question)}\n\nReturn JSON only, no commentary or Markdown. Schema: {"drafts":[{"type":"choice","question":"...","answers":[{"name":"...","meaning":"..."},{"name":"...","meaning":"..."}],"keepRule":"...","ruleToBeat":["keyword"],"exclusions":"...","cases":["synthetic one-line input"]}]}. Give 1 to 3 distinct drafts. The first draft must be a choice with exactly two answers so the tester can apply it today. A choice has 2 to 8 answers. You may also suggest a score with "levels" using the same name/meaning objects, or a noul with a true/false "statement" and exactly two "answers" named True and False, each with a meaning. Every draft needs question, keepRule, ruleToBeat, exclusions and 10 synthetic one-line cases. Mix clear first-answer, clear second-answer, borderline and no-match cases where the shape has one. Cases must be distinct, at most 8000 characters each, with no newlines, names, emails, account numbers or other personal data. Keep one decision per question. Name choice answers as actions. Each answer's meaning must say when it applies. Include a no-match answer when inputs can fall outside the named actions. Phrase the keep rule as the tester's own call. ruleToBeat: literal keywords that, if found in a case, select the FIRST answer; otherwise the second. Use an empty string for exclusions when nothing is left out. Keep question and meaning at most 1000 characters, answer names and keywords at most 64, keepRule and exclusions at most 2000, and ruleToBeat at most 20 literals. Only a choice with exactly two answers can be applied in Backstage today.`;
}

export interface CasesScene { readonly question: string; readonly choices: readonly { readonly name: string; readonly definition: string }[] }
export function casesPrompt(scene: CasesScene): string {
  return `Prompt version: ${CASES_PROMPT_VERSION}\nDraft 10 synthetic one-line test cases for this decision: ${JSON.stringify(scene)}\nReturn JSON only: {"cases":["one-line input"]}. Give 5 to 10 distinct cases, mixing clear first-answer, clear second-answer, borderline and no-match inputs where the shape has one. Each case must be at most 8000 characters, with no newlines, names, emails, account numbers or other personal data.`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum &&
    (allowEmpty || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
}
function answer(value: unknown): value is CoachAnswer {
  return record(value) && bounded(value.name, 64) && value.name === value.name.trim() &&
    !/[|\u0000-\u001f\u007f]/.test(value.name) && bounded(value.meaning, 1000);
}
export function validCases(value: unknown): value is string[] {
  return Array.isArray(value) && value.length >= 5 && value.length <= 10 &&
    value.every((item: unknown) => bounded(item, 8000) && !/[\r\n]/.test(item) &&
      !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(item) && !/\b\d{8,}\b/.test(item)) &&
    new Set(value).size === value.length;
}
export function parseCasesReply(text: string): { readonly ok: true; readonly cases: readonly string[] } | { readonly ok: false; readonly reason: string } {
  const trimmed = text.trim();
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fenced ? fenced[1] : trimmed;
  if (!source || source.length > 82000 || (trimmed.startsWith("```") && !fenced)) return { ok: false, reason: COACH_REPLY_ERROR };
  try {
    const parsed: unknown = JSON.parse(source);
    if (!record(parsed) || !validCases(parsed.cases)) return { ok: false, reason: COACH_REPLY_ERROR };
    return { ok: true, cases: parsed.cases };
  } catch { return { ok: false, reason: COACH_REPLY_ERROR }; }
}
function draft(value: unknown): value is CoachDraft {
  if (!record(value) || !validCases(value.cases) || !bounded(value.question, 1000) || !bounded(value.keepRule, 2000) ||
      !bounded(value.exclusions, 2000, true) || !Array.isArray(value.ruleToBeat) ||
      value.ruleToBeat.length < 1 || value.ruleToBeat.length > 20 ||
      !value.ruleToBeat.every((item: unknown) => bounded(item, 64) && item === item.trim() && !/[\r\n]/.test(item))) return false;
  if (value.type === "choice" || value.type === "score") {
    const list: unknown = value.type === "choice" ? value.answers : value.levels;
    return Array.isArray(list) && list.length >= 2 && list.length <= 8 &&
      list.every(answer) && new Set(list.map((item: CoachAnswer) => item.name)).size === list.length;
  }
  return value.type === "noul" && bounded(value.statement, 1000) &&
    Array.isArray(value.answers) && value.answers.length === 2 && value.answers.every(answer) &&
    value.answers[0]?.name === "True" && value.answers[1]?.name === "False";
}

export function parseCoachReply(text: string): CoachReply {
  const trimmed = text.trim();
  const fenced = /^```json\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const source = fenced ? fenced[1] : trimmed;
  if (!source || source.length > 262144 || (trimmed.startsWith("```") && !fenced))
    return { ok: false, reason: COACH_REPLY_ERROR };
  try {
    const parsed: unknown = JSON.parse(source);
    if (!record(parsed) || !Array.isArray(parsed.drafts) || parsed.drafts.length < 1 ||
        parsed.drafts.length > 3 || !parsed.drafts.every(draft))
      return { ok: false, reason: COACH_REPLY_ERROR };
    return { ok: true, drafts: parsed.drafts };
  } catch {
    return { ok: false, reason: COACH_REPLY_ERROR };
  }
}

export function applicableDraft(value: CoachDraft): Record<string, string> | null {
  if (value.type !== "choice" || value.answers.length !== 2) return null;
  const first = value.answers[0];
  const second = value.answers[1];
  if (!first || !second) return null;
  return {
    question: value.question,
    "choice-a": first.name,
    "choice-b": second.name,
    "definition-a": first.meaning,
    "definition-b": second.meaning,
    acceptance: value.keepRule,
    exclusions: value.exclusions,
    keywords: value.ruleToBeat.join("\n"),
  };
}
