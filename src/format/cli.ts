// Validate a Jev!Jev eval record CSV against format jnj-record/1.
//
// Usage: bun src/format/cli.ts <record.csv>
// Exit 0 when the file is valid (gaps are reported, not errors); exit 1 on errors.

import { decodeUtf8, report, validate } from "./validate.ts";

export const USAGE = `Validate a Jev!Jev eval record CSV against format jnj-record/1.

Usage: bun src/format/cli.ts <record.csv>
Exit 0 when the file is valid (gaps are reported, not errors); exit 1 on errors.`;

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export async function main(argv: readonly string[], io: Io): Promise<number> {
  const [path, ...extra] = argv;
  if (path === undefined || extra.length > 0) {
    io.out(USAGE);
    return 2;
  }
  let text: string;
  try {
    text = decodeUtf8(await Bun.file(path).bytes());
  } catch (error) {
    io.err(`ERROR cannot read ${path} in UTF-8: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const { lines, exitCode } = report(validate(text));
  for (const line of lines) io.out(line);
  return exitCode;
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2), {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  });
  process.exit(code);
}
