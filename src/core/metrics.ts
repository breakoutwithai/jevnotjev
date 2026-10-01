// Accepted-result counts and cost per accepted result for each comparison arm (day 7).
// Pure: takes validated jnj-record/1 rows, uses no Node or Bun APIs, so the browser can import it.
// Rules: docs/SPEC.md "Metrics and matched samples". A missing label is a gap, never a rejection;
// a missing cost makes spend incomplete, never zero; zero accepted makes cost per accepted undefined.

import type { ParsedRow, Row } from "../format/validate.ts";

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

function label(row: Row): "accept" | "reject" | null {
  const value = row.get("label");
  if (value === null || value === undefined) return null;
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
  if (mine.length === 0) throw new Error(`no rows for cohort ${id}`);
  const first = mine[0] as Row;
  const byArm = new Map<Arm, Map<string, Row>>(ARMS.map((arm) => [arm, new Map()]));
  for (const row of mine) {
    const answerer = text(row, "answerer");
    const arm = byArm.get(answerer as Arm);
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
