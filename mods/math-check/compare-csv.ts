// D15 (PR B, M7): the engine-recalculated record. Exports the D15 fixture's workbook with export.ts, has
// LibreOffice recalculate it headless (the workbook carries no cached values: fullCalcOnLoad), writes its one sheet
// ("Check") as examples/d15-sheet-check/compare.csv, then checks it against scripts/math-check.ts --json.
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
import { layoutWorkbook, SHEET_NAME, type KeyPlace, type MathCheckReport } from "./xlsx.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const D15 = join(ROOT, "examples", "d15-sheet-check", "records.csv");
const DEFAULT_OUT = join(ROOT, "examples", "d15-sheet-check", "compare.csv");
// LibreOffice's CSV filter: comma, double quote, UTF-8, from row 1, standard cells, default language, quoted text not
// forced to text, special numbers detected, cell values at full precision (not as shown), values not formulas,
// spaces kept, then the sheet to write (1-based: the only sheet).
const CSV_FILTER = "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,1";
/** The hidden column a row's second app value sits in (xlsx.ts ECHO_INDEX). */
const ECHO_COLUMN = 15;

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

/** Where each math-check figure sits on the fixture's sheet, from the writer's own layout. */
export function fixturePlaces(report: MathCheckReport): ReadonlyMap<string, KeyPlace> {
  return layoutWorkbook({ report, records: readFileSync(D15, "utf8"), last: null, sha: "" }).places;
}

export type CompareCheck = { readonly checked: number; readonly problems: readonly string[] };

/**
 * compare.csv against math-check's report: every compared figure on a row whose engine status is CHECKED (APP-READ
 * for a bootstrap bound), its engine Hand value within tolerance of the app value (the echo column for a second
 * figure on a row, the per-case line for per-case costs), and every result line at 0 differ.
 */
export function checkCompare(csv: string, report: MathCheckReport, places: ReadonlyMap<string, KeyPlace>): CompareCheck {
  const problems: string[] = [];
  const rows = parseCsv(csv);
  const lines = rows.map((r) => r[0] ?? "").filter((a) => a.endsWith(" app-read"));
  if (lines.length === 0) problems.push("result line: none in compare.csv");
  for (const line of lines) if (!line.includes(" 0 differ, ")) problems.push(`result line: ${line}`);
  const perCaseRows = new Map<number, number>();
  for (const p of places.values()) if (p.via === "per-case") perCaseRows.set(p.row, (perCaseRows.get(p.row) ?? 0) + 1);
  let checked = 0;
  for (const f of report.figures.filter((x) => x.group === "figure")) {
    const place = places.get(f.key);
    const row = place === undefined ? undefined : rows[place.row - 1];
    if (place === undefined || row === undefined) {
      problems.push(`${f.key}: no row in compare.csv`);
      continue;
    }
    checked += 1;
    const status = row[3] ?? "";
    const want = place.via === "bound" ? "APP-READ" : "CHECKED";
    if (status !== want) problems.push(`${f.key}: status ${status === "" ? "(blank)" : status}, expected ${want}`);
    if (place.via === "per-case") {
      const m = /^per-case costs: (\d+)\/(\d+) match$/.exec(row[0] ?? "");
      const total = perCaseRows.get(place.row) ?? 0;
      if (m === null || Number(m[1]) !== total || Number(m[2]) !== total) problems.push(`${f.key}: per-case line "${row[0] ?? ""}", expected ${total}/${total} match`);
      continue;
    }
    const tol = toleranceOf(f.key, f.tolerance);
    const engine = place.via === "echo" ? number(row[ECHO_COLUMN]) : number(row[1]);
    if (tol === null) problems.push(`${f.key}: no tolerance in "${f.tolerance}"`);
    else if (typeof f.app !== "number") problems.push(`${f.key}: app value ${JSON.stringify(f.app)} is not a number`);
    else if (engine === null) problems.push(`${f.key}: engine value "${(place.via === "echo" ? row[ECHO_COLUMN] : row[1]) ?? ""}" is not a number`);
    else if (place.via === "echo" ? engine !== f.app : !agrees(tol.kind, engine, f.app, tol.value)) problems.push(`${f.key}: engine ${engine} vs app ${f.app} outside ${f.tolerance}`);
  }
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
    const written = [join(dir, `d15-${SHEET_NAME}.csv`), join(dir, "d15.csv")].find((p) => existsSync(p));
    if (written === undefined) return { code: 2, out: `ERROR soffice wrote no CSV of the ${SHEET_NAME} sheet; files: ${readdirSync(dir).join(", ")}\n` };
    const csv = readFileSync(written, "utf8");
    writeFileSync(out, csv);
    const { report } = runMathCheck(D15, null);
    const result = checkCompare(csv, report, fixturePlaces(report));
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
