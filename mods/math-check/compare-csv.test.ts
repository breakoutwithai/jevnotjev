// D15.l: examples/d15-sheet-check/compare.csv is the workbook's Compare sheet as LibreOffice recalculated it
// (bun mods/math-check/compare-csv.ts). Every Hand value there, computed by the spreadsheet engine's formulas, must
// equal the app value scripts/math-check.ts --json reads from the verdict command, within the stated tolerance.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCompare } from "./compare-csv.ts";
import { runMathCheck } from "./export.ts";

const D15 = fileURLToPath(new URL("../../examples/d15-sheet-check/records.csv", import.meta.url));
const COMPARE = fileURLToPath(new URL("../../examples/d15-sheet-check/compare.csv", import.meta.url));

/** compare.csv with the Hand cell of one figure row replaced. */
function plant(csv: string, key: string, hand: string): string {
  const lines = csv.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${key},`));
  if (i < 0) throw new Error(`no row for ${key}`);
  const cells = (lines[i] ?? "").split(",");
  cells[1] = hand;
  lines[i] = cells.join(",");
  return lines.join("\n");
}

describe("compare.csv", () => {
  const csv = readFileSync(COMPARE, "utf8");
  const { code, report } = runMathCheck(D15, null);

  test("[unit] D15.l compare.csv matches math-check output", () => {
    expect(code).toBe(0);
    expect(report.compared).toBeGreaterThanOrEqual(20);
    const result = checkCompare(csv, report);
    expect(result.problems).toEqual([]);
    expect(result.checked).toBe(report.figures.filter((f) => f.group === "figure").length);
    expect(result.checked).toBe(report.compared);
  });

  test("[unit] D15.l a changed Hand value, status or total in compare.csv fails", () => {
    const count = plant(csv, "q1:numbers.jevVsLlm.a", "999");
    expect(checkCompare(count, report).problems.some((p) => p.startsWith("q1:numbers.jevVsLlm.a:"))).toBe(true);
    const rate = plant(csv, "q1:numbers.jevVsLlm.jev.acceptRate", "0.5");
    expect(checkCompare(rate, report).problems.some((p) => p.startsWith("q1:numbers.jevVsLlm.jev.acceptRate:"))).toBe(true);
    const status = csv.replace(/^(q1:numbers\.jevVsLlm\.n,[^\n]*),OK,/m, "$1,MISMATCH,");
    expect(status).not.toBe(csv);
    expect(checkCompare(status, report).problems.some((p) => p.includes("status MISMATCH"))).toBe(true);
    const total = csv.replace(/^Compared,\d+/m, "Compared,1");
    expect(checkCompare(total, report).problems.some((p) => p.startsWith("Compared:"))).toBe(true);
    const dropped = csv.split("\n").filter((l) => !l.startsWith("q1:numbers.jevVsLlm.a,")).join("\n");
    expect(checkCompare(dropped, report).problems).toContain("q1:numbers.jevVsLlm.a: no row in compare.csv");
  });
});
