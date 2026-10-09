// D15.l: examples/d15-sheet-check/compare.csv is the workbook's Check sheet as LibreOffice recalculated it
// (bun mods/math-check/compare-csv.ts). Every figure scripts/math-check.ts --json compares must sit on a row the
// engine marked CHECKED (or APP-READ for the bootstrap bounds), with the engine's Hand value equal to the app value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseCsv, toCsv } from "../../scripts/math-check.ts";
import { checkCompare, fixturePlaces } from "./compare-csv.ts";
import { runMathCheck } from "./export.ts";

const D15 = fileURLToPath(new URL("../../examples/d15-sheet-check/records.csv", import.meta.url));
const COMPARE = fileURLToPath(new URL("../../examples/d15-sheet-check/compare.csv", import.meta.url));

/** compare.csv with one cell (1-based row, 0-based column) replaced. */
function plant(csv: string, row: number, column: number, value: string): string {
  const rows = parseCsv(csv);
  const target = rows[row - 1];
  if (target === undefined) throw new Error(`no row ${row}`);
  target[column] = value;
  return toCsv(rows);
}

describe("compare.csv", () => {
  const csv = readFileSync(COMPARE, "utf8");
  const { code, report } = runMathCheck(D15, null);
  const places = fixturePlaces(report);
  const rowOf = (key: string): number => places.get(key)?.row ?? 0;

  test("[unit] D15.l compare.csv matches math-check output", () => {
    expect(code).toBe(0);
    expect(report.compared).toBeGreaterThanOrEqual(20);
    const result = checkCompare(csv, report, places);
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(report.compared);
  });

  test("[unit] D15.l a changed Hand value, status, result line or per-case line in compare.csv fails", () => {
    const count = plant(csv, rowOf("q1:numbers.jevVsLlm.a"), 1, "999");
    expect(checkCompare(count, report, places).problems.some((p) => p.startsWith("q1:numbers.jevVsLlm.a:"))).toBe(true);
    const rate = plant(csv, rowOf("q1:numbers.jevVsLlm.jev.acceptRate"), 1, "0.5");
    expect(checkCompare(rate, report, places).problems.some((p) => p.startsWith("q1:numbers.jevVsLlm.jev.acceptRate:"))).toBe(true);
    const status = plant(csv, rowOf("q1:numbers.jevVsLlm.n"), 3, "DIFF");
    expect(checkCompare(status, report, places).problems.some((p) => p.includes("status DIFF"))).toBe(true);
    const line = csv.replace(/^"q2 ([^"]*) 0 differ, /m, '"q2 $1 1 differ, ');
    expect(line).not.toBe(csv);
    expect(checkCompare(line, report, places).problems.some((p) => p.startsWith("result line:"))).toBe(true);
    const perCaseKey = report.figures.find((f) => f.group === "figure" && f.key.startsWith("q1:numbers.jevVsLlm.cases["))?.key ?? "(none)";
    const perCase = plant(csv, rowOf(perCaseKey), 0, "per-case costs: 79/80 match");
    expect(checkCompare(perCase, report, places).problems.some((p) => p.startsWith(`${perCaseKey}:`))).toBe(true);
  });
});
