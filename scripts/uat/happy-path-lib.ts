import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readDictRows, formatRows } from "../../src/format/csv.ts";
import { validate } from "../../src/format/validate.ts";
import { CRITERIA, QUESTION } from "../uc13/arms.ts";
import type { Condition, VerdictName } from "../../src/core/verdict.ts";

export type Arm = "jev" | "llm" | "rule";
export interface OpeningNight { readonly arm: string; readonly verdict: VerdictName; readonly condition: Condition; readonly reason: string }
const reasons: Record<Condition, RegExp> = {
  "no-jev-rows": /no Jev results/,
  "no-llm-rows": /no LLM results/,
  "too-few-paired": /paired Jev and LLM cases, fewer than/,
  "both-zero-accepted": /both have 0 accepted/,
  "cost-missing": /cost missing on a paired/,
  "no-cost-ratio": /both cost \$0 per accepted answer.*no cost ratio/,
  "cost-not-finite": /costs too large|cost ratio is too large/,
  "rule-within-margin": /rule is within 10 points/,
  "jev-clearly-worse": /Jev is clearly worse/,
  "jev-zero-accepted": /Jev has 0 accepted/,
  "jev-clearly-dearer": /Jev is clearly dearer/,
  "use-jev": /Jev is within 10 points/,
  "accept-rate-not-shown": /Jev is not shown within 10 points/,
  "cheaper-by-less-than-20": /cheaper, but by less than 20%/,
  "not-cheaper": /Jev is not cheaper/,
  "cost-upper-bound-not-below-1": /upper bound .* is not below 1/,
};
const verdicts: readonly VerdictName[] = ["use Jev", "don't use Jev", "not enough evidence"];
/** Parse #verdict innerText; reject hidden, rehearsal, invalid, and ambiguous verdicts. */
export function readOpeningNight(text: string): OpeningNight | { readonly error: string } {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heads = lines.filter((line) => line.includes(" — "));
  if (heads.length !== 1) return { error: "Opening Night must show exactly one comparison verdict" };
  const match = /^(.+?) — (use Jev|don't use Jev|not enough evidence)$/.exec(heads[0] ?? "");
  if (!match || !lines[1]?.startsWith("Per-pair, uncorrected comparison. ")) return { error: "Opening Night has no recognized verdict and reason" };
  const arm = match[1] ?? "";
  const name = match[2] ?? "";
  if (!verdicts.some((value) => value === name)) return { error: "Unknown verdict" };
  const reason = lines[1].slice("Per-pair, uncorrected comparison. ".length);
  if (!reason.startsWith(`${name}: `)) return { error: "Verdict reason does not match verdict" };
  const condition = (Object.keys(reasons) as Condition[]).find((key) => reasons[key].test(reason));
  if (!condition) return { error: "Unknown verdict reason" };
  const verdict = verdicts.find((value) => value === name);
  if (!verdict) return { error: "Unknown verdict" };
  return { arm, verdict, condition, reason };
}
export interface RecordProblem { readonly caseId: string; readonly problem: string }
/** Check exactly one unlabelled, valid output from every arm for every expected case. */
export function checkRecords(csv: string, caseIds: readonly string[], arms: readonly Arm[], allowLabels = false): readonly RecordProblem[] {
  const problems: RecordProblem[] = [];
  const parsed = readDictRows(csv);
  const header = parsed.header ?? [];
  const at = (name: string): number => header.indexOf(name);
  if (!header.includes("case_id") || !header.includes("answerer")) return [{ caseId: "file", problem: "records.csv needs case_id and answerer columns" }];
  const counts = new Map<string, number>();
  const expected = new Set(caseIds);
  for (const row of parsed.rows) {
    const get = (name: string): string => row.fields[at(name)] ?? "";
    const id = get("case_id");
    const arm = get("answerer");
    if (!expected.has(id)) problems.push({ caseId: id, problem: "case outside expected set" });
    if (!arms.includes(arm as Arm)) problems.push({ caseId: id, problem: `unexpected arm ${arm}` });
    const key = `${id}\0${arm}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!allowLabels) for (const label of ["label", "label_final", "label_source", "labelled_by", "labelled_at", "label_blind"]) {
      if (get(label) !== "") problems.push({ caseId: id, problem: `${label} is present` });
    }
    if (!get("answer_set").split("|").includes(get("output"))) problems.push({ caseId: id, problem: "output outside answer_set" });
  }
  for (const id of caseIds) for (const arm of arms) {
    const count = counts.get(`${id}\0${arm}`) ?? 0;
    if (count !== 1) problems.push({ caseId: id, problem: `${arm}: expected exactly one row, got ${count}${count > 1 ? " (duplicate)" : ""}` });
  }
  const validation = validate(csv);
  if (parsed.rows.length > 0) for (const error of validation.errors) problems.push({ caseId: "file", problem: error });
  return problems;
}
/** Scan path names and raw bytes; report only relative paths and secret names. */
export function scanForSecrets(dir: string, secrets: ReadonlyMap<string, string>): readonly { readonly file: string; readonly name: string }[] {
  const hits: { file: string; name: string }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) {
        const relDir = relative(dir, full).split("\\").join("/");
        for (const [name, value] of secrets) if (value.length >= 8 && relDir.includes(value)) hits.push({ file: relDir, name });
        walk(full); continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(dir, full).split("\\").join("/");
      const bytes = readFileSync(full);
      for (const [name, value] of secrets) {
        if (value.length < 8 || rel.includes(value) || bytes.includes(Buffer.from(value))) hits.push({ file: rel, name });
      }
    }
  };
  walk(dir);
  if (hits.length === 0) for (const [name, value] of secrets) if (value.length < 8) hits.push({ file: ".", name });
  return hits;
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
  readonly runTime?: string;
  readonly modelIds?: readonly string[];
  readonly labels?: string;
  readonly dryRun?: boolean;
}
const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
/** Render a report and refuse any failed step, record, verdict, or secret check. */
export function buildReport(input: ReportInput): { readonly ok: boolean; readonly exitCode: 0 | 1; readonly markdown: string } {
  const problems = input.dryRun ? [] : checkRecords(input.csv, input.caseIds, ["jev", "llm", "rule"], input.labels === "by a person (--pause-for-labels)");
  const opening = input.dryRun ? null : readOpeningNight(input.verdictText);
  const verdictError = opening && "error" in opening ? opening.error : null;
  const ok = input.steps.every((s) => s.pass) && problems.length === 0 && !verdictError && input.secretHits.length === 0;
  const lines = [
    input.dryRun ? "# DRY RUN: not evidence for criteria 2-6" : "# Fresh-clone happy path",
    "", `Base: ${cell(input.base)}`, `Version: ${cell(input.version)}`, `Clone SHA: ${cell(input.cloneSha ?? "unknown")}`,
    `Run time: ${cell(input.runTime ?? new Date().toISOString())}`, `Model ids: ${cell((input.modelIds ?? []).join(", "))}`,
    `Case count: ${input.caseIds.length}`, `Labels: ${input.labels ?? "none (agents never label)"}`,
    `Verdict: ${cell(input.verdictText || "unavailable")}`, `Records check: ${problems.length === 0 ? "pass" : `${problems.length} problem(s)`}`,
    "", "| # | Room | Step | Result | Detail | Screenshot |", "|---:|---|---|---|---|---|",
    ...input.steps.map((s, i) => `| ${i + 1} | ${cell(s.room)} | ${cell(s.step)} | ${s.pass ? "PASS" : "FAIL"} | ${cell(s.detail)} | ${s.shot ? `[image](${encodeURI(s.shot)})` : ""} |`),
    "", ...problems.map((p) => `- ${cell(p.caseId)}: ${cell(p.problem)}`),
    ...(verdictError ? [`- Verdict: ${cell(verdictError)}`] : []),
    ...input.secretHits.map((hit) => `- Secret found: ${cell(hit.name)} in ${cell(hit.file)}`),
  ];
  return { ok, exitCode: ok ? 0 : 1, markdown: lines.join("\n") + "\n" };
}
/** Prepare New Scene fields for the UC13 shop bot. */
export function uc13Scene(factSheet: string): { readonly question: string; readonly choiceA: string; readonly choiceB: string; readonly definitionA: string; readonly definitionB: string; readonly acceptance: string } {
  const lines = factSheet.trim().split("\n").filter((line) => line.trim());
  const fields = [QUESTION, CRITERIA.hand_off, CRITERIA.answer];
  for (const line of lines) {
    const index = fields.findIndex((field) => field.length + line.length + 1 <= 1000);
    if (index < 0) throw new Error("Fact sheet exceeds scene field limits");
    fields[index] = `${fields[index]}\n${line}`;
  }
  return { question: fields[0] ?? QUESTION, choiceA: "hand_off", choiceB: "answer", definitionA: fields[1] ?? CRITERIA.hand_off, definitionB: fields[2] ?? CRITERIA.answer, acceptance: "Use the fact sheet only; hand off anything it does not cover." };
}
/** RFC 4180 case_id,case_input CSV. */
export function casesCsv(cases: readonly { case_id: string; case_input: string }[]): string {
  return formatRows([["case_id", "case_input"], ...cases.map((c) => [c.case_id, c.case_input])]);
}
/** Extract comma-separated keyword terms from rule.md. */
export function ruleKeywords(ruleMd: string): readonly string[] {
  const line = ruleMd.split("\n").find((value) => value.startsWith("available, "));
  if (!line) throw new Error("rule.md has no keyword list");
  return line.split(",").map((term) => term.trim()).filter(Boolean);
}

/** Stub: fit a keyword list into Backstage's cap. */
export function fitKeywords(terms: readonly string[], cap: number): { readonly kept: readonly string[]; readonly redundant: readonly string[]; readonly dropped: readonly string[] } {
  return { kept: terms.slice(0, cap), redundant: [], dropped: [] };
}
