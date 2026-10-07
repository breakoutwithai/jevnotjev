import { renderPage } from "./run-arms.ts";
// Builds the stage-door demo data (site/uc13-demo.js) and the live labelling page (site/label/index.html) from the
// recorded UC13 run. Nothing is typed by hand: every answer, count and cost comes from records.csv.
//
//   bun scripts/uc13/stage-demo.ts           write both files
//   bun scripts/uc13/stage-demo.ts --check   exit 1 if either committed file differs from what the run gives
//
// Labels: while every row's `label` is empty the demo is "pending" (each verdict reads pending). Once
// `bun scripts/uc13/run-arms.ts label` has merged labels.csv, rerun this script: a labelled row is accept when its
// output equals the human answer, and the tally adds accepts and misses per arm. No code change is needed.

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ANSWERS, type Answer, CASE_IDS, type Case, type Column, PROMPT_VERSION, QUESTION, QUESTION_ID, RUN_ID, type RecordRow, loadExample,
  parseRecords,
} from "./arms.ts";
import { rankJevOptions } from "../../src/labels/rank.ts";

const ROOT = join(import.meta.dir, "..", "..");
export const RUN_DIR = join(ROOT, "docs", "product", "runs", "2026-10-01-uc13-shop-bot");
export const EXAMPLE_DIR = join(ROOT, "examples", "uc13-shop-bot");
export const RECORDS_REL = "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv";
export const DEMO_OUT = join(ROOT, "site", "uc13-demo.js");
export const LABEL_OUT = join(ROOT, "site", "label", "index.html");
/** One file per case, fetched by the label page only after that case's blind pick (labelling loop M2). */
export const SUGGESTIONS_OUT = join(ROOT, "site", "label", "suggestions");

function prop(o: unknown, k: string): unknown {
  return typeof o === "object" && o !== null && !Array.isArray(o) ? Reflect.get(o, k) : undefined;
}

/**
 * Each case's suggestion from the recorded run, 0 new calls: Jev's recorded choice (records.csv) with its recorded
 * per-option probabilities (raw.json), ranked by rankJevOptions. The two sources must agree on the choice.
 */
export function buildSuggestions(rows: readonly RecordRow[], raw: unknown): Map<string, string> {
  const calls = prop(raw, "calls");
  if (!Array.isArray(calls)) throw new Error("raw.json: no calls list");
  const out = new Map<string, string>();
  for (const id of CASE_IDS) {
    const row = rows.find((r) => r.case_id === id && r.answerer === "jev");
    const call: unknown = calls.find((c) => prop(c, "case_id") === id && prop(c, "arm") === "jev");
    if (row === undefined || call === undefined) throw new Error(`${id}: no recorded Jev answer in records.csv and raw.json`);
    if (prop(call, "choice") !== row.output) throw new Error(`${id}: raw.json Jev choice differs from records.csv output`);
    const p = prop(call, "probabilities");
    const probabilities: Record<string, number> = {};
    for (const option of ANSWERS) {
      const v = prop(p, option);
      if (typeof v === "number") probabilities[option] = v;
    }
    const confidence = row.confidence === "" ? null : Number(row.confidence);
    const ranking = rankJevOptions(ANSWERS, {
      choice: row.output,
      confidence,
      probabilities: Object.keys(probabilities).length === ANSWERS.length ? probabilities : null,
    });
    const file = { schema: "jnj-uc13-suggestion/1", case_id: id, model: row.answerer_model, choice: row.output, ...ranking };
    out.set(id, `${JSON.stringify(file, null, 2)}\n`);
  }
  return out;
}

/**
 * The 8 messages the demo plays, in order. Chosen for coverage, not outcome: all arms agree (m03, m10, m37),
 * a rule word on a message the sheet answers (m25 avalanche kit price, m28 drop-off cutoff), no rule word on a
 * message the sheet does not cover (m02 helmets), and the two Jev / LLM disagreements (m33, m35).
 */
export const DEMO_IDS: readonly string[] = ["m03", "m10", "m25", "m02", "m37", "m28", "m33", "m35"];

export const ARMS: readonly { readonly key: string; readonly name: string }[] = [
  { key: "llm", name: "What you do now" },
  { key: "rule", name: "A simple rule" },
  { key: "jev", name: "Jev decides" },
];

export type Verdict = "accept" | "reject" | "pending";
export interface ArmOutput { readonly output: Answer; readonly verdict: Verdict }
export interface DemoMessage {
  readonly id: string;
  readonly text: string;
  readonly label: Answer | null;
  readonly outputs: Readonly<Record<string, ArmOutput>>;
}
export interface ArmTally {
  readonly answer: number;
  readonly hand_off: number;
  /** null when any row's cost is blank: unmeasured spend, shown as n/a. */
  readonly cost_usd: number | null;
  readonly labelled: number;
  readonly accept: number | null;
  readonly answered_should_hand_off: number | null;
  readonly handed_off_could_answer: number | null;
}
export interface DemoData {
  readonly schema: "jnj-uc13-demo/1";
  readonly mode: "pending" | "labelled";
  readonly note: string;
  readonly source: string;
  readonly cases_total: number;
  readonly fact_sheet: { readonly title: string; readonly lines: readonly string[] };
  readonly arms: readonly { readonly key: string; readonly name: string; readonly model: string }[];
  readonly messages: readonly DemoMessage[];
  readonly tally: Readonly<Record<string, ArmTally>>;
  readonly label_page: string;
}

function isAnswer(v: string): v is Answer {
  return v === "answer" || v === "hand_off";
}

function other(a: Answer): Answer {
  return a === "answer" ? "hand_off" : "answer";
}

/** A row's verdict and the human answer it implies. `label` is accept / reject (run-arms.ts label) or the answer itself. */
export function judge(row: RecordRow): { verdict: Verdict; truth: Answer | null } {
  if (!isAnswer(row.output)) throw new Error(`${row.answerer} ${row.case_id}: output ${JSON.stringify(row.output)} is not one of ${ANSWERS.join(", ")}`);
  const l = row.label;
  // An unreviewed agent label is not truth (format/README.md "Label provenance"): the row waits for a person.
  if (l === "" || row.label_source === "agent") return { verdict: "pending", truth: null };
  if (l === "accept") return { verdict: "accept", truth: row.output };
  if (l === "reject") return { verdict: "reject", truth: other(row.output) };
  if (isAnswer(l)) return { verdict: row.output === l ? "accept" : "reject", truth: l };
  throw new Error(`${row.answerer} ${row.case_id}: label ${JSON.stringify(l)} is not accept, reject, answer or hand_off`);
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

/** An arm's spend, or null when any row's cost is blank (unmeasured is not free). A malformed cost fails. */
function armCost(rows: readonly RecordRow[]): number | null {
  let sum = 0;
  for (const r of rows) {
    if (r.cost_usd === "") return null;
    const v = Number(r.cost_usd);
    if (!Number.isFinite(v) || v < 0) throw new Error(`${r.answerer} ${r.case_id}: cost_usd ${JSON.stringify(r.cost_usd)} is not a cost`);
    sum += v;
  }
  return round8(sum);
}

export function buildDemo(rows: readonly RecordRow[], factSheet: string, ids: readonly string[] = DEMO_IDS): DemoData {
  const byArm = new Map<string, Map<string, RecordRow>>();
  for (const r of rows) {
    if (!ARMS.some((a) => a.key === r.answerer)) throw new Error(`unknown answerer ${JSON.stringify(r.answerer)} on ${r.case_id}`);
    const m = byArm.get(r.answerer) ?? new Map<string, RecordRow>();
    if (m.has(r.case_id)) throw new Error(`duplicate row ${r.answerer} ${r.case_id}`);
    m.set(r.case_id, r);
    byArm.set(r.answerer, m);
  }
  // One run: every row carries the same run, prompt version, question and answer set.
  const IDENTITY: readonly (readonly [Column, string])[] = [
    ["run_id", RUN_ID], ["prompt_version", PROMPT_VERSION], ["question_id", QUESTION_ID], ["question", QUESTION], ["answer_set", ANSWERS.join("|")],
  ];
  for (const r of rows) {
    for (const [col, want] of IDENTITY) {
      if (r[col] !== want) throw new Error(`${r.answerer} ${r.case_id}: ${col} ${JSON.stringify(r[col])} is not this run's ${JSON.stringify(want)}`);
    }
  }
  // Every arm holds exactly the canonical cases m01 to m40.
  const caseIds = CASE_IDS;
  for (const a of ARMS) {
    const m = byArm.get(a.key) ?? new Map<string, RecordRow>();
    const missing = caseIds.filter((c) => !m.has(c));
    const extra = [...m.keys()].filter((c) => !caseIds.includes(c));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`arm ${a.key}: needs exactly ${caseIds[0]} to ${caseIds[caseIds.length - 1]}; missing [${missing.join(", ")}], extra [${extra.join(", ")}]`);
    }
  }

  /** One human answer per case, the same whichever arm's row it is read from. */
  const truthOf = (caseId: string): Answer | null => {
    // An unreviewed agent label states no human answer, so it neither sets nor contradicts the reviewed one.
    const reviewed = ARMS.map((a) => rowOf(a.key, caseId)).filter((r) => r.label_source !== "agent");
    const seen = new Set(reviewed.map((r) => judge(r).truth));
    if (seen.size > 1) throw new Error(`${caseId}: arms imply different human answers (${[...seen].join(", ")})`);
    return [...seen][0] ?? null;
  };
  function rowOf(arm: string, caseId: string): RecordRow {
    const r = byArm.get(arm)?.get(caseId);
    if (!r) throw new Error(`no ${arm} row for ${caseId}`);
    return r;
  }

  // The human answer must agree across arms for all 40 cases, not only the ones shown.
  const truths = new Map(caseIds.map((c) => [c, truthOf(c)]));

  const messages = ids.map((id): DemoMessage => {
    const outputs: Record<string, ArmOutput> = {};
    for (const a of ARMS) {
      const r = rowOf(a.key, id);
      const { verdict } = judge(r);
      outputs[a.key] = { output: isAnswer(r.output) ? r.output : "answer", verdict };
    }
    return { id, text: rowOf("rule", id).case_input, label: truths.get(id) ?? null, outputs };
  });

  const tally: Record<string, ArmTally> = {};
  let anyLabel = false;
  for (const a of ARMS) {
    const armRows = caseIds.map((c) => rowOf(a.key, c));
    const judged = armRows.map((r) => ({ r, ...judge(r) }));
    const labelled = judged.filter((j) => j.verdict !== "pending");
    if (labelled.length > 0) anyLabel = true;
    const has = labelled.length > 0;
    tally[a.key] = {
      answer: armRows.filter((r) => r.output === "answer").length,
      hand_off: armRows.filter((r) => r.output === "hand_off").length,
      cost_usd: armCost(armRows),
      labelled: labelled.length,
      accept: has ? labelled.filter((j) => j.verdict === "accept").length : null,
      answered_should_hand_off: has ? labelled.filter((j) => j.verdict === "reject" && j.r.output === "answer").length : null,
      handed_off_could_answer: has ? labelled.filter((j) => j.verdict === "reject" && j.r.output === "hand_off").length : null,
    };
  }

  const models = (key: string): string => [...new Set(caseIds.map((c) => rowOf(key, c).answerer_model))].join(", ");
  const runId = rows[0]?.run_id ?? "";
  const n = caseIds.length;
  const note = anyLabel
    ? `Recorded run, not sample data: ${n} messages we wrote about a made-up shop (${runId}). Labels drafted from the fact sheet by three AI labellers who never saw an arm's answer to any message, then reviewed and approved by a person.`
    : `Recorded run, not sample data: ${n} messages we wrote about a made-up shop (${runId}). Labels pending: no message has a human answer yet, so every accept or reject slot waits.`;
  return {
    schema: "jnj-uc13-demo/1",
    mode: anyLabel ? "labelled" : "pending",
    note,
    source: RECORDS_REL,
    cases_total: n,
    fact_sheet: { title: "The fact sheet the bot works from", lines: factSheet.split("\n").map((l) => l.trim()).filter((l) => l !== "") },
    arms: ARMS.map((a) => ({ key: a.key, name: a.name, model: models(a.key) })),
    messages,
    tally,
    label_page: "label/",
  };
}

const HEADER = `/*
 * GENERATED by scripts/uc13/stage-demo.ts from ${RECORDS_REL}. Do not edit; rerun the script.
 * Stage-door demo data. The UI (stage-door.js) reads only this shape:
 *
 * window.UC13_DEMO = {
 *   schema: "jnj-uc13-demo/1",
 *   mode: "sample" | "pending" | "labelled",
 *   note: string,                         shown under the demo title
 *   source: string,                       where the rows came from
 *   cases_total: number,                  messages in the full run
 *   fact_sheet: { title: string, lines: string[] },
 *   arms: [{ key: string, name: string, model: string }],
 *   messages: [{ id: string, text: string, label: "answer" | "hand_off" | null,
 *                outputs: { [arm key]: { output: "answer" | "hand_off", verdict: "accept" | "reject" | "pending" } } }],
 *   tally: { [arm key]: { answer: number, hand_off: number, cost_usd: number, labelled: number,
 *            accept: number | null, answered_should_hand_off: number | null, handed_off_could_answer: number | null } },
 *   label_page: string | null             link for "label these yourself", or null
 * };
 */
`;
const PREFIX = "window.UC13_DEMO = ";

export function demoScript(d: DemoData): string {
  return `${HEADER}${PREFIX}${JSON.stringify(d, null, 1)};\n`;
}

/** Reads the data object back out of a generated demo script. */
export function readDemoScript(js: string): unknown {
  const at = js.lastIndexOf(`\n${PREFIX}`) + 1;
  if (at === 0) throw new Error("no window.UC13_DEMO assignment");
  return JSON.parse(js.slice(at + PREFIX.length).trim().replace(/;$/, ""));
}

const BACK = '<p class="muted"><a href="../">Back to the stage</a></p>\n';

/**
 * The run's labelling page, served from site/label/ with a link back to the stage. It downloads labels.csv and reads one
 * file from suggestions/, the picked case's, only after its blind pick.
 */
export function labelPage(runLabelHtml: string): string {
  if (!runLabelHtml.includes("<main>\n")) throw new Error("label.html has no <main> line to anchor the back link");
  return runLabelHtml.replace("<main>\n", `<main>\n${BACK}`);
}

export interface Built {
  readonly demo: string;
  readonly label: string;
  /** suggestions/<case_id>.json text by case id. */
  readonly suggestions: ReadonlyMap<string, string>;
}

function isCase(v: unknown): v is Case {
  return typeof v === "object" && v !== null && typeof Reflect.get(v, "case_id") === "string" && typeof Reflect.get(v, "case_input") === "string";
}

/**
 * The inputs recorded with the run: the fact sheet and messages embedded in the run's label.html when it was
 * rendered. The demo reads these, the same snapshot the label page shows, never today's examples/ files.
 */
export function recordedInputs(labelHtml: string): { factSheet: string; cases: Case[] } {
  const sheet = /^const SHEET = (.*);$/m.exec(labelHtml)?.[1];
  const cases = /^const CASES = (.*);$/m.exec(labelHtml)?.[1];
  if (sheet === undefined || cases === undefined) throw new Error("label.html: no SHEET or CASES line to read the recorded inputs from");
  const parsedSheet: unknown = JSON.parse(sheet);
  const parsedCases: unknown = JSON.parse(cases);
  if (typeof parsedSheet !== "string" || !Array.isArray(parsedCases) || !parsedCases.every(isCase)) {
    throw new Error("label.html: SHEET is not text or CASES is not a list of {case_id, case_input}");
  }
  return { factSheet: parsedSheet, cases: parsedCases };
}

/** The recorded inputs, the records and today's examples/ must all describe the same 40 messages and fact sheet. */
export function checkInputs(recorded: { factSheet: string; cases: readonly Case[] }, example: { factSheet: string; cases: readonly Case[] }, rows: readonly RecordRow[]): void {
  const ids = recorded.cases.map((c) => c.case_id);
  if (ids.length !== CASE_IDS.length || ids.some((id, i) => id !== CASE_IDS[i])) {
    throw new Error(`label.html: its messages are [${ids.join(", ")}], not exactly ${CASE_IDS[0]} to ${CASE_IDS[CASE_IDS.length - 1]}`);
  }
  if (example.factSheet !== recorded.factSheet) throw new Error("examples/ fact sheet differs from the one recorded with the run (label.html)");
  const exampleText = new Map(example.cases.map((c) => [c.case_id, c.case_input]));
  for (const c of recorded.cases) {
    if (exampleText.get(c.case_id) !== c.case_input) throw new Error(`examples/ cases.jsonl ${c.case_id} differs from the message recorded with the run`);
    for (const r of rows) {
      if (r.case_id === c.case_id && r.case_input !== c.case_input) throw new Error(`records.csv ${r.answerer} ${c.case_id}: case_input differs from the message recorded with the run`);
    }
  }
}

export async function build(runDir = RUN_DIR, exampleDir = EXAMPLE_DIR): Promise<Built> {
  const rows = parseRecords(await Bun.file(join(runDir, "records.csv")).text());
  const html = await Bun.file(join(runDir, "label.html")).text();
  const recorded = recordedInputs(html);
  checkInputs(recorded, await loadExample(exampleDir), rows);
  const template = await Bun.file(join(exampleDir, "label.template.html")).text();
  const raw: unknown = JSON.parse(await Bun.file(join(runDir, "raw.json")).text());
  return {
    demo: demoScript(buildDemo(rows, recorded.factSheet)),
    label: labelPage(renderPage(template, recorded.factSheet, recorded.cases)),
    suggestions: buildSuggestions(rows, raw),
  };
}

export const USAGE = "usage: bun scripts/uc13/stage-demo.ts [--check]";

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error(`${USAGE}\nunknown arguments: ${args.join(" ")}; nothing written`);
    process.exit(2);
  }
  const built = await build();
  if (args[0] === "--check") {
    const stale: string[] = [];
    if ((await Bun.file(DEMO_OUT).text().catch(() => "")) !== built.demo) stale.push("site/uc13-demo.js");
    if ((await Bun.file(LABEL_OUT).text().catch(() => "")) !== built.label) stale.push("site/label/index.html");
    const present = await readdir(SUGGESTIONS_OUT).catch(() => []);
    if (present.length !== built.suggestions.size) stale.push("site/label/suggestions/ (file count)");
    for (const [id, text] of built.suggestions) {
      if ((await Bun.file(join(SUGGESTIONS_OUT, `${id}.json`)).text().catch(() => "")) !== text) stale.push(`site/label/suggestions/${id}.json`);
    }
    console.log(stale.length === 0 ? "stage demo up to date" : `stale: ${stale.join(", ")}; run bun scripts/uc13/stage-demo.ts`);
    process.exit(stale.length === 0 ? 0 : 1);
  }
  await Bun.write(DEMO_OUT, built.demo);
  await Bun.write(LABEL_OUT, built.label);
  for (const [id, text] of built.suggestions) await Bun.write(join(SUGGESTIONS_OUT, `${id}.json`), text);
  const d = readDemoScript(built.demo);
  console.log(`wrote site/uc13-demo.js, site/label/index.html and ${built.suggestions.size} suggestion files (${JSON.stringify(d).length} bytes of demo data)`);
}
