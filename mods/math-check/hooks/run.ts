// D15 (PR B): the one path behind the "Check Jev!Jev math by hand" button and /jnj-math-check.
// It picks the records file, runs `bun mods/math-check/export.ts <csv> --last N` as a subprocess in the session's
// directory, reads the lines export.ts prints, and tries `open` on the workbook once. It never computes a figure:
// export.ts runs scripts/math-check.ts and writes the workbook. No imports: this file runs inside the mod's
// environment (no Node) and under bun test alike; the Host is the engine's $.fs and $.process, or a test's stand-in.

export const COMMAND = "jnj-math-check";
export const BUTTON_LABEL = "Check Jev!Jev math by hand";
export const DEFAULT_N = 30;
export const EXPORT_SCRIPT = "mods/math-check/export.ts";
export const GUARD_FILES: readonly string[] = ["scripts/math-check.ts", EXPORT_SCRIPT];
const RUNS_DIR = "docs/product/runs";
const USAGE = `usage: /${COMMAND} [N] [records.csv]`;

export type Entry = { readonly name: string; readonly kind: string };
export type RunResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
export type Host = {
  readonly exists: (path: string) => Promise<boolean>;
  readonly list: (path: string) => Promise<readonly Entry[]>;
  readonly run: (argv: readonly string[], cwd: string) => Promise<RunResult>;
};
export type Request = { readonly n: number; readonly csv: string | null };
export type Outcome = {
  readonly ok: boolean;
  /** The toast and the command's output: the Summary sentence, the workbook, the source and N; or the error. */
  readonly text: string;
  readonly argv: readonly string[] | null;
  readonly workbook: string | null;
  /** "opened", or "not opened: <why>", or null when no workbook was written. */
  readonly opened: string | null;
};

const at = (root: string, path: string): string => (path.startsWith("/") ? path : `${root.replace(/\/+$/, "")}/${path}`);

/** The guard: the session's directory is a jevnotjev checkout that holds the math check. */
export async function isRepo(host: Host, cwd: string): Promise<boolean> {
  for (const file of GUARD_FILES) if (!(await host.exists(at(cwd, file)))) return false;
  return true;
}

/** `/jnj-math-check [N] [records.csv]`: a whole number is N, anything else the records file, in either order. */
export function parseArgs(args: string): Request | { readonly error: string } {
  const words = args.trim().split(/\s+/).filter((w) => w !== "");
  let n: number | null = null;
  let csv: string | null = null;
  for (const word of words) {
    if (/^[+-]?\d+(\.\d*)?$/.test(word)) {
      if (n !== null) return { error: USAGE };
      if (!/^[1-9]\d*$/.test(word)) return { error: `N must be a whole number above 0, got "${word}"` };
      n = Number(word);
    } else {
      if (csv !== null) return { error: USAGE };
      csv = word;
    }
  }
  return { n: n ?? DEFAULT_N, csv };
}

/** The named csv (relative to the session's directory, or absolute), else the newest run folder by its name's date. */
export async function pickSource(host: Host, root: string, csv: string | null): Promise<{ readonly source: string } | { readonly error: string }> {
  if (csv !== null) return (await host.exists(at(root, csv))) ? { source: csv } : { error: `${csv}: no such file under ${root}` };
  let entries: readonly Entry[] = [];
  try {
    entries = await host.list(at(root, RUNS_DIR));
  } catch {
    entries = [];
  }
  // Newest by the folder name's date (yyyy-mm-dd- prefix), not by file time; one date's folders by name, last first.
  const dated = entries.filter((e) => e.kind === "dir" && /^\d{4}-\d{2}-\d{2}-/.test(e.name)).map((e) => e.name).sort().reverse();
  for (const name of dated) {
    const source = `${RUNS_DIR}/${name}/records.csv`;
    if (await host.exists(at(root, source))) return { source };
  }
  return { error: `no ${RUNS_DIR}/<date>-*/records.csv under ${root}; name a records.csv` };
}

/** The subprocess: export.ts names the workbook <cwd>/jnj-math-check/<run_id>-last<N>-<yyyymmdd-hhmm>.xlsx itself. */
export function exportArgv(source: string, n: number): readonly string[] {
  return ["bun", EXPORT_SCRIPT, source, "--last", String(n)];
}

function line(stdout: string, label: string): string | null {
  const found = stdout.split("\n").find((l) => l.startsWith(`${label}: `));
  return found === undefined ? null : found.slice(label.length + 2).trim();
}

/** The one function both the button and the command call. */
export async function check(host: Host, root: string, request: Request): Promise<Outcome> {
  const picked = await pickSource(host, root, request.csv);
  if ("error" in picked) return { ok: false, text: `math-check: ${picked.error}`, argv: null, workbook: null, opened: null };
  const said = `source ${picked.source}, N ${request.n}`;
  const argv = exportArgv(picked.source, request.n);
  let res: RunResult;
  try {
    res = await host.run(argv, root);
  } catch (error) {
    return { ok: false, text: `math-check: export did not run (${error instanceof Error ? error.message : String(error)}); ${said}`, argv, workbook: null, opened: null };
  }
  const workbook = line(res.stdout, "workbook");
  // export.ts exits 0 (all match), 1 (a mismatch) or 3 (nothing compared) once a workbook is written; 2 writes none.
  if (![0, 1, 3].includes(res.exitCode) || workbook === null) {
    const why = res.stderr.trim().replace(/^ERROR\s+/, "") || `export exited ${res.exitCode}`;
    return { ok: false, text: `math-check: ${why}; ${said}`, argv, workbook: null, opened: null };
  }
  const summary = line(res.stdout, "summary") ?? "no summary line";
  let opened: string;
  try {
    const o = await host.run(["open", workbook], root);
    opened = o.exitCode === 0 ? "opened" : `not opened: open exited ${o.exitCode} ${o.stderr.trim()}`.trim();
  } catch (error) {
    opened = `not opened: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { ok: true, text: `${summary}. ${workbook} (${said}; ${opened})`, argv, workbook, opened };
}

export const fromButton = (host: Host, root: string): Promise<Outcome> => check(host, root, { n: DEFAULT_N, csv: null });

export async function fromCommand(host: Host, root: string, args: string): Promise<Outcome> {
  const request = parseArgs(args);
  if ("error" in request) return { ok: false, text: `math-check: ${request.error}`, argv: null, workbook: null, opened: null };
  return check(host, root, request);
}
