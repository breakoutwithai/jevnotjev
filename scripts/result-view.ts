// D09 result view: one self-contained HTML page comparing the current LLM, the keyword rule and Jev.
// Every number comes from src/core (metrics and verdict) over the validated file; this script only lays them out.
// Run: bun scripts/result-view.ts examples/d06-tiny/records.csv site/result-d06.html

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { decodeUtf8, validate, type ParsedRow } from "../src/format/validate.ts";
import { fileSeed } from "../src/core/calc.ts";
import {
  ARMS,
  cohortMetrics,
  cohorts,
  describeCostPerAccepted,
  describeSpend,
  type Arm,
  type ArmTotals,
  type CohortKey,
  type CohortMetrics,
  type PairArm,
} from "../src/core/metrics.ts";
import { verdict, type RuleComparison, type Verdict } from "../src/core/verdict.ts";

const NAMES: Readonly<Record<Arm, string>> = { llm: "Current LLM", rule: "Simple keyword rule", jev: "Jev" };
const WHOLE_FILE = "whole file";
/** The hand-worked fixture; its own limitations are shown only for this source. */
export const D06_SOURCE = "examples/d06-tiny/records.csv";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** One element wrapping already-escaped HTML. */
function tag(name: string, inner: string): string {
  return `<${name}>${inner}</${name}>`;
}

function td(key: string, value: string): string {
  return `<td data-cell="${escape(key)}">${escape(value)}</td>`;
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

/** Gap counts from src/core, with the CSV lines behind them (R8.a, R8.b). */
function gaps(totals: ArmTotals, rows: readonly ParsedRow[]): string {
  const mine = rows.filter((row) => field(row, "answerer") === totals.arm);
  const unlabelled = mine.filter((row) => row.values.get("label") === null).map((row) => row.line);
  const noCost = mine.filter((row) => row.values.get("cost_usd") === null).map((row) => row.line);
  const parts: string[] = [];
  if (totals.unlabelled > 0) parts.push(`${totals.unlabelled} unlabelled (${lineList(unlabelled)})`);
  if (totals.spend.kind === "incomplete") parts.push(`${totals.spend.missing} cost missing (${lineList(noCost)})`);
  return parts.length === 0 ? "none" : parts.join(", ");
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
    `<table>${tag("caption", caption)}`,
    `<thead><tr><th scope="col"></th>${head}</tr></thead><tbody>`,
    line("Answers", "rows", (totals) => String(totals.rows)),
    line("Labelled by a person", "labelled", (totals) => String(totals.labelled)),
    line("Accepted", "accepted", (totals) => String(totals.accepted)),
    line("Gaps", "gaps", (totals) => gaps(totals, rows)),
    line("Spend", "spend", (totals) => describeSpend(totals.spend)),
    line("Cost per accepted result", "cpa", (totals) => describeCostPerAccepted(totals.costPerAccepted)),
    "</tbody></table>",
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
    `<table>${tag("caption", caption)}`,
    `<thead><tr><th scope="col"></th><th scope="col">${NAMES.llm}</th><th scope="col">${NAMES.jev}</th></tr></thead><tbody>`,
    line("Accepted", "accepted", (side) => String(side.accepted)),
    line("Spend", "spend", (side) => describeSpend(side.spend)),
    line("Cost per accepted result", "cpa", (side) => describeCostPerAccepted(side.costPerAccepted)),
    "</tbody></table>",
  ].join("\n");
}

function ruleLine(rule: RuleComparison): string {
  if (rule.kind === "skipped") return `skipped: ${rule.reason} (${rule.paired} paired)`;
  return `compared on ${rule.n} paired cases: rule minus Jev ${rule.diff.toFixed(2)} (95% interval ${rule.lower.toFixed(2)} to ${rule.upper.toFixed(2)})`;
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
@media (max-width: 40rem) { body { font-size: 15px; } th, td { padding: .3rem .35rem; font-size: .85rem; overflow-wrap: anywhere; } }
`;

const LEAD =
  "How to read this: each question below was answered by three methods (the current LLM, a simple keyword rule, and Jev). " +
  "A person then marked each answer accepted or rejected. More accepted answers is better; a lower cost per accepted result is cheaper. " +
  "The verdict says whether this test set is enough to switch from the LLM to Jev.";

const WORDS: ReadonlyArray<readonly [string, string]> = [
  ["Accepted", "Answers a person marked correct. Unlabelled answers count as neither accepted nor rejected."],
  ["Cost per accepted result", "Spend divided by accepted answers."],
  ["incomplete", "At least one answer has no recorded cost, so there is no true total and no cost per accepted result. It is never shown as $0."],
  ["undefined", "The method has 0 accepted answers, so there is nothing to divide by."],
  ["not enough evidence", "The test set is too small or too incomplete to say either use Jev or don't use Jev."],
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
  const path = source.replaceAll("\\", "/");
  return path === D06_SOURCE || path.endsWith(`/${D06_SOURCE}`);
}

/**
 * The result view for one records CSV, as one HTML document with inline CSS and no scripts.
 * `source` is the file's name as the page should show it (a repo-relative path, never an absolute one).
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
    tag("h1", "Current LLM, keyword rule and Jev on the same CV questions"),
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
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined) {
    console.error("usage: bun scripts/result-view.ts <records.csv> <out.html>");
    process.exit(2);
  }
  // The page names its source relative to the working directory, never by an absolute path.
  const source = relative(process.cwd(), resolve(input)).split(sep).join("/");
  try {
    const page = await renderResultView(decodeUtf8(readFileSync(input)), source);
    writeFileSync(output, page);
    console.log(`wrote ${output}`);
  } catch (error) {
    console.error(`${input}: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
