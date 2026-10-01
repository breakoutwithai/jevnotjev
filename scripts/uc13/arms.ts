// UC13 arms: one decision (can the shop bot answer this message from the fact sheet?), three answerers.
// Pure parts only; scripts/uc13/run-arms.ts does the I/O. Spec: docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md
import { join } from "node:path";
import { formatRows, readDictRows } from "../../src/format/csv.ts";

export const RUN_ID = "run-shopbot-2026-10-01";
export const PROMPT_VERSION = "shop-bot-handoff.v1";
export const QUESTION_ID = "q1";
export const QUESTION = "Can the bot answer this customer message using only the fact sheet, or must it hand off to staff?";
export type Answer = "answer" | "hand_off";
export const ANSWERS: readonly Answer[] = ["answer", "hand_off"];
export const CASES_COUNT = 40;
export const CRITERIA: Readonly<Record<Answer, string>> = {
  answer:
    "Everything the customer asks is covered by the fact sheet, so the bot can reply without promising stock, availability, a booking, or anything the sheet does not state.",
  hand_off:
    "The message needs live stock or availability, a booking or reservation, a policy or fact not on the sheet, a safety judgement, or a complaint, injury or billing problem, so staff must answer.",
};
export const JEV_MODEL = "jev-1.13.0";
/** Published input price per million tokens, output free; not yet checked against a bill. */
export const JEV_PRICE_PER_M = 0.042;
export const RULE_MODEL = "keywords.v1";

export type Column =
  | "format_version" | "run_id" | "prompt_version" | "case_id" | "case_input" | "question_id" | "question"
  | "answer_set" | "answerer" | "answerer_model" | "output" | "confidence" | "label" | "label_source"
  | "tokens_in" | "tokens_out" | "cost_usd" | "latency_ms";
export const COLUMNS: readonly Column[] = [
  "format_version", "run_id", "prompt_version", "case_id", "case_input", "question_id", "question",
  "answer_set", "answerer", "answerer_model", "output", "confidence", "label", "label_source",
  "tokens_in", "tokens_out", "cost_usd", "latency_ms",
];
export type RecordRow = Record<Column, string>;

export interface Case { readonly case_id: string; readonly case_input: string }
export interface Example { readonly factSheet: string; readonly cases: readonly Case[] }

const RULE_TERMS = [
  "available", "availability", "in stock", "stock", "left", "book", "booked", "booking", "reserve",
  "reservation", "hold", "confirm", "confirmed", "cancel", "refund", "deposit", "damage", "broke",
  "broken", "charged", "hurt", "injur", "avalanche", "safe", "danger", "this weekend", "saturday",
  "sunday", "tomorrow",
];
const RULE_RE = new RegExp(`\\b(${RULE_TERMS.join("|")})`, "i");

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAnswer(value: unknown): value is Answer {
  return value === "answer" || value === "hand_off";
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export async function loadExample(dir: string): Promise<Example> {
  const factSheet = (await Bun.file(join(dir, "fact-sheet.md")).text()).trim();
  const cases = (await Bun.file(join(dir, "cases.jsonl")).text())
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i): Case => {
      const parsed: unknown = JSON.parse(line);
      if (!isObject(parsed) || typeof parsed.case_id !== "string" || typeof parsed.case_input !== "string") {
        throw new Error(`cases.jsonl line ${i + 1}: needs string case_id and case_input`);
      }
      return { case_id: parsed.case_id, case_input: parsed.case_input };
    });
  return { factSheet, cases };
}

export function record(c: Case, answerer: string, model: string, output: Answer, extra: Partial<RecordRow> = {}): RecordRow {
  return {
    format_version: "jnj-record/1", run_id: RUN_ID, prompt_version: PROMPT_VERSION, case_id: c.case_id,
    case_input: c.case_input, question_id: QUESTION_ID, question: QUESTION, answer_set: ANSWERS.join("|"),
    answerer, answerer_model: model, output, confidence: "", label: "", label_source: "",
    tokens_in: "", tokens_out: "", cost_usd: "", latency_ms: "", ...extra,
  };
}

/** The keyword rule in examples/uc13-shop-bot/rule.md: a term at a word start answers hand_off. */
export function ruleOutput(message: string): Answer {
  return RULE_RE.test(message) ? "hand_off" : "answer";
}

export function ruleRecord(c: Case): RecordRow {
  return record(c, "rule", RULE_MODEL, ruleOutput(c.case_input), { cost_usd: "0", latency_ms: "0" });
}

export interface JevBody {
  readonly state: string;
  readonly model: string;
  readonly questions: {
    readonly q1: { readonly type: "choice"; readonly instructions: { readonly question: string }; readonly criteria: Readonly<Record<Answer, string>> };
  };
}

export function jevBody(factSheet: string, c: Case): JevBody {
  return {
    state: `Fact sheet:\n${factSheet}\n\nCustomer message:\n${c.case_input}`,
    model: JEV_MODEL,
    questions: { q1: { type: "choice", instructions: { question: QUESTION }, criteria: CRITERIA } },
  };
}

export interface ArmReply {
  readonly choice: Answer;
  readonly model: string;
  readonly confidence: number | null;
  readonly probabilities: unknown;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly costUsd: number;
}

/** A Jev systemone response; fails unless the model is the pinned one and the choice is in the answer set. */
export function parseJevResponse(response: unknown, caseId: string): ArmReply {
  if (!isObject(response) || response.model !== JEV_MODEL) {
    throw new Error(`Jev ${caseId}: unexpected model ${isObject(response) ? String(response.model) : "none"}`);
  }
  const answers = response.answers;
  const a = isObject(answers) ? answers[QUESTION_ID] : undefined;
  if (!isObject(a) || !isAnswer(a.choice) || typeof a.confidence !== "number") {
    throw new Error(`Jev ${caseId}: answer missing or outside ${ANSWERS.join("|")}`);
  }
  const usage = isObject(response.usage) ? response.usage : {};
  const tokensIn = count(usage.input_tokens);
  return {
    choice: a.choice, model: JEV_MODEL, confidence: a.confidence, probabilities: a.probabilities ?? null,
    tokensIn, tokensOut: count(usage.output_tokens), costUsd: (tokensIn * JEV_PRICE_PER_M) / 1e6,
  };
}

/** A `claude -p --output-format json` reply; input tokens include cache reads and writes. */
export function parseLlmResponse(response: unknown, caseId: string): ArmReply {
  if (!isObject(response)) throw new Error(`LLM ${caseId}: reply is not a JSON object`);
  const text = String(response.result ?? "").trim().toLowerCase();
  const choice = text.match(/hand_off|answer/)?.[0];
  if (!isAnswer(choice)) throw new Error(`LLM ${caseId}: unparsed reply ${JSON.stringify(text.slice(0, 120))}`);
  if (typeof response.total_cost_usd !== "number") throw new Error(`LLM ${caseId}: no total_cost_usd in reply`);
  const usage = isObject(response.usage) ? response.usage : {};
  const models = isObject(response.modelUsage) ? Object.keys(response.modelUsage).sort() : [];
  if (models.length === 0) throw new Error(`LLM ${caseId}: no modelUsage in reply`);
  return {
    choice, model: models.join("+"), confidence: null, probabilities: null,
    tokensIn: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
    tokensOut: count(usage.output_tokens), costUsd: response.total_cost_usd,
  };
}

export function armRecord(c: Case, answerer: "jev" | "llm", reply: ArmReply, latencyMs: number): RecordRow {
  return record(c, answerer, reply.model, reply.choice, {
    confidence: reply.confidence === null ? "" : reply.confidence.toFixed(4),
    tokens_in: String(reply.tokensIn), tokens_out: String(reply.tokensOut),
    cost_usd: reply.costUsd.toFixed(8), latency_ms: String(latencyMs),
  });
}

export function formatRecords(rows: readonly RecordRow[]): string {
  return formatRows([COLUMNS, ...rows.map((r) => COLUMNS.map((col) => r[col]))]);
}

export function parseRecords(text: string): RecordRow[] {
  const { header, rows } = readDictRows(text);
  const names = header ?? [];
  return rows.map(({ fields }) => {
    const cells = new Map(names.map((name, i) => [name, fields[i] ?? ""]));
    const row = record({ case_id: "", case_input: "" }, "", "", "answer");
    for (const col of COLUMNS) row[col] = cells.get(col) ?? "";
    return row;
  });
}

/** labels.csv from the labelling page: case_id,truth. */
export function parseTruth(text: string): Map<string, Answer> {
  const { header, rows } = readDictRows(text);
  const idAt = (header ?? []).indexOf("case_id");
  const truthAt = (header ?? []).indexOf("truth");
  if (idAt < 0 || truthAt < 0) throw new Error("labels.csv needs case_id and truth columns");
  const truth = new Map<string, Answer>();
  for (const { fields, line } of rows) {
    const id = fields[idAt] ?? "";
    const t = fields[truthAt];
    if (!isAnswer(t)) throw new Error(`labels.csv line ${line}: ${id} truth ${JSON.stringify(t)} is not one of ${ANSWERS.join(", ")}`);
    truth.set(id, t);
  }
  return truth;
}

export function applyLabels(rows: readonly RecordRow[], truth: ReadonlyMap<string, Answer>): RecordRow[] {
  return rows.map((r) => {
    const t = truth.get(r.case_id);
    if (t === undefined) return { ...r, label: "", label_source: "" };
    return { ...r, label: r.output === t ? "accept" : "reject", label_source: "human" };
  });
}
