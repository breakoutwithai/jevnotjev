// Shared command-line plumbing for the db commands: argument parsing and the connection string.

import type { Io } from "../format/cli.ts";

export type { Io } from "../format/cli.ts";

export const MISSING_DSN = "set JNJ_DATABASE_URL to a libpq connection string";

export interface Parsed {
  readonly positional: readonly string[];
  readonly flags: ReadonlySet<string>;
  readonly options: ReadonlyMap<string, string>;
}

/** Split argv into positionals, boolean flags and --name value options; unknown names are an error. */
export function parseArgs(
  argv: readonly string[],
  spec: { flags: readonly string[]; options: readonly string[] },
): Parsed | string {
  const positional: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--") || arg === "--") {
      positional.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (spec.flags.includes(name) && inline === undefined) flags.add(name);
    else if (spec.options.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) return `argument --${name}: expected one argument`;
      options.set(name, value);
    } else return `unrecognized arguments: ${arg}`;
  }
  return { positional, flags, options };
}

/** Print usage and an argument error to stderr; exit code 2, as argparse does. */
export function usageError(io: Io, usage: string, message: string): number {
  io.err(usage);
  io.err(`error: ${message}`);
  return 2;
}

export function processIo(): Io {
  return {
    out: (line) => process.stdout.write(line + "\n"),
    err: (line) => process.stderr.write(line + "\n"),
  };
}
