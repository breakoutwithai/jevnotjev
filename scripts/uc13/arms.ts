// UC13 arms: one decision (can the shop bot answer this message from the fact sheet?), three answerers.
// Pure parts only; scripts/uc13/run-arms.ts does the I/O. Spec: docs/product/use-cases/uc13-shop-bot-answer-or-handoff.md
import { join } from "node:path";
import { formatRows, readDictRows } from "../../src/format/csv.ts";
import { checkJevResponse } from "../../src/jev-answer.ts";
import { validate } from "../../src/format/validate.ts";

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

type V1Column =
  | "format_version" | "run_id" | "prompt_version" | "case_id" | "case_input" | "question_id" | "question"
  | "answer_set" | "answerer" | "answerer_model" | "output" | "confidence" | "label" | "label_source"
  | "tokens_in" | "tokens_out" | "cost_usd" | "latency_ms";
type ProvenanceColumn = "labelled_by" | "labelled_at" | "label_blind";
export type Column = V1Column | ProvenanceColumn;
/** jnj-record/1 columns, in order. */
export const COLUMNS_V1: readonly V1Column[] = [
  "format_version", "run_id", "prompt_version", "case_id", "case_input", "question_id", "question",
  "answer_set", "answerer", "answerer_model", "output", "confidence", "label", "label_source",
  "tokens_in", "tokens_out", "cost_usd", "latency_ms",
];
/** jnj-record/1.1: the /1 columns, then label provenance (format/README.md "Label provenance"). */
export const COLUMNS: readonly Column[] = [...COLUMNS_V1, "labelled_by", "labelled_at", "label_blind"];
/** One row; the provenance cells exist on jnj-record/1.1 rows (UC13) and are absent on /1 rows (TokenMax). */
export type RecordRow = Record<V1Column, string> & Partial<Record<ProvenanceColumn, string>>;

/** How a labels.csv truth became a label: written into label_source, labelled_by, labelled_at and label_blind. */
export interface LabelProvenance {
  readonly source: "human" | "human_reviewed" | "agent";
  readonly by: string;
  readonly at: string;
  readonly blind: boolean;
}

/**
 * The 2026-10-03 labels.csv (docs/product/runs/2026-10-01-uc13-shop-bot/LABELS.md): three AI labellers drafted every
 * truth and agreed 40 of 40, then a person reviewed the drafted file and approved it on 2026-10-03. AI-drafted and
 * person-approved is human_reviewed; the reviewer saw the drafts, so the calls are not blind.
 */
export const APPROVED_DRAFT_2026_10_03: LabelProvenance = Object.freeze({
  source: "human_reviewed",
  by: "operator",
  at: "2026-10-03",
  blind: false,
});

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

/** A token count: a finite, non-negative integer, or the reply is refused. */
function tokenCount(value: unknown, field: string, who: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${who}: usage.${field} ${JSON.stringify(value)} is not a non-negative integer`);
  }
  return value;
}

/** An optional token counter: absent is 0, present must be valid. */
function optionalCount(usage: { readonly [key: string]: unknown }, field: string, who: string): number {
  return usage[field] === undefined ? 0 : tokenCount(usage[field], field, who);
}

function requireUsage(response: { readonly [key: string]: unknown }, who: string): { readonly [key: string]: unknown } {
  if (!isObject(response.usage)) throw new Error(`${who}: no usage in reply; a call without token counts cannot be costed`);
  return response.usage;
}

/** The case ids of the example, in order: m01 to m40. */
export const CASE_IDS: readonly string[] = Array.from({ length: CASES_COUNT }, (_, i) => `m${String(i + 1).padStart(2, "0")}`);

/** Throws unless the cases are exactly m01 to m40, in order, each with a non-blank message. */
export function assertCases(cases: readonly Case[]): void {
  const seen = new Set<string>();
  cases.forEach((c, i) => {
    if (seen.has(c.case_id)) throw new Error(`cases.jsonl: duplicate case_id ${JSON.stringify(c.case_id)}`);
    seen.add(c.case_id);
    if (c.case_id !== CASE_IDS[i]) throw new Error(`cases.jsonl line ${i + 1}: case_id ${JSON.stringify(c.case_id)}, expected ${CASE_IDS[i] ?? "no more cases"}`);
    if (c.case_input.trim() === "") throw new Error(`cases.jsonl: ${c.case_id} has a blank case_input`);
  });
  const missing = CASE_IDS.slice(cases.length);
  if (missing.length > 0) throw new Error(`cases.jsonl: missing ${missing.join(", ")}`);
}

export async function loadExample(dir: string): Promise<Example> {
  const factSheet = (await Bun.file(join(dir, "fact-sheet.md")).text()).trim();
  if (factSheet === "") throw new Error(`fact-sheet.md in ${dir} is empty`);
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
  assertCases(cases);
  return { factSheet, cases };
}

export function record(c: Case, answerer: string, model: string, output: Answer, extra: Partial<RecordRow> = {}): RecordRow {
  return {
    format_version: "jnj-record/1.1", run_id: RUN_ID, prompt_version: PROMPT_VERSION, case_id: c.case_id,
    case_input: c.case_input, question_id: QUESTION_ID, question: QUESTION, answer_set: ANSWERS.join("|"),
    answerer, answerer_model: model, output, confidence: "",
    tokens_in: "", tokens_out: "", cost_usd: "", latency_ms: "", ...UNLABELLED, ...extra,
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
  const who = `Jev ${caseId}`;
  const check = checkJevResponse(response, { [QUESTION_ID]: ANSWERS }, JEV_MODEL);
  if (!check.ok) {
    const where = check.questionId === null ? "" : ` at ${check.questionId}`;
    throw new Error(`${who}: invalid response (${check.reason}${where}; model ${JEV_MODEL}, answers ${ANSWERS.join("|")})`);
  }
  const a = check.answers[QUESTION_ID];
  if (a === undefined || !isAnswer(a.choice) || a.confidence === null) {
    throw new Error(`${who}: answer or confidence missing`);
  }
  if (!isObject(response)) throw new Error(`${who}: response is not an object`);
  const usage = requireUsage(response, who);
  const tokensIn = tokenCount(usage.input_tokens, "input_tokens", who);
  return {
    choice: a.choice, model: JEV_MODEL, confidence: a.confidence, probabilities: a.probabilities,
    tokensIn, tokensOut: tokenCount(usage.output_tokens, "output_tokens", who), costUsd: (tokensIn * JEV_PRICE_PER_M) / 1e6,
  };
}

/**
 * A `claude -p --output-format json` reply; input tokens include cache reads and writes. The whole trimmed result must
 * be one answer word, so "unanswerable" or "do not answer; hand_off" fail rather than match a word inside them.
 */
export function parseLlmResponse(response: unknown, caseId: string): ArmReply {
  const who = `LLM ${caseId}`;
  if (!isObject(response)) throw new Error(`${who}: reply is not a JSON object`);
  if (response.is_error === true) throw new Error(`${who}: error envelope (is_error true): ${String(response.result ?? "").slice(0, 120)}`);
  const text = typeof response.result === "string" ? response.result.trim() : "";
  if (!isAnswer(text)) throw new Error(`${who}: reply ${JSON.stringify(text.slice(0, 120))} is not exactly ${ANSWERS.join(" or ")}`);
  const cost = response.total_cost_usd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) throw new Error(`${who}: total_cost_usd ${JSON.stringify(cost)} is not a non-negative cost`);
  const usage = requireUsage(response, who);
  const models = isObject(response.modelUsage) ? Object.keys(response.modelUsage).sort() : [];
  if (models.length === 0) throw new Error(`${who}: no modelUsage in reply`);
  return {
    choice: text, model: models.join("+"), confidence: null, probabilities: null,
    tokensIn: tokenCount(usage.input_tokens, "input_tokens", who) + optionalCount(usage, "cache_creation_input_tokens", who) +
      optionalCount(usage, "cache_read_input_tokens", who),
    tokensOut: tokenCount(usage.output_tokens, "output_tokens", who), costUsd: cost,
  };
}

export function armRecord(c: Case, answerer: "jev" | "llm", reply: ArmReply, latencyMs: number): RecordRow {
  return record(c, answerer, reply.model, reply.choice, {
    confidence: reply.confidence === null ? "" : reply.confidence.toFixed(4),
    tokens_in: String(reply.tokensIn), tokens_out: String(reply.tokensOut),
    cost_usd: reply.costUsd.toFixed(8), latency_ms: String(latencyMs),
  });
}

/** The jnj-record/1.1 header when any row is 1.1, else the /1 header, so a /1 run (TokenMax) round-trips byte for byte. */
export function formatRecords(rows: readonly RecordRow[]): string {
  const columns: readonly Column[] = rows.some((r) => r.format_version === "jnj-record/1.1") ? COLUMNS : COLUMNS_V1;
  return formatRows([columns, ...rows.map((r) => columns.map((col) => r[col] ?? ""))]);
}

function withoutProvenance(row: RecordRow): RecordRow {
  const { labelled_by: _by, labelled_at: _at, label_blind: _blind, ...v1 } = row;
  return v1;
}

/** records.csv: the header is exactly the /1 or the 1.1 columns, every row exactly as wide, and the file valid. */
export function parseRecords(text: string): RecordRow[] {
  const { header, rows } = readDictRows(text);
  const joined = header === null ? "" : header.join(",");
  const columns: readonly Column[] | null =
    joined === COLUMNS.join(",") ? COLUMNS : joined === COLUMNS_V1.join(",") ? COLUMNS_V1 : null;
  if (columns === null) {
    throw new Error(`records.csv header is not the ${COLUMNS_V1.length} jnj-record/1 or ${COLUMNS.length} jnj-record/1.1 columns in order`);
  }
  const parsed = rows.map(({ fields, line }) => {
    if (fields.length !== columns.length) throw new Error(`records.csv line ${line}: ${fields.length} fields, expected ${columns.length}`);
    const row = record({ case_id: "", case_input: "" }, "", "", "answer");
    columns.forEach((col, i) => { row[col] = fields[i] ?? ""; });
    return columns === COLUMNS ? row : withoutProvenance(row);
  });
  const { errors } = validate(text);
  if (errors.length > 0) throw new Error(`records.csv is not valid: ${errors.slice(0, 3).join("; ")}`);
  return parsed;
}

/** labels.csv from the labelling page: case_id,truth. Each id once, m01 to m40 only. */
export function parseTruth(text: string): Map<string, Answer> {
  const { header, rows } = readDictRows(text);
  const idAt = (header ?? []).indexOf("case_id");
  const truthAt = (header ?? []).indexOf("truth");
  if (idAt < 0 || truthAt < 0) throw new Error("labels.csv needs case_id and truth columns");
  const truth = new Map<string, Answer>();
  for (const { fields, line } of rows) {
    const id = fields[idAt] ?? "";
    const t = fields[truthAt];
    if (!CASE_IDS.includes(id)) throw new Error(`labels.csv line ${line}: case_id ${JSON.stringify(id)} is not m01 to m${CASES_COUNT}`);
    if (truth.has(id)) throw new Error(`labels.csv line ${line}: duplicate truth for ${id}`);
    if (!isAnswer(t)) throw new Error(`labels.csv line ${line}: ${id} truth ${JSON.stringify(t)} is not one of ${ANSWERS.join(", ")}`);
    truth.set(id, t);
  }
  return truth;
}

function isOneProvenance(p: LabelProvenance | ReadonlyMap<string, LabelProvenance>): p is LabelProvenance {
  return "source" in p;
}

/** The label and provenance cells of an unlabelled row. */
export const UNLABELLED: Readonly<Pick<RecordRow, "label" | "label_source" | "labelled_by" | "labelled_at" | "label_blind">> =
  Object.freeze({ label: "", label_source: "", labelled_by: "", labelled_at: "", label_blind: "" });

/**
 * Accept or reject each row against its case's truth, stamped with how the truth was made; a case with no truth stays
 * unlabelled; an unknown id fails. Every row comes out jnj-record/1.1. There is no default provenance: the caller
 * states whether a person picked it, once for all cases or per case (a rebuild keeps each case's own).
 */
export function applyLabels(
  rows: readonly RecordRow[],
  truth: ReadonlyMap<string, Answer>,
  provenance: LabelProvenance | ReadonlyMap<string, LabelProvenance>,
): RecordRow[] {
  const ids = new Set(rows.map((r) => r.case_id));
  const unknown = [...truth.keys()].filter((id) => !ids.has(id));
  if (unknown.length > 0) throw new Error(`labels for cases not in records.csv: ${unknown.join(", ")}`);
  const provenanceOf = (caseId: string): LabelProvenance => {
    const p = isOneProvenance(provenance) ? provenance : provenance.get(caseId);
    if (p === undefined) throw new Error(`${caseId}: a label needs a provenance, who labelled it and how`);
    return p;
  };
  return rows.map((r) => {
    const t = truth.get(r.case_id);
    if (t === undefined) return { ...r, format_version: "jnj-record/1.1", ...UNLABELLED };
    const p = provenanceOf(r.case_id);
    return {
      ...r,
      format_version: "jnj-record/1.1",
      label: r.output === t ? "accept" : "reject",
      label_source: p.source,
      labelled_by: p.by,
      labelled_at: p.at,
      label_blind: String(p.blind),
    };
  });
}

/** The per-case truth that labelled rows encode (accept: the output; reject: the other answer); conflicts fail. */
export function truthFromRows(rows: readonly RecordRow[]): Map<string, Answer> {
  const truth = new Map<string, Answer>();
  for (const r of rows) {
    if (r.label === "") continue;
    if (!isAnswer(r.output) || (r.label !== "accept" && r.label !== "reject")) {
      throw new Error(`records.csv ${r.case_id} ${r.answerer}: label ${JSON.stringify(r.label)} on output ${JSON.stringify(r.output)}`);
    }
    const t: Answer = r.label === "accept" ? r.output : r.output === "answer" ? "hand_off" : "answer";
    const seen = truth.get(r.case_id);
    if (seen !== undefined && seen !== t) throw new Error(`records.csv ${r.case_id}: labels disagree on the truth (${seen} vs ${t})`);
    truth.set(r.case_id, t);
  }
  return truth;
}

function isSource(value: string): value is LabelProvenance["source"] {
  return value === "human" || value === "human_reviewed" || value === "agent";
}

export function isLabelSource(value: string): value is LabelProvenance["source"] {
  return value === "human" || value === "human_reviewed" || value === "agent";
}

/**
 * Each labelled case's provenance, so a rebuild (run --arm jev, replay) keeps it instead of restamping. A labelled row
 * with no complete provenance (a jnj-record/1 label) fails: nothing here can say who made it, so it is relabelled with
 * `run-arms.ts label --source ...`, never guessed. Rows of one case that disagree fail.
 */
export function provenanceByCase(rows: readonly RecordRow[]): Map<string, LabelProvenance> {
  const found = new Map<string, LabelProvenance>();
  for (const r of rows) {
    if (r.label === "") continue;
    const source = r.label_source;
    const by = r.labelled_by ?? "";
    const at = r.labelled_at ?? "";
    if (!isLabelSource(source) || (r.label_blind !== "true" && r.label_blind !== "false") || by === "" || at === "") {
      throw new Error(
        `records.csv ${r.case_id} ${r.answerer}: label without a complete provenance; relabel with ` +
          "run-arms.ts label --source <human|human_reviewed|agent> --by <handle> --at <time> --blind <true|false>",
      );
    }
    const p: LabelProvenance = { source, by, at, blind: r.label_blind === "true" };
    const seen = found.get(r.case_id);
    if (seen !== undefined && JSON.stringify(seen) !== JSON.stringify(p)) {
      throw new Error(`records.csv ${r.case_id} ${r.answerer}: rows of one case carry different provenance`);
    }
    found.set(r.case_id, p);
  }
  return found;
}
