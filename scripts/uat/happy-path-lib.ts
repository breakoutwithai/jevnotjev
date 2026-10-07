import type { Condition, VerdictName } from "../../src/core/verdict.ts";

export type Arm = "jev" | "llm" | "rule";
export interface OpeningNight { readonly arm: string; readonly verdict: VerdictName; readonly condition: Condition; readonly reason: string }
/** Parse #verdict innerText; reject hidden, rehearsal, invalid, and ambiguous verdicts. */
export function readOpeningNight(_text: string): OpeningNight | { readonly error: string } {
  return { error: "unparsed" };
}
export interface RecordProblem { readonly caseId: string; readonly problem: string }
/** Check exactly one unlabelled, valid output from every arm for every expected case. */
export function checkRecords(_csv: string, _caseIds: readonly string[], _arms: readonly Arm[]): readonly RecordProblem[] {
  return [];
}
/** Scan path names and raw bytes; report only relative paths and secret names. */
export function scanForSecrets(_dir: string, _secrets: ReadonlyMap<string, string>): readonly { readonly file: string; readonly name: string }[] {
  return [];
}
export interface ReportInput {
  readonly base: string;
  readonly version: string;
  readonly cloneSha: string | null;
  readonly csv: string;
  readonly caseIds: readonly string[];
  readonly verdictText: string;
  readonly steps: readonly { room: string; step: string; pass: boolean; detail: string; shot: string }[];
  readonly secretHits: readonly { file: string; name: string }[];
}
/** Render a report and refuse any failed step, record, verdict, or secret check. */
export function buildReport(_input: ReportInput): { readonly ok: boolean; readonly exitCode: 0 | 1; readonly markdown: string } {
  return { ok: true, exitCode: 0, markdown: "" };
}
/** Prepare New Scene fields for the UC13 shop bot. */
export function uc13Scene(_factSheet: string): { readonly question: string; readonly choiceA: string; readonly choiceB: string; readonly definitionA: string; readonly definitionB: string; readonly acceptance: string } {
  return { question: "", choiceA: "", choiceB: "", definitionA: "", definitionB: "", acceptance: "" };
}
/** RFC 4180 case_id,case_input CSV. */
export function casesCsv(_cases: readonly { case_id: string; case_input: string }[]): string {
  return "";
}
/** Extract comma-separated keyword terms from rule.md. */
export function ruleKeywords(_ruleMd: string): readonly string[] {
  return [];
}
