// Load a jnj-record/1 CSV into Postgres.
//
// The file is validated first; one error and nothing is written. Cells are copied as raw text into a
// temp stage table and jnj.load_stage() casts and inserts them in one transaction, so no number is
// parsed here. Reloading the identical file is a no-op. Purpose "labels" loads a file whose rows are
// already loaded and only adds labels that were missing.

import { createHash } from "node:crypto";
import { basename } from "node:path";
import { Writable } from "node:stream";
import postgres from "postgres";
import schemaJson from "../../format/record-v1.schema.json";
import { pyStrRepr } from "../format/pyrepr.ts";
import { COLUMNS, decodeUtf8, validate, type ParsedRow } from "../format/validate.ts";
import type { Db, Query } from "./connect.ts";
import { adjusted, isAboveOne, isZero, parseDecimal } from "./decimal.ts";

const BIGINT_MAX = 9223372036854775807n;
const NUMERIC_MAX_SCALE = 16383n;
const NUMERIC_MAX_WEIGHT = 131071n;
const INTEGER_COLUMNS = ["tokens_in", "tokens_out", "latency_ms"];
const NUMBER_COLUMNS = ["confidence", "cost_usd"];
const WITHHELD_COLUMNS = ["case_input", "question"];
const SCHEMA_ERROR = /^line (\d+): ([a-z_]+): /;

const PATTERN_COLUMNS = COLUMNS.filter(
  (column) =>
    column !== "answer_set" &&
    Object.entries(schemaJson.properties).some(([name, property]) => name === column && "pattern" in property),
);

export type Purpose = "records" | "labels";

/** The file cannot be loaded; messages use the validator's "line N: column: ..." form. */
export class LoadError extends Error {
  override readonly name = "LoadError";
  readonly messages: readonly string[];

  constructor(messages: readonly string[]) {
    super(messages.join("\n"));
    this.messages = [...messages];
  }
}

export interface LoadResult {
  readonly status: string;
  readonly answers: bigint;
  readonly labels: bigint;
}

function raw(row: ParsedRow, column: string): string {
  return row.raw.get(column) ?? "";
}

/** Values the validator accepts that the database cannot store as written. */
export function storageErrors(rows: readonly ParsedRow[]): string[] {
  const errors: string[] = [];
  for (const row of rows) {
    const { line } = row;
    for (const column of COLUMNS) {
      if (raw(row, column).includes("\u0000")) {
        errors.push(`line ${line}: ${column}: contains a NUL character, which the database cannot store`);
      }
    }
    for (const column of PATTERN_COLUMNS) {
      const value = raw(row, column);
      if (value.endsWith("\n")) errors.push(`line ${line}: ${column}: ${pyStrRepr(value)} ends with a line break`);
    }
    for (const column of INTEGER_COLUMNS) {
      const value = raw(row, column);
      if (value && BigInt(value.trim()) > BIGINT_MAX) {
        errors.push(`line ${line}: ${column}: ${value.trim()} is above ${BIGINT_MAX}, the largest integer stored`);
      }
    }
    for (const column of NUMBER_COLUMNS) {
      const value = raw(row, column);
      if (!value) continue;
      const number = parseDecimal(value);
      if (column === "confidence" && isAboveOne(number)) {
        errors.push(`line ${line}: confidence: ${value.trim()} is above 1`);
      } else if (-number.exponent > NUMERIC_MAX_SCALE) {
        errors.push(
          `line ${line}: ${column}: ${value.trim()} has more than ${NUMERIC_MAX_SCALE} digits after the decimal point`,
        );
      } else if (!isZero(number) && adjusted(number) > NUMERIC_MAX_WEIGHT) {
        errors.push(
          `line ${line}: ${column}: ${value.trim()} has more than ${NUMERIC_MAX_WEIGHT + 1n} digits before the decimal point`,
        );
      }
    }
  }
  return errors;
}

function codePoints(text: string): number {
  return [...text].length;
}

/** The validator quotes a failing cell; never repeat case text or question text in an error. */
export function withholdText(errors: readonly string[], rows: readonly ParsedRow[]): string[] {
  const byLine = new Map(rows.map((row) => [row.line, row]));
  return errors.map((message) => {
    const match = SCHEMA_ERROR.exec(message);
    const column = match?.[2];
    if (match === null || column === undefined || ![...WITHHELD_COLUMNS, "row"].includes(column)) return message;
    const line = Number(match[1]);
    const value = byLine.get(line)?.values.get(column);
    const length = typeof value === "string" ? `length ${codePoints(value)}` : "value";
    return `line ${line}: ${column}: ${length} fails the schema (text withheld)`;
  });
}

/** Create a restricted workspace if it does not exist (the loader role may do this). */
export async function ensureWorkspace(sql: Query, workspace: string): Promise<void> {
  if (!/^[a-z0-9-]{1,64}$/.test(workspace)) {
    throw new LoadError([`workspace ${pyStrRepr(workspace)} must match [a-z0-9-]{1,64}`]);
  }
  await sql`insert into jnj.workspace (slug) values (${workspace}) on conflict (slug) do nothing`;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** One COPY text-format line: tab-separated, backslash escapes for the characters COPY treats specially. */
function copyLine(fields: readonly string[]): string {
  const escaped = fields.map((field) =>
    field.replace(/[\\\t\n\r]/g, (char) => (char === "\\" ? "\\\\" : char === "\t" ? "\\t" : char === "\n" ? "\\n" : "\\r")),
  );
  return escaped.join("\t") + "\n";
}

async function copyRows(stream: Writable, rows: readonly ParsedRow[]): Promise<void> {
  const body = rows.map((row) => copyLine([String(row.line), ...COLUMNS.map((column) => raw(row, column))])).join("");
  await new Promise<void>((resolve, reject) => {
    stream.on("error", reject);
    stream.on("finish", resolve);
    stream.end(body);
  });
}

function textField(row: object, key: string): string {
  const value: unknown = Object.entries(row).find(([name]) => name === key)?.[1];
  if (typeof value !== "string") throw new Error(`${key} is not text`);
  return value;
}

function countField(row: object, key: string): bigint {
  const value: unknown = Object.entries(row).find(([name]) => name === key)?.[1];
  if (typeof value === "bigint") return value;
  if (typeof value === "string" || typeof value === "number") return BigInt(value);
  throw new Error(`${key} is not a count`);
}

export interface LoadOptions {
  readonly purpose?: Purpose;
  readonly createWorkspace?: boolean;
}

/**
 * Load one CSV into a workspace in one transaction. Throws LoadError.
 * No error names the file or repeats case text or question text; a restricted workspace's file
 * name is sent only as sha256 and length.
 */
export async function loadFile(sql: Db, workspace: string, path: string, options: LoadOptions = {}): Promise<LoadResult> {
  const purpose = options.purpose ?? "records";
  if (purpose !== "records" && purpose !== "labels") throw new Error("purpose must be records or labels");
  const bytes = await Bun.file(path).bytes();
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    throw new LoadError(["file is not valid UTF-8"]);
  }
  const { errors, rows } = validate(text);
  if (errors.length > 0) throw new LoadError(withholdText(errors, rows));
  const stored = storageErrors(rows);
  if (stored.length > 0) throw new LoadError(stored);
  const name = basename(path);
  try {
    return await sql.begin(async (tx) => {
      if (options.createWorkspace === true) await ensureWorkspace(tx, workspace);
      await tx`drop table if exists pg_temp.jnj_stage`;
      await tx.unsafe(
        `create temp table jnj_stage (line integer not null, ${COLUMNS.map((c) => `${c} text not null`).join(", ")})` +
          " on commit drop",
      );
      const stream = await tx.unsafe(`copy pg_temp.jnj_stage (line, ${COLUMNS.join(", ")}) from stdin`).writable();
      await copyRows(stream, rows);
      const policy = await tx`select content_policy from jnj.workspace where slug = ${workspace}`;
      const synthetic = policy.length === 1 && policy[0] !== undefined && textField(policy[0], "content_policy") === "synthetic";
      const [result] = await tx`
        select status, answers, labels
        from jnj.load_stage(${workspace}, ${sha256(bytes)}, ${sha256(name)}, ${codePoints(name)},
                            ${synthetic ? name : null}, ${purpose})`;
      if (result === undefined) throw new Error("jnj.load_stage returned no row");
      return {
        status: textField(result, "status"),
        answers: countField(result, "answers"),
        labels: countField(result, "labels"),
      };
    });
  } catch (error) {
    if (error instanceof postgres.PostgresError) throw new LoadError([error.message || error.name]);
    throw error;
  }
}
