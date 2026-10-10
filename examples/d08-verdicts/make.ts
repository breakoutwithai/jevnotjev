// Writes the day 8 verdict fixtures: one synthetic jnj-record/1 file per verdict branch.
// Run: bun examples/d08-verdicts/make.ts. Every count is worked in expected.md beside this file.
// The files are generated, not hand-edited: src/core/verdict.test.ts checks the committed CSVs equal buildFiles().

import { join } from "node:path";
import { formatRow } from "../../src/format/csv.ts";
import { COLUMNS } from "../../src/format/validate.ts";

/** A for accept, R for reject; a missing row is null on the case. */
export type Label = "A" | "R";

interface Cell {
  readonly label: Label;
  /** null leaves cost_usd empty. */
  readonly cost: number | null;
}

interface CaseRow {
  readonly jev: Cell | null;
  readonly llm: Cell | null;
  readonly rule: Cell | null;
}

export interface Fixture {
  /** File name without .csv. */
  readonly name: string;
  readonly cases: readonly CaseRow[];
}

/** Per-call costs from the d06 file: Jev $0.00002, LLM $0.002, the rule $0. */
const JEV = 0.00002;
const LLM = 0.002;

/** Labels for Jev and the other answerer: a both accept, b first only, c second only, d both reject. */
export function quad(a: number, b: number, c: number, d: number): [Label, Label][] {
  const out: [Label, Label][] = [];
  for (let i = 0; i < a; i += 1) out.push(["A", "A"]);
  for (let i = 0; i < b; i += 1) out.push(["A", "R"]);
  for (let i = 0; i < c; i += 1) out.push(["R", "A"]);
  for (let i = 0; i < d; i += 1) out.push(["R", "R"]);
  return out;
}

/** The first `accepted` of `n` labels accept, the rest reject. */
function firstAccept(accepted: number, n: number): Label[] {
  return Array.from({ length: n }, (_, i) => (i < accepted ? "A" : "R"));
}

export interface Build {
  readonly name: string;
  /** Jev and LLM labels per case; a null side means that answerer has no rows. */
  readonly pairs: readonly [Label | null, Label | null][];
  readonly rule?: readonly Label[];
  readonly jevCost?: number;
  readonly llmCost?: number;
  /** Case indexes (0-based) whose Jev row has no cost. */
  readonly jevCostMissing?: readonly number[];
  /** Case indexes (0-based) whose Jev and LLM rows both cost $0. */
  readonly freeCases?: readonly number[];
}

export function build(spec: Build): Fixture {
  const jevCost = spec.jevCost ?? JEV;
  const llmCost = spec.llmCost ?? LLM;
  const cases = spec.pairs.map(([jev, llm], i): CaseRow => {
    const rule = spec.rule?.[i];
    const free = spec.freeCases?.includes(i) === true;
    return {
      jev: jev === null ? null : { label: jev, cost: spec.jevCostMissing?.includes(i) === true ? null : free ? 0 : jevCost },
      llm: llm === null ? null : { label: llm, cost: free ? 0 : llmCost },
      rule: rule === undefined ? null : { label: rule, cost: 0 },
    };
  });
  return { name: spec.name, cases };
}

function only(side: "jev" | "llm", labels: readonly Label[]): [Label | null, Label | null][] {
  return labels.map((label) => (side === "jev" ? [label, null] : [null, label]));
}

/** One file per verdict branch, and one per rule-1 and rule-2 condition. */
export const FIXTURES: readonly Fixture[] = [
  // Rule 1: not enough evidence.
  build({ name: "r1-no-jev", pairs: only("llm", firstAccept(27, 30)), rule: firstAccept(10, 30) }),
  build({ name: "r1-no-llm", pairs: only("jev", firstAccept(27, 30)), rule: firstAccept(10, 30) }),
  build({ name: "r1-29-paired", pairs: quad(26, 2, 1, 0) }),
  build({ name: "r1-both-zero", pairs: quad(0, 0, 0, 30) }),
  build({ name: "r1-jev-zero", pairs: quad(0, 0, 1, 29) }),
  build({ name: "r1-llm-zero", pairs: quad(0, 1, 0, 29) }),
  build({ name: "r1-cost-missing", pairs: quad(27, 3, 0, 0), jevCostMissing: [0] }),
  // Rule 2: don't use Jev, one file per condition.
  build({ name: "r2-rule-within-margin", pairs: quad(27, 0, 0, 3), rule: firstAccept(30, 30) }),
  build({ name: "r2-jev-worse", pairs: quad(15, 0, 15, 0) }),
  build({ name: "r2-jev-dearer", pairs: quad(27, 3, 0, 0), jevCost: 0.004 }),
  // Rule 3: use Jev. The rule is compared and is far behind.
  build({ name: "r3-use-jev", pairs: quad(27, 3, 0, 0), rule: firstAccept(10, 30) }),
  // Rule 4: not enough evidence, otherwise.
  build({ name: "r4-accept-rate", pairs: quad(27, 0, 0, 3) }),
  build({ name: "r4-cheaper-under-20", pairs: quad(27, 3, 0, 0), jevCost: 0.002 }),
];

const ANSWERER_MODEL: Readonly<Record<"jev" | "llm" | "rule", string>> = {
  jev: "jev-1.13.0",
  llm: "example-llm",
  rule: "keywords:synthetic",
};

/** Plain decimal text: the format has no exponent notation, so a huge whole cost is written out in digits. */
function costText(cost: number): string {
  return Number.isInteger(cost) && Math.abs(cost) >= 1e21 ? BigInt(cost).toString() : String(cost);
}

function row(fixture: Fixture, caseIndex: number, answerer: "jev" | "llm" | "rule", cell: Cell): string[] {
  const caseId = `c${String(caseIndex + 1).padStart(2, "0")}`;
  // The output is whatever the label makes right for a synthetic case whose correct answer is "yes".
  const output = cell.label === "R" ? "no" : "yes";
  const values: Readonly<Record<string, string>> = {
    format_version: "jnj-record/1",
    run_id: `run-d08-${fixture.name}`,
    prompt_version: "d08.v1",
    case_id: caseId,
    case_input: `Synthetic case ${caseId} for the ${fixture.name} verdict fixture.`,
    question_id: "q1",
    question: "Does the synthetic case meet the requirement?",
    answer_set: "yes|no",
    answerer,
    answerer_model: ANSWERER_MODEL[answerer],
    output,
    confidence: "",
    label: cell.label === "A" ? "accept" : "reject",
    label_source: "human",
    tokens_in: "",
    tokens_out: "",
    cost_usd: cell.cost === null ? "" : costText(cell.cost),
    latency_ms: "",
  };
  return COLUMNS.map((column) => values[column] ?? "");
}

/** CSV text of one fixture: header, then per case the jev, rule and llm rows (the d06 order). */
export function render(fixture: Fixture): string {
  const lines: string[][] = [[...COLUMNS]];
  fixture.cases.forEach((one, i) => {
    if (one.jev !== null) lines.push(row(fixture, i, "jev", one.jev));
    if (one.rule !== null) lines.push(row(fixture, i, "rule", one.rule));
    if (one.llm !== null) lines.push(row(fixture, i, "llm", one.llm));
  });
  return lines.map((fields) => formatRow(fields, "\n")).join("");
}

/** File name to CSV text, for every fixture. */
export function buildFiles(): Map<string, string> {
  return new Map(FIXTURES.map((fixture) => [`${fixture.name}.csv`, render(fixture)]));
}

if (import.meta.main) {
  for (const [name, text] of buildFiles()) {
    await Bun.write(join(import.meta.dir, name), text);
    console.log(`wrote ${name}`);
  }
}
