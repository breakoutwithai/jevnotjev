// Builds the public Stage's sample (site/data.js) from the recorded UC13 shop-bot run: 40 messages we wrote about a
// made-up shop, answered by the LLM, a keyword rule and Jev, labelled, with the verdict the written rules give.
// Every message, answer, label, cost, confidence and latency comes from records.csv; the verdict from src/core.
// The earlier sample (a Haiku/Sonnet/Opus prompt router) is gone: that premise was dropped on 2026-09-28.
//
//   bun scripts/stage-sample.ts           write site/data.js
//   bun scripts/stage-sample.ts --check   exit 1 if the committed file differs from what the run gives

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileSeed } from "../src/core/calc.ts";
import { groupCohorts, metricsOfCohortRows, type Arm } from "../src/core/metrics.ts";
import { verdict } from "../src/core/verdict.ts";
import { validate, type Row } from "../src/format/validate.ts";

const ROOT = join(import.meta.dir, "..");
export const RECORDS_REL = "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv";
export const SAMPLE_RECORDS = join(ROOT, RECORDS_REL);
export const SAMPLE_OUT = join(ROOT, "site", "data.js");

export type Letter = "A" | "B" | "C";

/** The page's three players: A is the llm, B the rule, C Jev. */
const LETTER: Readonly<Record<Arm, Letter>> = { llm: "A", rule: "B", jev: "C" };
const LETTERS: readonly Letter[] = ["A", "B", "C"];

export interface StageCase {
  readonly id: string;
  /** The customer message. */
  readonly prompt: string;
  /** The label's answer: the output of an accepted row, or the other answer for a rejected one. */
  readonly truth: string;
  readonly arms: Readonly<Record<Letter, { readonly picked: string; readonly cost: number; readonly label: "accept" | "reject"; readonly confidence?: number }>>;
}
export interface StageSample {
  readonly meta: {
    readonly note: string;
    readonly workflow: string;
    readonly source: string;
    readonly run_id: string;
    readonly arms: Readonly<Record<Letter, string>>;
    readonly outputs: readonly string[];
  };
  readonly cases: readonly StageCase[];
  readonly summary: Readonly<Record<Letter, { readonly spend: number; readonly kept: number; readonly cpk: number | null }>>;
  readonly jev_vs: { readonly A: { readonly wins: number; readonly losses: number }; readonly B: { readonly wins: number; readonly losses: number } };
  readonly verdict: { readonly result: string; readonly rule: number; readonly reason: string };
  readonly timing: { readonly note: string; readonly median_ms: Readonly<Record<Letter, number>> };
  readonly use_cases: readonly (readonly string[])[];
  readonly ask_examples: readonly Readonly<Record<string, string>>[];
}

const USE_CASES: readonly (readonly string[])[] = [
  ["UC1", "Scope guard", "Does the change stay within the request?"],
  ["UC2", "Check-failure triage", "This change, dependency, flaky or config?"],
  ["UC3", "Evidence grader", "Verified, inferred or unverified?"],
  ["UC4", "Autonomy gate", "Continue alone or ask the operator?"],
  ["UC5", "Repeat-question detector", "Asked before?"],
  ["UC6", "Request completeness", "Complete or missing a field?"],
  ["UC7", "Client message routing", "Data, question, change or other?"],
  ["UC8", "PR description check", "Matches, overstates or understates?"],
  ["UC9", "Website slop roast", "Ten slop checks, scored by code"],
  ["UC10", "Tech stack choice", "Which properties does the project need?"],
];

const ASK_EXAMPLES: readonly Readonly<Record<string, string>>[] = [
  { q: "Should I use Jev to write my blog posts?", mark: "Jev probably not", why: "Open writing has no fixed answers", instead: "Is this draft ready to publish? yes / no" },
  { q: "Should I use Jev to route support tickets?", mark: "Jev could help", why: "Fixed categories, text in, volume", rule: "keyword list" },
  { q: "Should I use Jev to decide if my agent should continue?", mark: "Jev could help", why: "Two answers, every turn, cheap", rule: "list of outward actions" },
];

function str(row: Row, column: string): string {
  const v = row.get(column);
  if (typeof v !== "string") throw new Error(`${column} is not text on a row`);
  return v;
}

function num(row: Row, column: string): number {
  const v = row.get(column);
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new Error(`${column} is not a number on case ${str(row, "case_id")}`);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const hi = s[mid];
  const lo = s[mid - 1];
  if (hi === undefined) throw new Error("no latencies");
  return s.length % 2 === 1 || lo === undefined ? hi : (lo + hi) / 2;
}

function isArm(v: string): v is Arm {
  return v === "llm" || v === "rule" || v === "jev";
}

/** The sample from a validated run file's text. Throws when the file is invalid, holds more than one question, or lacks a label or cost. */
export async function buildSample(csv: string): Promise<StageSample> {
  const result = validate(csv);
  if (result.errors.length > 0) throw new Error(`records.csv is invalid: ${result.errors[0]}`);
  const groups = groupCohorts(result.rows);
  const group = groups[0];
  if (groups.length !== 1 || group === undefined) throw new Error(`the sample is one question; the file has ${groups.length}`);

  const byCase = new Map<string, Map<Letter, Row>>();
  for (const row of group.rows) {
    const arm = str(row, "answerer");
    if (!isArm(arm)) continue;
    const id = str(row, "case_id");
    const m = byCase.get(id) ?? new Map<Letter, Row>();
    m.set(LETTER[arm], row);
    byCase.set(id, m);
  }

  const first = group.rows[0];
  if (first === undefined) throw new Error("the sample has no rows");
  const answers = str(first, "answer_set").split("|");
  const cases: StageCase[] = [];
  for (const [id, m] of byCase) {
    const a = m.get("A");
    const b = m.get("B");
    const c = m.get("C");
    if (a === undefined || b === undefined || c === undefined) throw new Error(`case ${id} lacks a method`);
    const cell = (row: Row): StageCase["arms"]["A"] => {
      const label = str(row, "label");
      if (label !== "accept" && label !== "reject") throw new Error(`case ${id}: no label`);
      const confidence = row.get("confidence");
      return { picked: str(row, "output"), cost: num(row, "cost_usd"), label, ...(typeof confidence === "number" ? { confidence } : {}) };
    };
    const arms = { A: cell(a), B: cell(b), C: cell(c) };
    const truth = arms.A.label === "accept" ? arms.A.picked : (answers.find((x) => x !== arms.A.picked) ?? "");
    cases.push({ id, prompt: str(a, "case_input"), truth, arms });
  }

  const total = (k: Letter): { spend: number; kept: number; cpk: number | null } => {
    const spend = cases.reduce((sum, c) => sum + c.arms[k].cost, 0);
    const kept = cases.filter((c) => c.arms[k].label === "accept").length;
    return { spend: round(spend, 8), kept, cpk: kept === 0 ? null : round(spend / kept, 8) };
  };
  const summary = { A: total("A"), B: total("B"), C: total("C") };
  const vs = (other: Letter): { wins: number; losses: number } => ({
    wins: cases.filter((c) => c.arms.C.label === "accept" && c.arms[other].label === "reject").length,
    losses: cases.filter((c) => c.arms.C.label === "reject" && c.arms[other].label === "accept").length,
  });

  const v = verdict(metricsOfCohortRows(group.rows, group.key), await fileSeed(csv));
  const latency = (arm: Arm): number => median(group.rows.filter((r) => str(r, "answerer") === arm).map((r) => num(r, "latency_ms")));
  const medians = { A: latency("llm"), B: latency("rule"), C: latency("jev") };
  const runId = group.key.runId;
  return {
    meta: {
      note: `Sample run, recorded and not invented: ${cases.length} messages we wrote about a made-up shop (${runId}). Labels drafted from the fact sheet by three AI labellers who never saw an arm's answer to any message, then reviewed and approved by a person.`,
      workflow: "Can the shop bot answer this customer message from its fact sheet, or must it hand off to staff?",
      source: RECORDS_REL,
      run_id: runId,
      arms: {
        A: "What you do now (an LLM answers each message from the fact sheet)",
        B: "A simple rule (a keyword list sends stock, booking, policy and safety words to staff)",
        C: "Jev decides (reads each message and picks answer or hand off, with a confidence)",
      },
      outputs: answers,
    },
    cases,
    summary,
    jev_vs: { A: vs("A"), B: vs("B") },
    verdict: { result: v.verdict, rule: v.rule, reason: v.reason },
    timing: { note: "Median time per call. The LLM figure includes the start-up of the command that called it.", median_ms: medians },
    use_cases: USE_CASES,
    ask_examples: ASK_EXAMPLES,
  };
}

const HEADER = `/*
 * GENERATED by scripts/stage-sample.ts from ${RECORDS_REL}. Do not edit; rerun the script.
 * The Stage's sample: a recorded, labelled run (shop bot: answer or hand off), not made-up numbers.
 */
`;

export function sampleScript(sample: StageSample): string {
  return `${HEADER}window.JNJ = ${JSON.stringify(sample, null, 1)};\n`;
}

export async function build(): Promise<string> {
  return sampleScript(await buildSample(await readFile(SAMPLE_RECORDS, "utf8")));
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("usage: bun scripts/stage-sample.ts [--check]");
    process.exit(2);
  }
  const built = await build();
  if (args[0] === "--check") {
    const same = (await readFile(SAMPLE_OUT, "utf8").catch(() => "")) === built;
    console.log(same ? "site/data.js up to date" : "stale: site/data.js; run bun scripts/stage-sample.ts");
    process.exit(same ? 0 : 1);
  }
  await writeFile(SAMPLE_OUT, built);
  console.log(`wrote site/data.js (${built.length} bytes)`);
}
