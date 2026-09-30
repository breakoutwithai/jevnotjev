// Apply pending migrations from db/migrations.
//
// Usage: JNJ_DATABASE_URL=<dsn> bun src/db/migrate-cli.ts

import { MISSING_DSN, reportFailure, processIo, type Io } from "./cli.ts";
import { connect, type Db } from "./connect.ts";
import { migrate, MigrationError } from "./migrate.ts";

export async function main(io: Io, env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const dsn = env["JNJ_DATABASE_URL"];
  if (!dsn) {
    io.err(MISSING_DSN);
    return 2;
  }
  let sql: Db;
  try {
    sql = connect(dsn);
  } catch (error) {
    return reportFailure(io, error);
  }
  try {
    const applied = await migrate(sql);
    io.out(applied.length > 0 ? applied.map((name) => `applied ${name}`).join("\n") : "up to date");
    return 0;
  } catch (error) {
    if (error instanceof MigrationError) {
      io.err(`ERROR ${error.message}`);
      return 1;
    }
    return reportFailure(io, error);
  } finally {
    await sql.end();
  }
}

if (import.meta.main) process.exit(await main(processIo(), process.env));
