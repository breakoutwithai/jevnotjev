// Load a jnj-record/1 CSV into Postgres.
//
// Usage: JNJ_DATABASE_URL=<dsn> bun src/db/load-cli.ts [--labels] [--create-workspace] <workspace> <record.csv>

import { MISSING_DSN, parseArgs, processIo, usageError, type Io } from "./cli.ts";
import { connect } from "./connect.ts";
import { LoadError, loadFile } from "./load.ts";

const USAGE = "usage: bun src/db/load-cli.ts [--labels] [--create-workspace] <workspace> <record.csv>";

export async function main(argv: readonly string[], io: Io, env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const parsed = parseArgs(argv, { flags: ["labels", "create-workspace", "help"], options: [] });
  if (typeof parsed === "string") return usageError(io, USAGE, parsed);
  if (parsed.flags.has("help")) {
    io.out(USAGE);
    return 0;
  }
  const [workspace, path, ...extra] = parsed.positional;
  if (workspace === undefined || path === undefined) {
    return usageError(io, USAGE, "the following arguments are required: workspace, path");
  }
  if (extra.length > 0) return usageError(io, USAGE, `unrecognized arguments: ${extra.join(" ")}`);
  const dsn = env["JNJ_DATABASE_URL"];
  if (!dsn) {
    io.err(MISSING_DSN);
    return 2;
  }
  const sql = connect(dsn);
  try {
    const result = await loadFile(sql, workspace, path, {
      purpose: parsed.flags.has("labels") ? "labels" : "records",
      createWorkspace: parsed.flags.has("create-workspace"),
    });
    io.out(`${result.status} answers=${result.answers} labels=${result.labels}`);
    return 0;
  } catch (error) {
    if (!(error instanceof LoadError)) throw error;
    for (const message of error.messages) io.err(`ERROR ${message}`);
    return 1;
  } finally {
    await sql.end();
  }
}

if (import.meta.main) process.exit(await main(Bun.argv.slice(2), processIo(), process.env));
