// Validate a Jev!Jev eval record CSV against format jnj-record/1.
// Output text (ERROR and GAP lines, per-answerer summary, VALID/INVALID) is the message contract in format/README.md.
// Pure: takes the file's text, uses no Node or Bun APIs, so the browser imports it. CLI: cli.ts.

import schemaJson from "../../format/record-v1.schema.json";
import { readDictRows } from "./csv.ts";
import { formatFixed6, formatList, quoteText } from "./quote.ts";
import { iterErrors, type Value } from "./schema.ts";

export const SCHEMA: unknown = schemaJson;
export const COLUMNS: readonly string[] = schemaJson.required;

const INTEGER_COLUMNS = new Set(["tokens_in", "tokens_out", "latency_ms"]);
const NUMBER_COLUMNS = new Set(["confidence", "cost_usd"]);
// A number cell may end in one line break; it is accepted and trimmed before parsing.
const INTEGER_TEXT = /^[0-9]+\n?$/;
const NUMBER_TEXT = /^[0-9]+(\.[0-9]+)?([eE]-?[0-9]+)?\n?$/;

/** The three methods every case is compared on: current setup, simple baseline, Jev routing. */
const METHODS: readonly string[] = ["llm", "rule", "jev"];

/** Columns that name a case; a schema error in one keeps the row out of the per-method presence check. */
const IDENTITY: ReadonlySet<string> = new Set(["case_id", "question_id", "answerer", "run_id", "prompt_version"]);

/** Control characters as \uXXXX, so an identifier can never break a GAP message across lines. */
function plain(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export type Row = ReadonlyMap<string, Value>;

export interface ParsedRow {
  /** CSV line the row ends on. */
  readonly line: number;
  /** Cells parsed: empty is null, integers are bigint, numbers are float; anything else stays text. */
  readonly values: Row;
  /** Cells exactly as the CSV holds them. */
  readonly raw: ReadonlyMap<string, string>;
}

export interface Validation {
  /** Any error makes the file invalid. */
  readonly errors: readonly string[];
  /** Missing costs or labels: reported, the file stays valid. */
  readonly gaps: readonly string[];
  readonly rows: readonly ParsedRow[];
}

/** Decode file bytes as strict UTF-8: invalid bytes throw, and a byte order mark stays in the text. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

/** Empty cell is null. A value that does not parse stays a string so the schema reports it. */
export function parseCell(column: string, raw: string): Value {
  if (raw === "") return null;
  if (INTEGER_COLUMNS.has(column) && INTEGER_TEXT.test(raw)) return BigInt(raw.trim());
  if (NUMBER_COLUMNS.has(column) && NUMBER_TEXT.test(raw)) {
    const number = Number(raw.trim());
    return Number.isFinite(number) ? number : raw;
  }
  return raw;
}

function duplicates(header: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated].sort(compareCodePoints);
}

/** Text ordering by code point, not by UTF-16 unit. */
function compareCodePoints(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]?.codePointAt(0) ?? 0;
    const y = b[i]?.codePointAt(0) ?? 0;
    if (x !== y) return x - y;
  }
  return a.length - b.length;
}

function readRows(text: string): { errors: string[]; rows: ParsedRow[] } {
  const { header: fieldnames, rows: records } = readDictRows(text);
  const header = fieldnames ?? [];
  const errors: string[] = [];
  const repeated = duplicates(header);
  if (repeated.length > 0) errors.push(`header: duplicate column names ${formatList(repeated)}`);
  const missing = COLUMNS.filter((column) => !header.includes(column));
  const unknown = header.filter((column) => !COLUMNS.includes(column));
  if (missing.length > 0) errors.push(`header: missing columns ${formatList(missing)}`);
  if (unknown.length > 0) errors.push(`header: unknown columns ${formatList(unknown)}`);
  if (errors.length > 0) return { errors, rows: [] };
  const rows: ParsedRow[] = [];
  for (const record of records) {
    if (record.fields.length !== header.length) {
      const more = record.fields.length > header.length ? "more" : "fewer";
      errors.push(`line ${record.line}: row has ${more} cells than the header`);
      continue;
    }
    const raw = new Map<string, string>();
    header.forEach((name, index) => raw.set(name, record.fields[index] ?? ""));
    const values = new Map<string, Value>();
    const ordered = new Map<string, string>();
    for (const column of COLUMNS) {
      const cell = raw.get(column) ?? "";
      ordered.set(column, cell);
      values.set(column, parseCell(column, cell));
    }
    rows.push({ line: record.line, values, raw: ordered });
  }
  return { errors, rows };
}

function cell(row: Row, column: string): Value {
  const value = row.get(column);
  if (value === undefined) throw new Error(`row has no column ${column}`);
  return value;
}

function text(row: Row, column: string): string {
  const value = cell(row, column);
  if (typeof value !== "string") throw new Error(`column ${column} is not text after schema validation`);
  return value;
}

/** Errors, gaps and rows for one file's text. Errors make the file invalid; gaps are missing costs or labels. */
export function validate(csvText: string): Validation {
  const { errors, rows } = readRows(csvText);
  const gaps: string[] = [];
  if (errors.length > 0) return { errors, gaps, rows };
  if (rows.length === 0) return { errors: ["file has no data rows"], gaps, rows };

  const seen = new Set<string>();
  const inputs = new Map<string, string>();
  const questions = new Map<string, string>();
  const answered = new Map<string, { readonly label: string; readonly methods: Set<string> }>();
  for (const { line, values: row } of rows) {
    const schemaErrors = [...iterErrors(SCHEMA, row)];
    const rowErrors = schemaErrors.map((error) => `line ${line}: ${error.path.join(".") || "row"}: ${error.message}`);
    errors.push(...rowErrors);
    // A row that is present but invalid still counts as that method's row: it is not reported as absent.
    // Only schema-valid identity cells are used, so a malformed identifier never reaches a GAP message.
    const identityBad = schemaErrors.some((error) => IDENTITY.has(error.path[0] ?? ""));
    const [rowCase, rowQuestion, rowAnswerer, rowRun, rowPrompt] = ["case_id", "question_id", "answerer", "run_id", "prompt_version"].map((column) => row.get(column));
    if (
      !identityBad &&
      typeof rowCase === "string" && typeof rowQuestion === "string" && typeof rowAnswerer === "string" &&
      typeof rowRun === "string" && typeof rowPrompt === "string"
    ) {
      // Same cohort as src/core/metrics.ts cohortId (run, prompt version, question) so the validator and the view agree.
      const caseKey = JSON.stringify([rowRun, rowPrompt, rowQuestion, rowCase]);
      const entry = answered.get(caseKey) ?? {
        label: `case ${plain(rowCase)} (question ${plain(rowQuestion)}, run ${plain(rowRun)}, prompt ${plain(rowPrompt)})`,
        methods: new Set<string>(),
      };
      entry.methods.add(rowAnswerer);
      answered.set(caseKey, entry);
    }
    if (rowErrors.length > 0) continue;
    const caseId = text(row, "case_id");
    const questionId = text(row, "question_id");
    const answerer = text(row, "answerer");
    const runId = text(row, "run_id");
    const promptVersion = text(row, "prompt_version");
    const output = text(row, "output");
    const answerSet = text(row, "answer_set");
    const where = `(${caseId}, ${questionId}, ${answerer})`;
    if (!answerSet.split("|").includes(output)) {
      errors.push(`line ${line}: output ${quoteText(output)} is not in answer_set ${quoteText(answerSet)}`);
    }
    const key = JSON.stringify([runId, caseId, questionId, answerer]);
    if (seen.has(key)) errors.push(`line ${line}: duplicate row for run ${runId} ${where}`);
    seen.add(key);
    const caseInput = text(row, "case_input");
    const firstInput = inputs.get(caseId);
    if (firstInput === undefined) inputs.set(caseId, caseInput);
    else if (firstInput !== caseInput) {
      errors.push(`line ${line}: case_input differs from the first row for case_id ${caseId}`);
    }
    const asked = JSON.stringify([text(row, "question"), answerSet]);
    const version = JSON.stringify([promptVersion, questionId]);
    const firstAsked = questions.get(version);
    if (firstAsked === undefined) questions.set(version, asked);
    else if (firstAsked !== asked) {
      errors.push(
        `line ${line}: question ${questionId} changed within prompt_version ${promptVersion}; ` +
          "give the new wording a new prompt_version",
      );
    }
    if (cell(row, "cost_usd") === null) gaps.push(`line ${line}: cost_usd missing ${where}`);
    if (cell(row, "label") === null) gaps.push(`line ${line}: unlabelled ${where}`);
  }
  // D12: each case needs a row from every method; `human` is not one of them. An absent method is a gap, not an error.
  for (const { label, methods } of answered.values()) {
    for (const method of METHODS) {
      if (!methods.has(method)) gaps.push(`${label}: no ${method} result`);
    }
  }
  return { errors, gaps, rows };
}

/** Per answerer: labelled, accepted, cost. Accuracy counts labelled rows only; cost with a gap is incomplete. */
export function summary(rows: readonly ParsedRow[]): string[] {
  const answerers = [...new Set(rows.map(({ values }) => text(values, "answerer")))].sort(compareCodePoints);
  return answerers.map((answerer) => {
    const mine = rows.map(({ values }) => values).filter((row) => cell(row, "answerer") === answerer);
    const labelled = mine.filter((row) => cell(row, "label") !== null);
    const accepted = labelled.filter((row) => cell(row, "label") === "accept").length;
    let total = 0;
    let complete = true;
    for (const row of mine) {
      const cost = cell(row, "cost_usd");
      if (cost === null) complete = false;
      else if (typeof cost === "number") total += cost;
      else throw new Error("cost_usd is not a number after schema validation");
    }
    const shown = complete ? `$${formatFixed6(total)}` : "incomplete";
    return `${answerer}: rows=${mine.length} labelled=${labelled.length} accepted=${accepted} cost=${shown}`;
  });
}

/** The lines the CLI prints and its exit code: 0 valid, 1 invalid. */
export function report(result: Validation): { lines: string[]; exitCode: number } {
  const { errors, gaps, rows } = result;
  const lines = [...errors.map((message) => `ERROR ${message}`), ...gaps.map((message) => `GAP ${message}`)];
  if (errors.length === 0) lines.push(...summary(rows));
  const cases = new Set(rows.map(({ values }) => cell(values, "case_id"))).size;
  const verdict = errors.length > 0 ? "INVALID" : "VALID";
  lines.push(`${verdict} rows=${rows.length} cases=${cases} errors=${errors.length} gaps=${gaps.length}`);
  return { lines, exitCode: errors.length > 0 ? 1 : 0 };
}
