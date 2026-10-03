// TokenMax live run: the 5 fictional CVs and 2 questions of examples/d06-tiny, asked of three answerers.
// Pure parts only; scripts/tokenmax/run.ts does the I/O. Labels are never set here: the operator labels blind.
import { createHash } from "node:crypto";
import { readDictRows } from "../../src/format/csv.ts";
import { JEV_MODEL, JEV_PRICE_PER_M, type RecordRow } from "../uc13/arms.ts";

export const RUN_ID = "run-tokenmax-2026-10-03";
export const PROMPT_VERSION = "tokenmax-cv.v1";
export const LLM_MODEL = "haiku";
export type Answer = "yes" | "no";
export const ANSWERS: readonly Answer[] = ["yes", "no"];
export const CASE_IDS: readonly string[] = ["cv1", "cv2", "cv3", "cv4", "cv5"];
export const QUESTION_IDS: readonly string[] = ["q1", "q2"];
/** The same neutral definitions go to Jev and to the LLM. */
export const CRITERIA: Readonly<Record<Answer, string>> = {
  yes: "The CV shows it.",
  no: "The CV does not show it.",
};
/** The keyword rules in examples/d06-tiny/expected.md, matched case-insensitively anywhere in case_input. */
export const RULE_TERMS: Readonly<Record<string, readonly string[]>> = { q1: ["token pot", "pool"], q2: ["dashboard", "meter"] };

/**
 * One dated list-price table for the LLM arm: docs/research/2026-09-29-verdict-minimums/models.md, section 1
 * (Claude Haiku 4.5: input 1, cached read 0.10, output 5 USD per million) and section 4 (cache write 1.25x input for
 * 5 minutes, 2x for 1 hour). Fetched 2026-09-29, re-checked 2026-09-30. Applies to Haiku 4.5 only.
 */
export interface PriceTable {
  readonly source: string; readonly modelPrefix: string; readonly inputPerM: number; readonly cacheReadPerM: number;
  readonly cacheWrite5mPerM: number; readonly cacheWrite1hPerM: number; readonly outputPerM: number;
}
export const LLM_PRICES: PriceTable = {
  source: "docs/research/2026-09-29-verdict-minimums/models.md sections 1 and 4 (fetched 2026-09-29, re-checked 2026-09-30)",
  modelPrefix: "claude-haiku-4-5",
  inputPerM: 1,
  cacheReadPerM: 0.1,
  cacheWrite5mPerM: 1.25,
  cacheWrite1hPerM: 2,
  outputPerM: 5,
};
/** The exact model ids the table prices; `modelPrefix` above is kept as captured in raw.json, not used to match. */
export const LLM_MODEL_IDS: readonly string[] = ["claude-haiku-4-5-20251001"];

/** True when a captured table equals the dated one field for field. */
export function samePriceTable(value: unknown): boolean {
  if (!isObject(value)) return false;
  const want: Readonly<Record<string, string | number>> = { ...LLM_PRICES };
  const keys = Object.keys(value);
  return keys.length === Object.keys(want).length && keys.every((k) => value[k] === want[k]);
}

export interface Case { readonly case_id: string; readonly case_input: string }
export interface Question { readonly question_id: string; readonly question: string }
export interface Inputs { readonly cases: readonly Case[]; readonly questions: readonly Question[] }

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnswer(value: unknown): value is Answer {
  return value === "yes" || value === "no";
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The CVs and questions from examples/d06-tiny/records.csv; only inputs are read, never its outputs or labels. */
export function loadInputs(text: string): Inputs {
  const { header, rows } = readDictRows(text);
  const col = (name: string): number => {
    const i = (header ?? []).indexOf(name);
    if (i < 0) throw new Error(`d06 records.csv has no ${name} column`);
    return i;
  };
  const [ci, ii, qi, qt] = [col("case_id"), col("case_input"), col("question_id"), col("question")];
  const width = (header ?? []).length;
  const cases = new Map<string, string>();
  const questions = new Map<string, string>();
  for (const { fields, line } of rows) {
    if (fields.length !== width) throw new Error(`d06 line ${line}: ${fields.length} fields, expected ${width}`);
    const add = (map: Map<string, string>, id: string, value: string, what: string): void => {
      if (value.trim() === "") throw new Error(`d06 line ${line}: ${what} ${id} is blank`);
      const seen = map.get(id);
      if (seen !== undefined && seen !== value) throw new Error(`d06 line ${line}: ${what} ${id} differs from an earlier row`);
      map.set(id, value);
    };
    add(cases, fields[ci] ?? "", fields[ii] ?? "", "case_input for");
    add(questions, fields[qi] ?? "", fields[qt] ?? "", "question text for");
  }
  const sameSet = (got: Map<string, string>, want: readonly string[]): boolean => got.size === want.length && want.every((id) => got.has(id));
  if (!sameSet(cases, CASE_IDS)) throw new Error(`d06 cases are ${[...cases.keys()].join(",")}, expected ${CASE_IDS.join(",")}`);
  if (!sameSet(questions, QUESTION_IDS)) throw new Error(`d06 questions are ${[...questions.keys()].join(",")}, expected q1,q2`);
  return {
    cases: CASE_IDS.map((case_id) => ({ case_id, case_input: cases.get(case_id) ?? "" })),
    questions: QUESTION_IDS.map((question_id) => ({ question_id, question: questions.get(question_id) ?? "" })),
  };
}

export function ruleModel(q: Question): string {
  const terms = RULE_TERMS[q.question_id];
  if (terms === undefined) throw new Error(`no rule for ${q.question_id}`);
  return `keywords:${terms.join("|")}`;
}

export function ruleOutput(c: Case, q: Question): Answer {
  const terms = RULE_TERMS[q.question_id];
  if (terms === undefined) throw new Error(`no rule for ${q.question_id}`);
  const text = c.case_input.toLowerCase();
  return terms.some((t) => text.includes(t)) ? "yes" : "no";
}

export interface JevBody {
  readonly state: string;
  readonly model: string;
  readonly questions: Readonly<Record<string, { readonly type: "choice"; readonly instructions: { readonly question: string }; readonly criteria: Readonly<Record<Answer, string>> }>>;
}

export function jevBody(c: Case, q: Question): JevBody {
  return {
    state: `CV:\n${c.case_input}`,
    model: JEV_MODEL,
    questions: { [q.question_id]: { type: "choice", instructions: { question: q.question }, criteria: CRITERIA } },
  };
}

export interface LlmRequest { readonly model: string; readonly system: string; readonly user: string }

export function llmRequest(c: Case, q: Question): LlmRequest {
  const system = "You screen a CV against one line of a job ad. Read the CV and answer the question.\n" +
    `Question: ${q.question}\nyes: ${CRITERIA.yes}\nno: ${CRITERIA.no}\nReply with exactly one word: yes or no.`;
  return { model: LLM_MODEL, system, user: `CV: ${c.case_input}` };
}

/** Everything an answer depends on: a fixture is only replayable while this is unchanged. */
export function inputsSha256(inputs: Inputs): string {
  const requests = inputs.cases.flatMap((c) => inputs.questions.map((q) => ({ jev: jevBody(c, q), llm: llmRequest(c, q), rule: ruleModel(q) })));
  return sha256Hex(JSON.stringify({ run_id: RUN_ID, prompt_version: PROMPT_VERSION, cases: inputs.cases, questions: inputs.questions, requests }));
}

export interface Reply {
  readonly choice: Answer;
  readonly model: string;
  readonly confidence: number | null;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

function count(value: unknown, field: string, who: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${who}: ${field} ${JSON.stringify(value)} is not a non-negative integer`);
  return value;
}

function optional(usage: { readonly [key: string]: unknown }, field: string, who: string): number {
  return usage[field] === undefined ? 0 : count(usage[field], `usage.${field}`, who);
}

/** A Jev systemone reply for one question: pinned model, a yes/no choice, a confidence in [0, 1], usage. */
export function parseJev(response: unknown, questionId: string, who: string): Reply {
  if (!isObject(response) || response.model !== JEV_MODEL) throw new Error(`${who}: model is not ${JEV_MODEL}`);
  const answers = response.answers;
  const a = isObject(answers) ? answers[questionId] : undefined;
  if (!isObject(a) || !isAnswer(a.choice)) throw new Error(`${who}: answer missing or outside yes|no`);
  if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
    throw new Error(`${who}: confidence ${JSON.stringify(a.confidence)} is outside [0, 1]`);
  }
  if (!isObject(response.usage)) throw new Error(`${who}: no usage in reply`);
  const tokensIn = count(response.usage.input_tokens, "usage.input_tokens", who);
  return {
    choice: a.choice, model: JEV_MODEL, confidence: a.confidence, tokensIn,
    tokensOut: count(response.usage.output_tokens, "usage.output_tokens", who), costUsd: (tokensIn * JEV_PRICE_PER_M) / 1e6,
  };
}

/** LLM cost from the dated table: uncached input, cache writes (5 m and 1 h) and cache reads priced separately. */
export function llmCost(usage: { readonly [key: string]: unknown }, who: string): number {
  const input = count(usage.input_tokens, "usage.input_tokens", who);
  const output = count(usage.output_tokens, "usage.output_tokens", who);
  const read = optional(usage, "cache_read_input_tokens", who);
  const write = optional(usage, "cache_creation_input_tokens", who);
  let write1h = 0;
  if (usage.cache_creation !== undefined) {
    const split = usage.cache_creation;
    if (!isObject(split)) throw new Error(`${who}: usage.cache_creation ${JSON.stringify(split)} is not an object`);
    write1h = optional(split, "ephemeral_1h_input_tokens", who);
    const w5 = split.ephemeral_5m_input_tokens === undefined ? write - write1h : optional(split, "ephemeral_5m_input_tokens", who);
    if (w5 < 0 || w5 + write1h !== write) throw new Error(`${who}: cache_creation 5 m ${w5} + 1 h ${write1h} does not sum to cache_creation_input_tokens ${write}`);
  }
  const p = LLM_PRICES;
  return (input * p.inputPerM + (write - write1h) * p.cacheWrite5mPerM + write1h * p.cacheWrite1hPerM + read * p.cacheReadPerM + output * p.outputPerM) / 1e6;
}

/** A `claude -p --output-format json` reply: one word yes or no (a trailing full stop is allowed), a Haiku 4.5 model. */
export function parseLlm(response: unknown, who: string): Reply {
  if (!isObject(response)) throw new Error(`${who}: reply is not a JSON object`);
  if (response.is_error === true) throw new Error(`${who}: error envelope: ${String(response.result ?? "").slice(0, 160)}`);
  const text = typeof response.result === "string" ? response.result.trim().toLowerCase().replace(/\.$/, "") : "";
  if (!isAnswer(text)) throw new Error(`${who}: reply ${JSON.stringify(String(response.result ?? "").slice(0, 120))} is not exactly yes or no`);
  if (!isObject(response.usage)) throw new Error(`${who}: no usage in reply`);
  const models = isObject(response.modelUsage) ? Object.keys(response.modelUsage).sort() : [];
  if (models.length === 0) throw new Error(`${who}: no modelUsage in reply`);
  const off = models.filter((m) => !LLM_MODEL_IDS.includes(m));
  if (off.length > 0) throw new Error(`${who}: model ${off.join("+")} is not in the price table (${LLM_MODEL_IDS.join(", ")} only)`);
  const u = response.usage;
  return {
    choice: text, model: models.join("+"), confidence: null,
    tokensIn: count(u.input_tokens, "usage.input_tokens", who) + optional(u, "cache_creation_input_tokens", who) + optional(u, "cache_read_input_tokens", who),
    tokensOut: count(u.output_tokens, "usage.output_tokens", who), costUsd: llmCost(u, who),
  };
}

export function record(c: Case, q: Question, answerer: string, model: string, output: Answer, extra: Partial<RecordRow> = {}): RecordRow {
  return {
    format_version: "jnj-record/1", run_id: RUN_ID, prompt_version: PROMPT_VERSION, case_id: c.case_id, case_input: c.case_input,
    question_id: q.question_id, question: q.question, answer_set: ANSWERS.join("|"), answerer, answerer_model: model, output,
    confidence: "", label: "", label_source: "", tokens_in: "", tokens_out: "", cost_usd: "", latency_ms: "", ...extra,
  };
}

export function ruleRecord(c: Case, q: Question): RecordRow {
  return record(c, q, "rule", ruleModel(q), ruleOutput(c, q), { tokens_in: "0", tokens_out: "0", cost_usd: "0", latency_ms: "0" });
}

export function armRecord(c: Case, q: Question, answerer: "jev" | "llm", reply: Reply, latencyMs: number): RecordRow {
  return record(c, q, answerer, reply.model, reply.choice, {
    confidence: reply.confidence === null ? "" : reply.confidence.toFixed(4),
    tokens_in: String(reply.tokensIn), tokens_out: String(reply.tokensOut), cost_usd: reply.costUsd.toFixed(10), latency_ms: String(latencyMs),
  });
}

export function rowKey(r: Pick<RecordRow, "run_id" | "case_id" | "question_id" | "answerer">): string {
  return JSON.stringify([r.run_id, r.case_id, r.question_id, r.answerer]);
}

type Shown = "run_id" | "prompt_version" | "case_id" | "question_id" | "answerer" | "case_input" | "question" | "answer_set" | "output";

/**
 * An opaque id per row, bound to the run and to everything the page shows: a label exported for another run, CV,
 * question, answer set, prompt or answer no longer matches any row. No arm name, model or order can be read from it.
 */
export function itemId(r: Pick<RecordRow, Shown>): string {
  return sha256Hex(JSON.stringify([r.run_id, r.prompt_version, r.case_id, r.question_id, r.answerer, r.case_input, r.question, r.answer_set, r.output])).slice(0, 16);
}

export interface BlindItem { readonly item_id: string; readonly case_input: string; readonly question: string; readonly output: string }

/** What the labelling page shows: the CV, the question and one answer, in id order; never answerer, model or confidence. */
export function blindItems(rows: readonly RecordRow[]): BlindItem[] {
  return rows
    .map((r) => ({ item_id: itemId(r), case_input: r.case_input, question: r.question, output: r.output }))
    .sort((a, b) => a.item_id.localeCompare(b.item_id));
}

/** labels.csv from the page (item_id,label): accept or reject, each id once, every id known. Unlisted rows stay blank. */
export function applyItemLabels(rows: readonly RecordRow[], text: string): RecordRow[] {
  const { header, rows: lines } = readDictRows(text);
  const h = header ?? [];
  const repeated = h.filter((name, i) => h.indexOf(name) !== i);
  if (repeated.length > 0) throw new Error(`labels.csv: duplicate column ${repeated.join(", ")}`);
  const idAt = h.indexOf("item_id");
  const labelAt = h.indexOf("label");
  if (idAt < 0 || labelAt < 0) throw new Error("labels.csv needs item_id and label columns");
  const ids = rows.map(itemId);
  const labels = new Map<string, string>();
  for (const { fields, line } of lines) {
    if (fields.length !== h.length) throw new Error(`labels.csv line ${line}: ${fields.length} fields, header has ${h.length}`);
    const id = fields[idAt] ?? "";
    const label = fields[labelAt] ?? "";
    if (!ids.includes(id)) throw new Error(`labels.csv line ${line}: unknown item_id ${JSON.stringify(id)}`);
    if (labels.has(id)) throw new Error(`labels.csv line ${line}: duplicate item_id ${id}`);
    if (label !== "accept" && label !== "reject") throw new Error(`labels.csv line ${line}: label ${JSON.stringify(label)} is not accept or reject`);
    labels.set(id, label);
  }
  return rows.map((r, i) => {
    const label = labels.get(ids[i] ?? "");
    return label === undefined ? r : { ...r, label, label_source: "human" };
  });
}
