// Apply numbered, forward-only SQL migrations and record each file's sha256.
//
// Files are db/migrations/NNNN_name.sql, applied in number order, one transaction per file.
// An applied file whose sha256 has changed stops the run: write a new migration instead.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "./connect.ts";

export const MIGRATIONS = fileURLToPath(new URL("../../db/migrations", import.meta.url));
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const LEDGER = `
create table if not exists public.jnj_schema_migration (
  number integer primary key,
  name text not null,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz not null default now()
)
`;

/** The migration set on disk disagrees with the ledger. */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

function fileNumber(name: string): number {
  const digits = NAME.exec(name)?.[1];
  if (digits === undefined) throw new Error(`${name} is not a migration file name`);
  return Number(digits);
}

function ledgerEntry(row: object): [number, string, string] {
  const entries = new Map<string, unknown>(Object.entries(row));
  const number = entries.get("number");
  const name = entries.get("name");
  const sha = entries.get("sha256");
  if (typeof number !== "number" || typeof name !== "string" || typeof sha !== "string") {
    throw new Error("unexpected jnj_schema_migration row");
  }
  return [number, name, sha];
}

/**
 * Apply pending migrations, one transaction per file, on one session holding an advisory lock.
 * Returns the names applied; throws MigrationError if an applied file changed or is missing,
 * or a new file is numbered below the latest applied one.
 */
export async function migrate(sql: Db, directory: string = MIGRATIONS): Promise<string[]> {
  const files = readdirSync(directory)
    .filter((name) => NAME.test(name))
    .sort();
  const applied: string[] = [];
  const session = await sql.reserve();
  try {
    await session`select pg_advisory_lock(hashtext('jnj_schema_migration'))`;
    try {
      await session.unsafe(LEDGER);
      const ledger = new Map<number, [string, string]>();
      for (const row of await session`select number, name, sha256 from public.jnj_schema_migration`) {
        const [number, name, sha] = ledgerEntry(row);
        ledger.set(number, [name, sha]);
      }
      const onDisk = new Map(files.map((name) => [fileNumber(name), name]));
      for (const [number, [name]] of [...ledger].sort(([a], [b]) => a - b)) {
        if (onDisk.get(number) !== name) throw new MigrationError(`${name} was applied but is missing from ${directory}`);
      }
      const latest = Math.max(0, ...ledger.keys());
      for (const [number, name] of [...onDisk].sort(([a], [b]) => a - b)) {
        if (!ledger.has(number) && number < latest) {
          throw new MigrationError(
            `${name} is numbered below applied migration ${String(latest).padStart(4, "0")}; renumber it above the latest`,
          );
        }
      }
      for (const name of files) {
        const number = fileNumber(name);
        const bytes = readFileSync(join(directory, name));
        const digest = createHash("sha256").update(bytes).digest("hex");
        const recorded = ledger.get(number);
        if (recorded !== undefined) {
          const [recordedName, recordedSha] = recorded;
          if (recordedName !== name || recordedSha !== digest) {
            throw new MigrationError(
              `${name} changed after it was applied (ledger has ${recordedName} sha256 ${recordedSha.slice(0, 12)}); ` +
                "write a new migration instead",
            );
          }
          continue;
        }
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        await session.unsafe("begin");
        try {
          await session.unsafe(text);
          await session`insert into public.jnj_schema_migration (number, name, sha256) values (${number}, ${name}, ${digest})`;
          await session.unsafe("commit");
        } catch (error) {
          await session.unsafe("rollback");
          throw error;
        }
        applied.push(name);
      }
    } finally {
      await session`select pg_advisory_unlock(hashtext('jnj_schema_migration'))`;
    }
  } finally {
    session.release();
  }
  return applied;
}
