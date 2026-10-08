// Accepted-result counts and cost per accepted result for each comparison arm (day 7).
// Pure: takes validated jnj-record/1 rows, uses no Node or Bun APIs, so the browser can import it.
// Rules: docs/spec/spec.md R5 "Calculations per decision point". A missing label is a gap, never a rejection;
// a missing cost makes spend incomplete, never zero; zero accepted makes cost per accepted undefined.

import { truthLabel, type ParsedRow, type Row } from "../format/validate.ts";
import type { CostCase } from "./calc.ts";

export type Arm = "llm" | "rule" | "jev";
export const ARMS: readonly Arm[] = ["llm", "rule", "jev"];

/** One comparison cohort: one run, one prompt version, one question. Never pooled. */
export interface CohortKey {
  readonly runId: string;
  readonly promptVersion: string;
  readonly questionId: string;
}

/** Spend over a set of rows. `incomplete` when any row lacks a cost; the known part is still shown. */
export type Spend =
  | { readonly kind: "complete"; readonly usd: number }
  | { readonly kind: "incomplete"; readonly knownUsd: number; readonly missing: number };

/** Spend divided by accepted results, or the reason there is no number. */
export type CostPerAccepted =
  | { readonly kind: "value"; readonly usd: number }
  | { readonly kind: "undefined"; readonly reason: "zero accepted" }
  | { readonly kind: "incomplete"; readonly reason: "cost missing" };

export interface ArmTotals {
  readonly arm: Arm;
  readonly rows: number;
  readonly labelled: number;
  readonly accepted: number;
  readonly rejected: number;
  /** Rows with no label: neither accepted nor rejected. */
  readonly unlabelled: number;
  /** accepted / labelled; null when nothing is labelled. */
  readonly acceptRate: number | null;
  readonly spend: Spend;
  readonly costPerAccepted: CostPerAccepted;
}

export interface PairArm {
  readonly arm: Arm;
  readonly accepted: number;
  readonly acceptRate: number | null;
  readonly spend: Spend;
  readonly costPerAccepted: CostPerAccepted;
}

/** Jev against one other arm on cases where both have a labelled row. Each pair has its own denominator. */
export interface PairedSample {
  readonly other: Exclude<Arm, "jev">;
  /** Cases with a labelled Jev row and a labelled row for the other arm. */
  readonly n: number;
  /** Cases where one or both rows exist but at least one is unlabelled or absent. */
  readonly excluded: number;
  readonly jev: PairArm;
  readonly otherArm: PairArm;
  /** a: both accepted; b: Jev only; c: other only; d: both rejected. */
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  /** Jev wins = b, losses = c, ties = a + d. */
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** The paired cases, sorted by case_id: both labels and both costs (null when missing). */
  readonly cases: readonly PairedCase[];
}

export interface PairedCase {
  readonly caseId: string;
  readonly jevAccepted: boolean;
  readonly otherAccepted: boolean;
  readonly jevCostUsd: number | null;
  readonly otherCostUsd: number | null;
}

export interface CohortMetrics {
  readonly key: CohortKey;
  readonly question: string;
  readonly answerSet: string;
  readonly cases: number;
  /** Totals over every row of each arm present in the cohort, labelled or not. */
  readonly arms: readonly ArmTotals[];
  /** Missing when either side has no rows at all in this cohort. */
  readonly jevVsLlm: PairedSample | null;
  readonly jevVsRule: PairedSample | null;
}

function text(row: Row, column: string): string {
  const value = row.get(column);
  if (typeof value !== "string") throw new Error(`${column} is not text after validation`);
  return value;
}

function cost(row: Row): number | null {
  const value = row.get("cost_usd");
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") throw new Error("cost_usd is not a number after validation");
  return value;
}

/** A row's label as truth: an `agent` label was never reviewed by a person, so it reads as unlabelled (format/README.md). */
function label(row: Row): "accept" | "reject" | null {
  const value = truthLabel(row);
  if (value === null) return null;
  if (value !== "accept" && value !== "reject") throw new Error(`label ${String(value)} after validation`);
  return value;
}

/** Sum of costs; incomplete if any is missing. An empty set spends a complete $0. */
export function spendOf(rows: readonly Row[]): Spend {
  let known = 0;
  let missing = 0;
  for (const row of rows) {
    const value = cost(row);
    if (value === null) missing += 1;
    else known += value;
  }
  return missing === 0 ? { kind: "complete", usd: known } : { kind: "incomplete", knownUsd: known, missing };
}

/** Spend / accepted. Missing cost wins over zero accepted: an incomplete spend has no ratio at all. */
export function costPerAccepted(spend: Spend, accepted: number): CostPerAccepted {
  if (spend.kind === "incomplete") return { kind: "incomplete", reason: "cost missing" };
  if (accepted === 0) return { kind: "undefined", reason: "zero accepted" };
  return { kind: "value", usd: spend.usd / accepted };
}

function totals(arm: Arm, rows: readonly Row[]): ArmTotals {
  const labels = rows.map(label);
  const accepted = labels.filter((value) => value === "accept").length;
  const rejected = labels.filter((value) => value === "reject").length;
  const labelled = accepted + rejected;
  const spend = spendOf(rows);
  return {
    arm,
    rows: rows.length,
    labelled,
    accepted,
    rejected,
    unlabelled: rows.length - labelled,
    acceptRate: labelled === 0 ? null : accepted / labelled,
    spend,
    costPerAccepted: costPerAccepted(spend, accepted),
  };
}

function pairArm(arm: Arm, rows: readonly Row[]): PairArm {
  const accepted = rows.filter((row) => label(row) === "accept").length;
  const spend = spendOf(rows);
  return {
    arm,
    accepted,
    acceptRate: rows.length === 0 ? null : accepted / rows.length,
    spend,
    costPerAccepted: costPerAccepted(spend, accepted),
  };
}

function paired(
  other: Exclude<Arm, "jev">,
  jevByCase: ReadonlyMap<string, Row>,
  otherByCase: ReadonlyMap<string, Row>,
): PairedSample | null {
  if (jevByCase.size === 0 || otherByCase.size === 0) return null;
  const caseIds = [...new Set([...jevByCase.keys(), ...otherByCase.keys()])].sort();
  const jevRows: Row[] = [];
  const otherRows: Row[] = [];
  const cases: PairedCase[] = [];
  let excluded = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (const caseId of caseIds) {
    const jevRow = jevByCase.get(caseId);
    const otherRow = otherByCase.get(caseId);
    const jevLabel = jevRow === undefined ? null : label(jevRow);
    const otherLabel = otherRow === undefined ? null : label(otherRow);
    if (jevRow === undefined || otherRow === undefined || jevLabel === null || otherLabel === null) {
      excluded += 1;
      continue;
    }
    jevRows.push(jevRow);
    otherRows.push(otherRow);
    const jevOk = jevLabel === "accept";
    const otherOk = otherLabel === "accept";
    cases.push({ caseId, jevAccepted: jevOk, otherAccepted: otherOk, jevCostUsd: cost(jevRow), otherCostUsd: cost(otherRow) });
    if (jevOk && otherOk) a += 1;
    else if (jevOk) b += 1;
    else if (otherOk) c += 1;
    else d += 1;
  }
  return {
    other,
    n: jevRows.length,
    excluded,
    jev: pairArm("jev", jevRows),
    otherArm: pairArm(other, otherRows),
    a,
    b,
    c,
    d,
    wins: b,
    losses: c,
    ties: a + d,
    cases,
  };
}

function cohortId(key: CohortKey): string {
  return JSON.stringify([key.runId, key.promptVersion, key.questionId]);
}

/** Every cohort in a validated file, in first-seen order. Rows answered by `human` are kept out of the arms. */
export function cohorts(rows: readonly ParsedRow[]): CohortKey[] {
  const seen = new Map<string, CohortKey>();
  for (const { values } of rows) {
    const key = {
      runId: text(values, "run_id"),
      promptVersion: text(values, "prompt_version"),
      questionId: text(values, "question_id"),
    };
    const id = cohortId(key);
    if (!seen.has(id)) seen.set(id, key);
  }
  return [...seen.values()];
}

/**
 * Metrics for one cohort. Rows must already pass validate(); a repeated (case, arm) row inside
 * the cohort is refused rather than silently picking one.
 */
export function cohortMetrics(rows: readonly ParsedRow[], key: CohortKey): CohortMetrics {
  const id = cohortId(key);
  const mine = rows
    .map(({ values }) => values)
    .filter(
      (row) =>
        cohortId({
          runId: text(row, "run_id"),
          promptVersion: text(row, "prompt_version"),
          questionId: text(row, "question_id"),
        }) === id,
    );
  return metricsOfCohortRows(mine, key);
}

/**
 * The compared methods with at least one row anywhere in the file, in ARMS order. A question that lacks one of them
 * has 0 cases for it (verdict.ts "Uneven cases"); a method no question has is not expected of any.
 */
export function armsInFile(rows: readonly ParsedRow[]): Arm[] {
  const answerers = new Set(rows.map(({ values }) => values.get("answerer")));
  return ARMS.filter((arm) => answerers.has(arm));
}

/** Every cohort with its own rows, in first-seen order, from one pass over the file. */
export function groupCohorts(rows: readonly ParsedRow[]): { readonly key: CohortKey; readonly rows: readonly Row[] }[] {
  const groups = new Map<string, { key: CohortKey; rows: Row[] }>();
  for (const { values } of rows) {
    const key = {
      runId: text(values, "run_id"),
      promptVersion: text(values, "prompt_version"),
      questionId: text(values, "question_id"),
    };
    const id = cohortId(key);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, { key, rows: [values] });
    else group.rows.push(values);
  }
  return [...groups.values()];
}

/** Metrics for one cohort whose rows are already selected (see groupCohorts); same result as cohortMetrics. */
export function metricsOfCohortRows(mine: readonly Row[], key: CohortKey): CohortMetrics {
  const id = cohortId(key);
  const first = mine[0];
  if (first === undefined) throw new Error(`no rows for cohort ${id}`);
  const byArm = new Map<Arm, Map<string, Row>>(ARMS.map((arm) => [arm, new Map()]));
  for (const row of mine) {
    const answerer = text(row, "answerer");
    const known = ARMS.find((a) => a === answerer);
    const arm = known === undefined ? undefined : byArm.get(known);
    if (arm === undefined) continue; // `human` rows are kept in the file, not compared
    const caseId = text(row, "case_id");
    if (arm.has(caseId)) throw new Error(`cohort ${id}: more than one ${answerer} row for case ${caseId}`);
    arm.set(caseId, row);
  }
  const armMap = (arm: Arm): Map<string, Row> => byArm.get(arm) ?? new Map();
  return {
    key,
    question: text(first, "question"),
    answerSet: text(first, "answer_set"),
    cases: new Set(mine.map((row) => text(row, "case_id"))).size,
    arms: ARMS.filter((arm) => armMap(arm).size > 0).map((arm) => totals(arm, [...armMap(arm).values()])),
    jevVsLlm: paired("llm", armMap("jev"), armMap("llm")),
    jevVsRule: paired("rule", armMap("jev"), armMap("rule")),
  };
}

/** One line of text for a cost per accepted result, never a silent number. */
export function describeCostPerAccepted(value: CostPerAccepted): string {
  if (value.kind === "value") return `$${value.usd.toFixed(6)}`;
  if (value.kind === "undefined") return "undefined (0 accepted)";
  return "incomplete (cost missing)";
}

export function describeSpend(value: Spend): string {
  if (value.kind === "complete") return `$${value.usd.toFixed(6)}`;
  return `incomplete ($${value.knownUsd.toFixed(6)} known, ${value.missing} missing)`;
}

/**
 * Where one method's labels came from: labelled rows by label_source, and whether those calls were blind.
 * jnj-record/1 rows record label_source (human) but not blindness, so their blindness counts as not recorded.
 * Agent labels are counted here (they are shown) although they never count as truth.
 */
export interface LabelProvenance {
  readonly human: number;
  readonly humanReviewed: number;
  readonly agent: number;
  /** Labelled rows with no label_source. */
  readonly sourceNotRecorded: number;
  readonly blindYes: number;
  readonly blindNo: number;
  readonly blindNotRecorded: number;
}

/** Provenance of the labelled rows among `rows` (one method's rows). */
export function labelProvenance(rows: readonly Row[]): LabelProvenance {
  let human = 0;
  let humanReviewed = 0;
  let agent = 0;
  let sourceNotRecorded = 0;
  let blindYes = 0;
  let blindNo = 0;
  let blindNotRecorded = 0;
  for (const row of rows) {
    const labelled = row.get("label");
    if (labelled === null || labelled === undefined) continue;
    const source = row.get("label_source");
    const blind = row.get("label_blind");
    if (source === "human") human += 1;
    else if (source === "human_reviewed") humanReviewed += 1;
    else if (source === "agent") agent += 1;
    else sourceNotRecorded += 1;
    if (blind === "true") blindYes += 1;
    else if (blind === "false") blindNo += 1;
    else blindNotRecorded += 1;
  }
  return { human, humanReviewed, agent, sourceNotRecorded, blindYes, blindNo, blindNotRecorded };
}

/** Per answerer in the file, sorted by name: `<answerer>: <describeProvenance>` over all of its rows. */
export function provenanceByMethod(rows: readonly ParsedRow[]): string[] {
  const answerers = [...new Set(rows.map(({ values }) => String(values.get("answerer"))))].sort();
  return answerers.map((answerer) => {
    const mine = rows.map(({ values }) => values).filter((row) => row.get("answerer") === answerer);
    return `${answerer}: ${describeProvenance(labelProvenance(mine))}`;
  });
}

/** One line for a method's label provenance, never a silent blank. A single blind value is shown bare only when every label has it. */
export function describeProvenance(value: LabelProvenance): string {
  const total = value.human + value.humanReviewed + value.agent + value.sourceNotRecorded;
  if (total === 0) return "no labels";
  const sources: [string, number][] = [
    ["human", value.human],
    ["human_reviewed", value.humanReviewed],
    ["agent", value.agent],
    ["source not recorded", value.sourceNotRecorded],
  ];
  const blinds: [string, number][] = [
    ["yes", value.blindYes],
    ["no", value.blindNo],
    ["not recorded", value.blindNotRecorded],
  ];
  const counted = (pairs: [string, number][]): string[] => pairs.filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`);
  const only = blinds.find(([, n]) => n === total);
  const blind = only === undefined ? counted(blinds).join(", ") : only[0];
  return `labels: ${sources.filter(([, n]) => n > 0).map(([name, n]) => `${name} ${n}`).join(", ")}; blind: ${blind}`;
}

/** The paired cases as resample input, Jev first; null when any paired row lacks a cost (rule 1 stops first). */
export function pairedCostCases(pair: PairedSample): CostCase[] | null {
  const out: CostCase[] = [];
  for (const one of pair.cases) {
    if (one.jevCostUsd === null || one.otherCostUsd === null) return null;
    out.push({ jevAccepted: one.jevAccepted, jevCostUsd: one.jevCostUsd, llmAccepted: one.otherAccepted, llmCostUsd: one.otherCostUsd });
  }
  return out;
}
