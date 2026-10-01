// Test helpers: paths, the throwaway database, CSV writers and the round-trip equivalence rule.
//
// The run creates one database jnj_test_<hex> on the server named by JNJ_TEST_ADMIN_DSN (default: the
// unix socket in /tmp, port 5432) the first time a test asks for it, migrates it, and drops it
// WITH (FORCE) after the last test (setup.ts). There is no skip: a missing server is a failure.

import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { formatRow, formatRows, readRecords } from "../../format/csv.ts";
import { connect, type Db, type Query } from "../connect.ts";
import { decimalEquals } from "../decimal.ts";
import { LoadError } from "../load.ts";
import { migrate } from "../migrate.ts";

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const EXAMPLE = join(ROOT, "format", "example-v1.csv");
export const D06 = join(ROOT, "examples", "d06-tiny", "records.csv");
export const ADMIN_DSN = process.env["JNJ_TEST_ADMIN_DSN"] ?? "host=/tmp port=5432 dbname=postgres";
const NUMERIC_COLUMNS = new Set(["confidence", "cost_usd", "tokens_in", "tokens_out", "latency_ms"]);

let databaseName: Promise<string> | undefined;
const temporary: string[] = [];

async function createDatabase(): Promise<string> {
  const name = `jnj_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = connect(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.end();
  }
  const conn = connect(ADMIN_DSN, { max: 1, database: name });
  try {
    await migrate(conn);
  } finally {
    await conn.end();
  }
  return name;
}

/** The run's throwaway database name, created and migrated on first use. */
export function database(): Promise<string> {
  databaseName ??= createDatabase();
  return databaseName;
}

/** A libpq connection string for the test database (for the command-line entry points). */
export async function databaseDsn(): Promise<string> {
  const name = await database();
  if (/^postgres(ql)?:\/\//.test(ADMIN_DSN)) {
    const url = new URL(ADMIN_DSN);
    url.pathname = `/${name}`;
    return url.toString();
  }
  return `${ADMIN_DSN} dbname=${name}`;
}

/** Drop the test database WITH (FORCE) and remove temp dirs; runs once after the last test. */
export async function dropDatabase(): Promise<void> {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (databaseName === undefined) return;
  const name = await databaseName;
  const admin = connect(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
  } finally {
    await admin.end();
  }
}

/** A one-session connection to the test database (SET ROLE and temp tables stay on it). */
export async function openConnection(options: { debug?: (id: number, query: string, parameters: readonly unknown[]) => void } = {}): Promise<Db> {
  return connect(ADMIN_DSN, { max: 1, database: await database(), ...options });
}

/** A fresh connection per test. */
export function useConnection(): () => Db {
  let current: Db | undefined;
  beforeEach(async () => {
    current = await openConnection();
  });
  afterEach(async () => {
    await current?.end();
    current = undefined;
  });
  return () => {
    if (current === undefined) throw new Error("no connection outside a test");
    return current;
  };
}

/** A fresh temp directory, removed after the run. */
export function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "jnj-test-"));
  temporary.push(dir);
  return dir;
}

/** Create a workspace as the admin (only the admin may mark one synthetic). */
export async function makeWorkspace(conn: Query, policy: "synthetic" | "restricted" = "synthetic"): Promise<string> {
  const slug = `ws-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await conn`insert into jnj.workspace (slug, content_policy) values (${slug}, ${policy})`;
  return slug;
}

export interface Csv {
  header: string[];
  rows: string[][];
}

/** Write rows to a CSV file with LF endings and minimal quoting. */
export function writeCsv(path: string, header: readonly string[], rows: readonly (readonly string[])[]): string {
  writeFileSync(path, formatRow(header) + formatRows(rows), "utf8");
  return path;
}

export async function readCsv(path: string): Promise<Csv> {
  const [first, ...rest] = readRecords(await Bun.file(path).text());
  return { header: [...(first?.fields ?? [])], rows: rest.map((record) => [...record.fields]) };
}

export function exampleRows(): Promise<Csv> {
  return readCsv(EXAMPLE);
}

/** Index of a column in a header, failing the test if it is absent. */
export function col(header: readonly string[], name: string): number {
  const index = header.indexOf(name);
  if (index < 0) throw new Error(`no column ${name}`);
  return index;
}

/** Set one cell in place. */
export function setCell(rows: string[][], row: number, index: number, value: string): void {
  const target = rows.at(row);
  if (target === undefined) throw new Error(`no row ${row}`);
  target[index] = value;
}

export function cellOf(rows: readonly (readonly string[])[], row: number, index: number): string {
  const value = rows.at(row)?.[index];
  if (value === undefined) throw new Error(`no cell ${row},${index}`);
  return value;
}

export async function count(conn: Query, table: string, workspace: string): Promise<number> {
  const [row] = await conn.unsafe(
    `select count(*)::integer as n from jnj.${table} t join jnj.workspace w on w.id = t.workspace_id where w.slug = $1`,
    [workspace],
  );
  const n: unknown = row?.["n"];
  if (typeof n !== "number") throw new Error("count returned no number");
  return n;
}

export type Respelled = [number, string, string, string];

/**
 * Compare two CSV texts under the round-trip rule. Header and row order must match and every text
 * cell must be identical. A numeric cell may differ in spelling only when both sides are equal as
 * decimals (1.8e-06 == 0.0000018). Returns the cells that differ in spelling only; throws otherwise.
 */
export function numericOnlyDifferences(sourceText: string, exportedText: string): Respelled[] {
  const source = readRecords(sourceText).map((record) => record.fields);
  const exported = readRecords(exportedText).map((record) => record.fields);
  const header = source[0] ?? [];
  if (JSON.stringify(header) !== JSON.stringify(exported[0] ?? [])) throw new Error("header differs");
  if (source.length !== exported.length) throw new Error(`row count differs: ${source.length} != ${exported.length}`);
  const respelled: Respelled[] = [];
  source.slice(1).forEach((left, offset) => {
    const right = exported[offset + 1] ?? [];
    header.forEach((column, index) => {
      const a = left[index] ?? "";
      const b = right[index] ?? "";
      if (a === b) return;
      const row = offset + 2;
      if (!NUMERIC_COLUMNS.has(column) || !a || !b) throw new Error(`row ${row} ${column}: ${a} != ${b}`);
      if (!decimalEquals(a, b)) throw new Error(`row ${row} ${column}: ${a} is not decimal-equal to ${b}`);
      respelled.push([row, column, a, b]);
    });
  });
  return respelled;
}

/** SQLSTATE codes the tests assert, by name. */
export const SQLSTATE: Readonly<Record<"foreignKeyViolation" | "checkViolation" | "uniqueViolation" | "raiseException" | "insufficientPrivilege", string>> = {
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  uniqueViolation: "23505",
  raiseException: "P0001",
  insufficientPrivilege: "42501",
};

/** The Postgres error a promise rejects with; fails if it resolves or rejects with anything else. */
export async function pgError(promise: Promise<unknown>): Promise<postgres.PostgresError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof postgres.PostgresError) return error;
    throw error;
  }
  throw new Error("expected a Postgres error, the statement succeeded");
}

class Rollback extends Error {}

/** Run statements in a transaction that is always rolled back; returns their result or error. */
export async function forceRollback<T>(conn: Db, work: (tx: Query) => Promise<T>): Promise<{ result?: T; error?: unknown }> {
  const outcome: { result?: T; error?: unknown } = {};
  try {
    await conn.begin(async (tx) => {
      try {
        outcome.result = await work(tx);
      } catch (error) {
        outcome.error = error;
      }
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return outcome;
}

/** The LoadError a load rejects with; fails if it succeeds or rejects with anything else. */
export async function loadError(promise: Promise<unknown>): Promise<LoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error("expected a LoadError, the load succeeded");
}
