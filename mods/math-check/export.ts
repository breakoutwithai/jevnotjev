// D15 (PR B): export a records file, or its last N cases, to the "check the math by hand" workbook.
//
// Run: bun mods/math-check/export.ts <records.csv> [--last N] [--out <file.xlsx>]
//   --last N   the last N distinct case_id values in order of first appearance (fewer than N cases is an error)
//   --out F    the workbook path; default jnj-math-check/<run_id>-last<N>-<yyyymmdd-hhmm>.xlsx under the current
//              directory. An existing file is never overwritten.
// The app's figures and the figure keys come only from `bun scripts/math-check.ts <file> [--last N] --json`, run as a
// separate process. Exit: math-check's own code (0 match, 1 mismatch, 3 nothing compared) once the workbook is
// written; 2 on bad input or when no workbook was written. Spends 0: nothing here calls a provider.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkbook, parseReport, selectRows, WorkbookError, type MathCheckReport } from "./xlsx.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const MATH_CHECK = join(ROOT, "scripts", "math-check.ts");
const COVERAGE = join(ROOT, "examples", "d15-sheet-check", "coverage.md");

export type ExportArgs = { readonly file: string; readonly last: number | null; readonly out: string | null };

export function parseArgs(argv: readonly string[]): ExportArgs {
  let file: string | null = null;
  let last: number | null = null;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--last") {
      const v = argv[i + 1] ?? "";
      if (!/^[1-9]\d*$/.test(v)) throw new WorkbookError(`--last needs a whole number of cases above 0, got "${v}"`);
      last = Number(v);
      i += 1;
    } else if (a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v === "") throw new WorkbookError("--out needs a file");
      out = v;
      i += 1;
    } else if (a.startsWith("--")) throw new WorkbookError(`unknown option ${a}`);
    else if (file === null) file = a;
    else throw new WorkbookError(`one records file only, got ${file} and ${a}`);
  }
  if (file === null) throw new WorkbookError("usage: bun mods/math-check/export.ts <records.csv> [--last N] [--out <file.xlsx>]");
  return { file, last, out };
}

/** math-check's --json report and exit code for the file, from its stdout (exit 0, 1 or 3). */
export function runMathCheck(file: string, last: number | null): { readonly code: number; readonly report: MathCheckReport } {
  const args = [MATH_CHECK, file, ...(last === null ? [] : ["--last", String(last)]), "--json"];
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  if (res.error !== undefined) throw new WorkbookError(`math-check failed to run: ${res.error.message}`);
  if (res.status === null || ![0, 1, 3].includes(res.status)) throw new WorkbookError(`math-check exited ${String(res.status)}: ${res.stderr.trim()}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new WorkbookError(`math-check printed no JSON report (${res.stdout.length} characters)`);
  }
  return { code: res.status, report: parseReport(parsed) };
}

/** jevnotjev's git SHA, from `git rev-parse HEAD`. */
export function gitSha(): string {
  const res = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" });
  const sha = res.status === 0 ? res.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown (git rev-parse HEAD failed)";
}

function stamp(now: Date): string {
  const two = (v: number): string => String(v).padStart(2, "0");
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`;
}

function defaultOut(records: string, last: number | null, cases: number): string {
  const selected = selectRows(records, last);
  const at = selected.header.indexOf("run_id");
  const runId = (selected.rows[0]?.cells[at] ?? "records").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(process.cwd(), "jnj-math-check", `${runId}-last${cases}-${stamp(new Date())}.xlsx`);
}

/** The Summary sheet's sentence in words, from math-check's own counts: what the mod's toast says. */
export function summarySentence(report: MathCheckReport): string {
  if (report.compared === 0) return "No figures compared";
  return report.mismatches === 0 ? `All ${report.compared} figures match` : `${report.mismatches} of ${report.compared} differ`;
}

export type ExportResult ={ readonly code: number; readonly out: string; readonly err: string };

/** The whole command: returns the exit code and what to print. */
export function main(argv: readonly string[]): ExportResult {
  try {
    const args = parseArgs(argv);
    const file = resolve(args.file);
    let records: string;
    try {
      records = readFileSync(file, "utf8");
    } catch {
      throw new WorkbookError(`cannot read ${args.file}`);
    }
    // Inside the repo the source is named relative to it, so the workbook carries no home-directory path.
    const inRepo = relative(ROOT, file);
    const { code, report } = runMathCheck(inRepo.startsWith("..") || isAbsolute(inRepo) ? file : inRepo, args.last);
    const out = resolve(args.out ?? defaultOut(records, args.last, report.n));
    if (existsSync(out)) throw new WorkbookError(`${out} exists; a workbook is never overwritten`);
    const bytes = buildWorkbook({ report, records, last: args.last, sha: gitSha(), coverage: readFileSync(COVERAGE, "utf8") });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes, { flag: "wx" });
    const lines = [
      `source: ${args.file}`,
      `n: ${report.n}`,
      `selection: ${report.selection_rule}`,
      `math-check: compared ${report.compared}, mismatches ${report.mismatches} (exit ${code})`,
      `summary: ${summarySentence(report)}`,
      `workbook: ${out}`,
    ];
    return { code, out: lines.join("\n") + "\n", err: "" };
  } catch (error) {
    if (error instanceof WorkbookError) return { code: 2, out: "", err: `ERROR ${error.message}\n` };
    throw error;
  }
}

if (import.meta.main) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
