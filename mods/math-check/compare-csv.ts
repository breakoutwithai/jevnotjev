// D15 (PR B, M7): the engine-recalculated record. Exports the D15 fixture's workbook with export.ts, has
// LibreOffice recalculate it headless (the workbook carries no cached values: fullCalcOnLoad), writes the Compare
// sheet as examples/d15-sheet-check/compare.csv, then checks it against scripts/math-check.ts --json.
//
// Run: bun mods/math-check/compare-csv.ts [--soffice <path>] [--out <compare.csv>]
//   --soffice  LibreOffice's soffice; default $SOFFICE, else soffice on PATH, else /opt/homebrew/bin/soffice
//   --out      default examples/d15-sheet-check/compare.csv
// Exit: 0 written and every figure agrees; 1 written but a figure disagrees (each named); 2 not written.
// Test data only: the fixture is fictional, so compare.csv is committed; a live run's workbook never is.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCsv } from "../../scripts/math-check.ts";
import { main as exportMain, runMathCheck } from "./export.ts";
import type { MathCheckReport } from "./xlsx.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const D15 = join(ROOT, "examples", "d15-sheet-check", "records.csv");
const DEFAULT_OUT = join(ROOT, "examples", "d15-sheet-check", "compare.csv");
const HEADER = ["Figure", "Hand", "App", "App minus Hand", "Tolerance kind", "Tolerance", "Status", "Differing so far"];
const COMPARE_SHEET = 5;
// LibreOffice's CSV filter: comma, double quote, UTF-8, from row 1, standard cells, default language, quoted text not
// forced to text, special numbers detected, cell values at full precision (not as shown), values not formulas,
// spaces kept, then the sheet to write (1-based).
const CSV_FILTER = `csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,${COMPARE_SHEET}`;

type Kind = "abs" | "rel" | "bound-lower" | "bound-upper";

/** The stated tolerance of a figure, from math-check's own words ("abs 1e-9", "rel 1e-9", "0 <= lower ..."). */
function toleranceOf(key: string, stated: string): { readonly kind: Kind; readonly value: number } | null {
  const m = /(\d+(?:\.\d+)?e[-+]?\d+)\s*$/i.exec(stated);
  if (m === null) return null;
  const value = Number(m[1]);
  if (stated.startsWith("abs ")) return { kind: "abs", value };
  if (stated.startsWith("rel ")) return { kind: "rel", value };
  if (stated.startsWith("0 <= lower")) return { kind: key.endsWith(".upper") ? "bound-upper" : "bound-lower", value };
  return null;
}

function agrees(kind: Kind, hand: number, app: number, tol: number): boolean {
  if (kind === "abs") return Math.abs(app - hand) <= tol;
  if (kind === "rel") return Math.abs(app - hand) <= tol * Math.max(Math.abs(hand), Math.abs(app));
  if (kind === "bound-lower") return app >= 0 && app <= hand + tol * Math.abs(hand);
  return app >= hand - tol * Math.abs(hand);
}

const number = (cell: string | undefined): number | null => (cell === undefined || cell.trim() === "" || !Number.isFinite(Number(cell)) ? null : Number(cell));

export type CompareCheck = { readonly checked: number; readonly problems: readonly string[] };

/**
 * compare.csv against math-check's report: one row per figure, its engine Hand value equal to the app value within
 * the stated tolerance, status OK, no extra rows, and the Compared and Mismatched totals equal to the counts.
 */
export function checkCompare(csv: string, report: MathCheckReport): CompareCheck {
  const problems: string[] = [];
  const rows = parseCsv(csv);
  const header = rows[0] ?? [];
  if (HEADER.some((h, i) => header[i] !== h)) problems.push(`header: ${header.join(",")}`);
  const blank = rows.findIndex((r, i) => i > 0 && r.every((c) => c.trim() === ""));
  const body = rows.slice(1, blank < 0 ? rows.length : blank);
  const byKey = new Map(body.map((r) => [r[0] ?? "", r]));
  const totals = new Map(rows.slice(blank < 0 ? rows.length : blank + 1).map((r) => [r[0] ?? "", r[1] ?? ""]));
  const figures = report.figures.filter((f) => f.group === "figure");
  let checked = 0;
  for (const f of figures) {
    const row = byKey.get(f.key);
    byKey.delete(f.key);
    if (row === undefined) {
      problems.push(`${f.key}: no row in compare.csv`);
      continue;
    }
    checked += 1;
    const tol = toleranceOf(f.key, f.tolerance);
    const hand = number(row[1]);
    if (tol === null) problems.push(`${f.key}: no tolerance in "${f.tolerance}"`);
    else if (typeof f.app !== "number") problems.push(`${f.key}: app value ${JSON.stringify(f.app)} is not a number`);
    else if (hand === null) problems.push(`${f.key}: Hand "${row[1] ?? ""}" is not a number`);
    else if (!agrees(tol.kind, hand, f.app, tol.value)) problems.push(`${f.key}: Hand ${hand} vs app ${f.app} outside ${f.tolerance}`);
    if (row[6] !== "OK") problems.push(`${f.key}: status ${row[6] ?? "(blank)"}`);
  }
  for (const key of byKey.keys()) problems.push(`${key}: in compare.csv, not in math-check's figures`);
  const compared = number(totals.get("Compared"));
  if (compared !== report.compared) problems.push(`Compared: ${String(compared)} in compare.csv, ${report.compared} from math-check`);
  const mismatched = number(totals.get("Mismatched (MISMATCH or ERROR)"));
  if (mismatched !== report.mismatches) problems.push(`Mismatched: ${String(mismatched)} in compare.csv, ${report.mismatches} from math-check`);
  return { checked, problems };
}

function sofficePath(given: string | null): string {
  if (given !== null) return given;
  if (process.env.SOFFICE !== undefined && process.env.SOFFICE !== "") return process.env.SOFFICE;
  const which = spawnSync("sh", ["-c", "command -v soffice"], { encoding: "utf8" });
  const found = which.stdout.trim();
  return which.status === 0 && found !== "" ? found : "/opt/homebrew/bin/soffice";
}

export function run(argv: readonly string[]): { readonly code: number; readonly out: string } {
  let soffice: string | null = null;
  let out = DEFAULT_OUT;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === "--soffice" || a === "--out") && v !== undefined && v !== "") {
      if (a === "--soffice") soffice = v;
      else out = v;
      i += 1;
    } else return { code: 2, out: `ERROR usage: bun mods/math-check/compare-csv.ts [--soffice <path>] [--out <compare.csv>] (got ${a ?? ""})\n` };
  }
  const dir = mkdtempSync(join(tmpdir(), "math-check-compare-"));
  try {
    const workbook = join(dir, "d15.xlsx");
    const exported = exportMain([D15, "--out", workbook]);
    if (exported.code !== 0) return { code: 2, out: `ERROR export exited ${exported.code}: ${exported.err}` };
    const bin = sofficePath(soffice);
    const res = spawnSync(bin, [`-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`, "--headless", "--convert-to", CSV_FILTER, "--outdir", dir, workbook], { encoding: "utf8", timeout: 180_000 });
    if (res.status !== 0) return { code: 2, out: `ERROR ${bin} exited ${String(res.status)}: ${res.stderr}` };
    const written = join(dir, "d15-Compare.csv");
    if (!existsSync(written)) return { code: 2, out: `ERROR soffice wrote no d15-Compare.csv; files: ${readdirSync(dir).join(", ")}\n` };
    const csv = readFileSync(written, "utf8");
    writeFileSync(out, csv);
    const { report } = runMathCheck(D15, null);
    const result = checkCompare(csv, report);
    const lines = [`soffice: ${bin}`, `wrote: ${out}`, `checked: ${result.checked} figures, problems ${result.problems.length}`, ...result.problems];
    return { code: result.problems.length === 0 ? 0 : 1, out: `${lines.join("\n")}\n` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.out);
  process.exitCode = result.code;
}
