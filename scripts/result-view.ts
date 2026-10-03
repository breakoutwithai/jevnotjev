// D09 result view: one self-contained HTML page comparing the current LLM, the keyword rule and Jev.
// Every number comes from src/core (metrics and verdict) over the validated file; this script only lays them out.
// Run: bun scripts/result-view.ts (no arguments): reads examples/d06-tiny/records.csv, writes site/result-d06.html.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeUtf8, validate, type ParsedRow } from "../src/format/validate.ts";
import { fileSeed } from "../src/core/calc.ts";
import {
  ARMS,
  cohortMetrics,
  cohorts,
  costPerAccepted,
  describeCostPerAccepted,
  describeSpend,
  spendOf,
  type Arm,
  type ArmTotals,
  type CohortKey,
  type CohortMetrics,
  type PairArm,
  type Spend,
} from "../src/core/metrics.ts";
import { verdict, type RuleComparison, type Verdict } from "../src/core/verdict.ts";

const NAMES: Readonly<Record<Arm, string>> = { llm: "Current LLM", rule: "Simple keyword rule", jev: "Jev" };
const WHOLE_FILE = "whole file";
/** The hand-worked fixture; its own limitations are shown only for this source. */
export const D06_SOURCE = "examples/d06-tiny/records.csv";
/** The page the CLI writes, relative to the repo root. */
const OUTPUT = "site/result-d06.html";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** One element wrapping already-escaped HTML. */
function tag(name: string, inner: string): string {
  return `<${name}>${inner}</${name}>`;
}

/**
 * A whole number or money value ("30", "-0.1097", "$0.000025", "4.4999999999999984e+26"): its cell never wraps,
 * so the number is never split.
 */
const NUMBER = /^-?\$?\d[\d.,]*(?:[eE][+-]?\d+)?$/;

/** True for a cell value that is one number or money amount, so it must never wrap. */
export function isNumberCell(value: string): boolean {
  return NUMBER.test(value);
}

function td(key: string, value: string): string {
  const kind = isNumberCell(value) ? ' class="num"' : "";
  return `<td data-cell="${escape(key)}"${kind}>${escape(value)}</td>`;
}

function field(row: ParsedRow, column: string): string {
  return String(row.values.get(column));
}

/** Data-cell namespace for one cohort: run, prompt version and question, so no two cohorts share a key. */
function scopeOf(key: CohortKey): string {
  return `${key.runId}/${key.promptVersion}/${key.questionId}`;
}

/** The validated rows of one cohort, with their CSV line numbers. */
function cohortRows(rows: readonly ParsedRow[], key: CohortKey): ParsedRow[] {
  return rows.filter(
    (row) => field(row, "run_id") === key.runId && field(row, "prompt_version") === key.promptVersion && field(row, "question_id") === key.questionId,
  );
}

function lineList(lines: readonly number[]): string {
  return lines.length === 1 ? `line ${lines[0]}` : `lines ${lines.join(", ")}`;
}

/** Gap counts (from src/core for the arms), with the CSV lines behind them (R8.a, R8.b). `mine` is one answerer's rows. */
function gapText(mine: readonly ParsedRow[], unlabelledCount: number, spend: Spend): string {
  const unlabelled = mine.filter((row) => row.values.get("label") === null).map((row) => row.line);
  const noCost = mine.filter((row) => row.values.get("cost_usd") === null).map((row) => row.line);
  const parts: string[] = [];
  if (unlabelledCount > 0) parts.push(`${unlabelledCount} unlabelled (${lineList(unlabelled)})`);
  if (spend.kind === "incomplete") parts.push(`${spend.missing} cost missing (${lineList(noCost)})`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

function gaps(totals: ArmTotals, rows: readonly ParsedRow[]): string {
  return gapText(rows.filter((row) => field(row, "answerer") === totals.arm), totals.unlabelled, totals.spend);
}

/**
 * Rows answered by `human` (R4.d): counted and shown, never in the verdict. src/core keeps them out of the arms,
 * so spend and cost per accepted use its spendOf and costPerAccepted directly. Null when there are none.
 */
function humanTable(scope: string, rows: readonly ParsedRow[]): string | null {
  const mine = rows.filter((row) => field(row, "answerer") === "human");
  if (mine.length === 0) return null;
  const labels = mine.map((row) => row.values.get("label"));
  const accepted = labels.filter((value) => value === "accept").length;
  const labelled = labels.filter((value) => value === "accept" || value === "reject").length;
  const spend = spendOf(mine.map((row) => row.values));
  const line = (label: string, name: string, value: string): string => `<tr><th scope="row">${label}</th>${td(`${scope}.human.${name}`, value)}</tr>`;
  return [
    `<div class="scroll"><table>${tag("caption", "Answers by a person: counted and shown, not used in the verdict")}`,
    `<thead><tr><th scope="col"></th><th scope="col">Person</th></tr></thead><tbody>`,
    line("Answers", "rows", String(mine.length)),
    line("Labelled by a person", "labelled", String(labelled)),
    line("Accepted", "accepted", String(accepted)),
    line("Gaps", "gaps", gapText(mine, mine.length - labelled, spend)),
    line("Spend", "spend", describeSpend(spend)),
    line("Cost per accepted result", "cpa", describeCostPerAccepted(costPerAccepted(spend, accepted))),
    "</tbody></table></div>",
  ].join("\n");
}

/**
 * Every row of the file as one cohort, so src/core totals the whole file per method. The case id carries the full
 * identity (run, prompt version, case, question), so each original row stays one row per method; the paired
 * figures of this cohort are not shown.
 */
function wholeFile(rows: readonly ParsedRow[]): CohortMetrics {
  const merged = rows.map((row): ParsedRow => {
    const values = new Map(row.values);
    values.set("case_id", JSON.stringify(["run_id", "prompt_version", "case_id", "question_id"].map((column) => field(row, column))));
    values.set("question_id", WHOLE_FILE);
    values.set("run_id", WHOLE_FILE);
    values.set("prompt_version", WHOLE_FILE);
    return { ...row, values };
  });
  return cohortMetrics(merged, { runId: WHOLE_FILE, promptVersion: WHOLE_FILE, questionId: WHOLE_FILE });
}

function armTable(scope: string, metrics: CohortMetrics, rows: readonly ParsedRow[], caption: string): string {
  const arms = ARMS.flatMap((arm) => metrics.arms.filter((totals) => totals.arm === arm));
  const head = arms.map((totals) => `<th scope="col">${NAMES[totals.arm]}</th>`).join("");
  const line = (label: string, name: string, value: (totals: ArmTotals) => string): string =>
    `<tr><th scope="row">${label}</th>${arms.map((totals) => td(`${scope}.${totals.arm}.${name}`, value(totals))).join("")}</tr>`;
  return [
    `<div class="scroll"><table>${tag("caption", caption)}`,
    `<thead><tr><th scope="col"></th>${head}</tr></thead><tbody>`,
    line("Answers", "rows", (totals) => String(totals.rows)),
    line("Labelled by a person", "labelled", (totals) => String(totals.labelled)),
    line("Accepted", "accepted", (totals) => String(totals.accepted)),
    line("Gaps", "gaps", (totals) => gaps(totals, rows)),
    line("Spend", "spend", (totals) => describeSpend(totals.spend)),
    line("Cost per accepted result", "cpa", (totals) => describeCostPerAccepted(totals.costPerAccepted)),
    "</tbody></table></div>",
    ...[humanTable(scope, rows)].filter((table): table is string => table !== null),
  ].join("\n");
}

function pairTable(scope: string, metrics: CohortMetrics): string {
  const pair = metrics.jevVsLlm;
  if (pair === null) return tag("p", "No paired comparison: Jev or the LLM has no answers to this question.");
  const sides: ReadonlyArray<readonly [string, PairArm]> = [
    ["llm", pair.otherArm],
    ["jev", pair.jev],
  ];
  const line = (label: string, cellName: string, value: (side: PairArm) => string): string =>
    `<tr><th scope="row">${label}</th>${sides.map(([name, side]) => td(`${scope}.vs-llm.${name}.${cellName}`, value(side))).join("")}</tr>`;
  const caption = `What the verdict compares: Jev and the LLM on the <span data-cell="${escape(scope)}.vs-llm.n">${pair.n}</span> cases where both answers have a label`;
  return [
    `<div class="scroll"><table>${tag("caption", caption)}`,
    `<thead><tr><th scope="col"></th><th scope="col">${NAMES.llm}</th><th scope="col">${NAMES.jev}</th></tr></thead><tbody>`,
    line("Accepted", "accepted", (side) => String(side.accepted)),
    line("Spend", "spend", (side) => describeSpend(side.spend)),
    line("Cost per accepted result", "cpa", (side) => describeCostPerAccepted(side.costPerAccepted)),
    "</tbody></table></div>",
  ].join("\n");
}

function ruleLine(rule: RuleComparison): string {
  if (rule.kind === "skipped") return `skipped: ${rule.reason} (${rule.paired} paired)`;
  return `compared on ${rule.n} paired cases: rule minus Jev ${rule.diff.toFixed(2)} (95% interval ${rule.lower.toFixed(2)} to ${rule.upper.toFixed(2)})`;
}

function four(x: number): string {
  return x.toFixed(4);
}

/**
 * The numbers the verdict computed (R7.b): only the fields result.numbers holds, to 4 places, with no new arithmetic.
 * The accept rates and their difference come from the Jev against LLM comparison, computed before rule 1 runs, so the
 * rule that fired may not have used all of them; the cost ratio exists once rule 1 has passed.
 */
function numbersTable(scope: string, result: Verdict): string {
  const { jevVsLlm, costRatio } = result.numbers;
  if (jevVsLlm === null && costRatio === null) {
    return `<p data-cell="${escape(scope)}.numbers">No Jev-versus-LLM numbers were computed for this question.</p>`;
  }
  const caption = `Numbers the verdict computed. Rule ${result.rule} may not use all of these; the reason above names the condition that decided.`;
  const key = (name: string): string => `${scope}.numbers.${name}`;
  const row = (label: string, name: string, value: number | string): string =>
    `<tr><th scope="row">${escape(label)}</th>${td(key(name), typeof value === "number" ? four(value) : value)}<td></td><td></td></tr>`;
  const withInterval = (label: string, stem: string, value: number, lower: number, upper: number): string =>
    `<tr><th scope="row">${escape(label)}</th>${td(key(`${stem}-${stem === "accept" ? "diff" : "ratio"}`), four(value))}` +
    `${td(key(`${stem}-lower`), four(lower))}${td(key(`${stem}-upper`), four(upper))}</tr>`;
  const lines: string[] = [];
  if (jevVsLlm !== null) {
    lines.push(
      row("Paired cases (Jev and the LLM both labelled)", "paired", String(jevVsLlm.n)),
      row("Accept rate, Jev", "jev-rate", jevVsLlm.p1),
      row("Accept rate, LLM", "llm-rate", jevVsLlm.p2),
      withInterval("Accept rate, Jev minus LLM", "accept", jevVsLlm.diff, jevVsLlm.lower, jevVsLlm.upper),
    );
  }
  if (costRatio !== null) {
    lines.push(withInterval("Cost ratio, Jev / LLM per accepted answer", "cost", costRatio.ratio, costRatio.lower, costRatio.upper));
  }
  return [
    `<div class="scroll"><table>${tag("caption", escape(caption))}`,
    '<thead><tr><th scope="col"></th><th scope="col">Value</th><th scope="col">95% interval from</th><th scope="col">to</th></tr></thead><tbody>',
    ...lines,
    "</tbody></table></div>",
  ].join("\n");
}

/** One question's section. `shared` is true when another cohort has the same question id, so run and prompt are named. */
function questionSection(metrics: CohortMetrics, rows: readonly ParsedRow[], result: Verdict, shared: boolean): string {
  const { key } = metrics;
  const scope = scopeOf(key);
  const attr = escape(scope);
  const label = shared ? `${key.questionId} (run ${key.runId}, prompt ${key.promptVersion})` : key.questionId;
  return [
    "<section>",
    tag("h2", `${escape(label)}: ${escape(metrics.question)}`),
    `<p class="verdict">Verdict: <strong data-cell="${attr}.verdict">${escape(result.verdict)}</strong> ` +
      `(<span data-cell="${attr}.rule">rule ${result.rule}</span> of the 4 in docs/decision/verdict-rules.md fired)</p>`,
    `<p>Why: <span data-cell="${attr}.reason">${escape(result.reason)}</span></p>`,
    `<p>Rule against Jev: <span data-cell="${attr}.rule-comparison">${escape(ruleLine(result.ruleComparison))}</span></p>`,
    numbersTable(scope, result),
    armTable(scope, metrics, rows, `All answers to ${escape(label)}, per method`),
    pairTable(scope, metrics),
    "</section>",
  ].join("\n");
}

const STYLE = `
:root { color-scheme: light dark; --bg: #fafaf7; --fg: #1c1f24; --muted: #5a616b; --line: #d5d8dc; --head: #eef0f2; --mark: #1d5fa8; }
@media (prefers-color-scheme: dark) { :root { --bg: #15181c; --fg: #e6e8eb; --muted: #9aa3ad; --line: #343a42; --head: #1f242a; --mark: #7fb3ee; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 56rem; margin: 0 auto; padding: 1.25rem 1rem 3rem; }
h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; border-top: 1px solid var(--line); padding-top: 1.25rem; }
p, li { max-width: 46rem; }
.lead { color: var(--muted); }
.verdict strong { color: var(--mark); }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; font-variant-numeric: tabular-nums; }
caption { text-align: left; font-weight: 600; padding-bottom: .4rem; }
th, td { border: 1px solid var(--line); padding: .4rem .55rem; text-align: left; vertical-align: top; }
thead th { background: var(--head); }
tbody th { font-weight: 500; color: var(--muted); }
dt { font-weight: 600; }
dd { margin: 0 0 .5rem 0; }
.scroll { overflow-x: auto; max-width: 100%; }
td.num { white-space: nowrap; overflow-wrap: normal; }
@media (max-width: 40rem) { body { font-size: 15px; } th, td { padding: .3rem .35rem; font-size: .85rem; } th { overflow-wrap: anywhere; } td { overflow-wrap: break-word; } }
`;

const LEAD =
  "How to read this: each question below compares up to three methods (the current LLM, a simple keyword rule, and Jev), as many as the file holds. " +
  "A person marks answers accepted or rejected; unmarked answers and missing costs are listed as gaps. " +
  "More accepted answers is better; a lower cost per accepted result is cheaper. " +
  "The verdict says whether this test set is enough to switch from the LLM to Jev.";

const WORDS: ReadonlyArray<readonly [string, string]> = [
  ["Accepted", "Answers a person marked correct. Unlabelled answers count as neither accepted nor rejected."],
  [
    "Cost per accepted result",
    "Spend divided by accepted answers. All-answers spend includes rows with no label; the verdict comparison uses only cases where both Jev and the LLM have a label, so the two LLM figures can differ.",
  ],
  ["incomplete", "At least one answer has no recorded cost, so there is no true total and no cost per accepted result. It is never shown as $0."],
  ["undefined", "The method has 0 accepted answers, so there is nothing to divide by."],
  ["95% interval", "The range the true value is likely to sit in, given only this test set; a narrow range means more evidence."],
  ["Cost ratio", "Jev's cost per accepted answer divided by the LLM's: below 1 means Jev is cheaper, 0.80 means 20% cheaper."],
  ["not enough evidence", "The rules could not establish either use Jev or don't use Jev from this test set; too few cases or missing data are the usual reasons."],
];

/** Limitations that hold for any records file. */
const LIMITS: readonly string[] = [
  "The verdict rules need at least 30 paired labelled cases per question before they will say use Jev or don't use Jev.",
  "Labels and costs are shown as recorded in the file; this page does not check how they were produced.",
  "The verdict is evidence from this test set only, not production.",
];

/** Limitations of the d06-tiny fixture (examples/d06-tiny/expected.md "What is real and what is invented"). */
const D06_LIMITS: readonly string[] = [
  "The data is synthetic: five fictional CVs checked against a fictional job ad. No real person is described.",
  "Each question has at most 5 paired cases; the verdict rules need at least 30 before they will say use Jev or don't use Jev.",
  "The Jev and LLM answers, tokens and costs are invented round numbers ($0.00002 per Jev call, $0.002 per LLM call); no model was called. The keyword rule answers are real.",
  "Two gaps are planted on purpose: one LLM answer has no label, and one rule answer has no cost.",
  "The verdict is evidence from this test set only, not production.",
];

function isD06(source: string): boolean {
  return source === D06_SOURCE;
}

/**
 * The result view for one records CSV, as one HTML document with inline CSS and no scripts.
 * `source` is the file's repo-relative path (never an absolute one); the d06 limitations show only when it is
 * exactly D06_SOURCE, which is what the CLI passes.
 */
export async function renderResultView(csvText: string, source: string): Promise<string> {
  const result = validate(csvText);
  if (result.errors.length > 0) throw new Error(`records file is invalid:\n${result.errors.join("\n")}`);
  const seed = await fileSeed(csvText);
  const keys = cohorts(result.rows);
  const sections = keys.map((key) => {
    const metrics = cohortMetrics(result.rows, key);
    const shared = keys.some((other) => other !== key && other.questionId === key.questionId);
    return questionSection(metrics, cohortRows(result.rows, key), verdict(metrics, seed), shared);
  });
  const d06 = isD06(source);
  const sourceLine = d06
    ? `Source: ${source}, worked by hand in examples/d06-tiny/expected.md.`
    : `Source: ${source}.`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    tag("title", `Jev!Jev result view: ${escape(source)}`),
    tag("style", STYLE),
    "</head>",
    "<body><main>",
    tag("h1", `Current LLM, keyword rule and Jev on the same ${d06 ? "CV questions" : "questions"}`),
    `<p class="lead">${escape(LEAD)}</p>`,
    tag("h2", "Words used in the tables"),
    "<dl>",
    ...WORDS.map(([word, meaning]) => `${tag("dt", escape(word))}${tag("dd", escape(meaning))}`),
    "</dl>",
    ...sections,
    "<section>",
    tag("h2", "Whole file, per method"),
    armTable("file", wholeFile(result.rows), result.rows, "Every question together"),
    "</section>",
    "<section>",
    tag("h2", "Limitations"),
    "<ul>",
    ...(d06 ? D06_LIMITS : LIMITS).map((limit) => tag("li", escape(limit))),
    "</ul>",
    tag("p", `${escape(sourceLine)} Numbers from src/core/metrics.ts and src/core/verdict.ts.`),
    "</section>",
    "</main></body>",
    "</html>",
    "",
  ].join("\n");
}

if (import.meta.main) {
  // Fixed input and output, both under the repo root: there are no paths to get wrong.
  if (process.argv.length > 2) {
    console.error("usage: bun scripts/result-view.ts (no arguments; writes site/result-d06.html from examples/d06-tiny/records.csv)");
    process.exit(2);
  }
  const repo = resolve(import.meta.dir, "..");
  const output = resolve(repo, OUTPUT);
  try {
    const page = await renderResultView(decodeUtf8(readFileSync(resolve(repo, D06_SOURCE))), D06_SOURCE);
    writeFileSync(output, page);
    console.log(`wrote ${OUTPUT}`);
  } catch (error) {
    console.error(`${D06_SOURCE}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
