// Export one run as jnj-record/1 CSV.
//
// Usage: JNJ_DATABASE_URL=<dsn> bun src/db/export-cli.ts <workspace> --run <run_id> > records.csv

import { MISSING_DSN, parseArgs, processIo, usageError, type Io } from "./cli.ts";
import { connect } from "./connect.ts";
import { ExportLookupError, exportCsv } from "./export.ts";

const USAGE = "usage: bun src/db/export-cli.ts <workspace> --run <run_id>";

export interface ExportIo extends Io {
  /** Raw CSV text, written as is. */
  readonly write: (text: string) => void;
}

export async function main(
  argv: readonly string[],
  io: ExportIo,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const parsed = parseArgs(argv, { flags: ["help"], options: ["run"] });
  if (typeof parsed === "string") return usageError(io, USAGE, parsed);
  if (parsed.flags.has("help")) {
    io.out(USAGE);
    return 0;
  }
  const [workspace, ...extra] = parsed.positional;
  const runId = parsed.options.get("run");
  if (runId === undefined) return usageError(io, USAGE, "the following arguments are required: --run");
  if (workspace === undefined) return usageError(io, USAGE, "the following arguments are required: workspace");
  if (extra.length > 0) return usageError(io, USAGE, `unrecognized arguments: ${extra.join(" ")}`);
  const dsn = env["JNJ_DATABASE_URL"];
  if (!dsn) {
    io.err(MISSING_DSN);
    return 2;
  }
  const sql = connect(dsn);
  try {
    const result = await exportCsv(sql, workspace, runId);
    for (const notice of result.notices) io.err(`NOTICE ${notice}`);
    io.write(result.text);
    return 0;
  } catch (error) {
    if (!(error instanceof ExportLookupError)) throw error;
    io.err(`ERROR ${error.message}`);
    return 1;
  } finally {
    await sql.end();
  }
}

if (import.meta.main) {
  const io = processIo();
  process.exit(await main(Bun.argv.slice(2), { ...io, write: (text) => process.stdout.write(text) }, process.env));
}
