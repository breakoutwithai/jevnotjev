// D09 result view: one self-contained HTML page comparing the current LLM, the keyword rule and Jev.
// Every number comes from src/core (metrics and verdict) over the validated file; this script only lays them out.
// Run: bun scripts/result-view.ts examples/d06-tiny/records.csv site/result-d06.html

import { readFileSync, writeFileSync } from "node:fs";
import { validate, type ParsedRow } from "../src/format/validate.ts";
import { fileSeed } from "../src/core/calc.ts";
import {
  ARMS,
  cohortMetrics,
  cohorts,
  describeCostPerAccepted,
  describeSpend,
  type Arm,
  type ArmTotals,
  type CohortMetrics,
  type PairArm,
} from "../src/core/metrics.ts";
import { verdict, type RuleComparison, type Verdict } from "../src/core/verdict.ts";

const NAMES: Readonly<Record<Arm, string>> = { llm: "Current LLM", rule: "Simple keyword rule", jev: "Jev" };
const WHOLE_FILE = "whole file";

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** One element wrapping already-escaped HTML. */
function tag(name: string, inner: string): string {
  return `<${name}>${inner}</${name}>`;
}

function td(key: string, value: string): string {
  return `<td data-cell="${key}">${escape(value)}</td>`;
}

function gaps(totals: ArmTotals): string {
  const parts: string[] = [];
  if (totals.unlabelled > 0) parts.push(`${totals.unlabelled} unlabelled`);
  if (totals.spend.kind === "incomplete") parts.push(`${totals.spend.missing} cost missing`);
  return parts.length === 0 ? "none" : parts.join(", ");
}

/**
 * Every row of the file as one cohort, so src/core totals the whole file per method. The case id carries the
 * question id, so each (case, question) stays one row per method; the paired figures of this cohort are not shown.
 */
function wholeFile(rows: readonly ParsedRow[]): CohortMetrics {
  const merged = rows.map((row): ParsedRow => {
    const values = new Map(row.values);
    values.set("case_id", `${String(row.values.get("case_id"))}/${String(row.values.get("question_id"))}`);
    values.set("question_id", WHOLE_FILE);
    values.set("run_id", WHOLE_FILE);
    values.set("prompt_version", WHOLE_FILE);
    return { ...row, values };
  });
  return cohortMetrics(merged, { runId: WHOLE_FILE, promptVersion: WHOLE_FILE, questionId: WHOLE_FILE });
}

function armTable(scope: string, metrics: CohortMetrics, caption: string): string {
  const arms = ARMS.flatMap((arm) => metrics.arms.filter((totals) => totals.arm === arm));
  const head = arms.map((totals) => `<th scope="col">${NAMES[totals.arm]}</th>`).join("");
  const line = (label: string, field: string, value: (totals: ArmTotals) => string): string =>
    `<tr><th scope="row">${label}</th>${arms.map((totals) => td(`${scope}.${totals.arm}.${field}`, value(totals))).join("")}</tr>`;
  return [
    `<table>${tag("caption", caption)}`,
    `<thead><tr><th scope="col"></th>${head}</tr></thead><tbody>`,
    line("Answers", "rows", (totals) => String(totals.rows)),
    line("Labelled by a person", "labelled", (totals) => String(totals.labelled)),
    line("Accepted", "accepted", (totals) => String(totals.accepted)),
    line("Gaps", "gaps", gaps),
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
  const line = (label: string, field: string, value: (side: PairArm) => string): string =>
    `<tr><th scope="row">${label}</th>${sides.map(([name, side]) => td(`${scope}.vs-llm.${name}.${field}`, value(side))).join("")}</tr>`;
  const caption = `What the verdict compares: Jev and the LLM on the <span data-cell="${scope}.vs-llm.n">${pair.n}</span> cases where both answers have a label`;
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

function questionSection(metrics: CohortMetrics, result: Verdict): string {
  const scope = metrics.key.questionId;
  return [
    "<section>",
    tag("h2", `${escape(scope)}: ${escape(metrics.question)}`),
    `<p class="verdict">Verdict: <strong data-cell="${scope}.verdict">${escape(result.verdict)}</strong></p>`,
    `<p>Why: <span data-cell="${scope}.reason">${escape(result.reason)}</span></p>`,
    `<p>Rule against Jev: <span data-cell="${scope}.rule-comparison">${escape(ruleLine(result.ruleComparison))}</span></p>`,
    armTable(scope, metrics, `All answers to ${escape(scope)}, per method`),
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

const LIMITS: readonly string[] = [
  "The data is synthetic: five fictional CVs checked against a fictional job ad. No real person is described.",
  "Each question has at most 5 paired cases; the verdict rules need at least 30 before they will say use Jev or don't use Jev.",
  "The Jev and LLM answers, tokens and costs are invented round numbers ($0.00002 per Jev call, $0.002 per LLM call); no model was called. The keyword rule answers are real.",
  "Two gaps are planted on purpose: one LLM answer has no label, and one rule answer has no cost.",
  "The verdict is evidence from this test set only, not production.",
];

/** The result view for one records CSV, as one HTML document with inline CSS and no scripts. */
export async function renderResultView(csvText: string): Promise<string> {
  const result = validate(csvText);
  if (result.errors.length > 0) throw new Error(`records file is invalid:\n${result.errors.join("\n")}`);
  const seed = await fileSeed(csvText);
  const sections = cohorts(result.rows).map((key) => {
    const metrics = cohortMetrics(result.rows, key);
    return questionSection(metrics, verdict(metrics, seed));
  });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    tag("title", "Jev!Jev result view: d06-tiny"),
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
    armTable("file", wholeFile(result.rows), "Both questions together"),
    "</section>",
    "<section>",
    tag("h2", "Limitations"),
    "<ul>",
    ...LIMITS.map((limit) => tag("li", escape(limit))),
    "</ul>",
    tag("p", "Source: examples/d06-tiny/records.csv, worked by hand in examples/d06-tiny/expected.md. Numbers from src/core/metrics.ts and src/core/verdict.ts."),
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
  writeFileSync(output, await renderResultView(readFileSync(input, "utf8")));
  console.log(`wrote ${output}`);
}
