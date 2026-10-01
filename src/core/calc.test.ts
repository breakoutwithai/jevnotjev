import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EmptySampleError, newcombePaired, pairedPhi, wilson } from "./calc.ts";

const TABLE = fileURLToPath(new URL("../../docs/decision/newcombe-table3.json", import.meta.url));

interface TableRow {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly lower: number;
  readonly upper: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number") throw new Error(`${key} is not a number`);
  return value;
}

/** Read the Table III oracle without casts: every field is checked. */
function loadTable(): { readonly tolerance: number; readonly rows: readonly TableRow[] } {
  const parsed: unknown = JSON.parse(readFileSync(TABLE, "utf8"));
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) throw new Error("bad newcombe-table3.json");
  const rows = parsed.rows.map((row: unknown): TableRow => {
    if (!isRecord(row)) throw new Error("bad row");
    return { a: num(row, "a"), b: num(row, "b"), c: num(row, "c"), d: num(row, "d"), lower: num(row, "lower"), upper: num(row, "upper") };
  });
  return { tolerance: num(parsed, "tolerance"), rows };
}

describe("calc: Wilson and Newcombe method 10", () => {
  test("[unit] R5.e Newcombe matches the 7 Table III rows", () => {
    const { tolerance, rows } = loadTable();
    let checked = 0;
    let largest = 0;
    for (const row of rows) {
      const got = newcombePaired(row);
      const dl = Math.abs(got.lower - row.lower);
      const du = Math.abs(got.upper - row.upper);
      expect(dl).toBeLessThanOrEqual(tolerance);
      expect(du).toBeLessThanOrEqual(tolerance);
      largest = Math.max(largest, dl, du);
      checked += 1;
    }
    console.log(`rows checked: ${checked}; largest |diff| vs Table III: ${largest.toExponential(3)}`);
    expect(checked).toBe(7);
  });

  test("[unit] R5.e Newcombe point values: p1, p2, diff and n", () => {
    const got = newcombePaired({ a: 2, b: 97, c: 1, d: 0 });
    expect(got.n).toBe(100);
    expect(got.p1).toBeCloseTo(0.99, 12);
    expect(got.p2).toBeCloseTo(0.03, 12);
    expect(got.diff).toBeCloseTo(0.96, 12);
  });

  test("[unit] R5.e Wilson(0, 30) is 0 to z^2 / (n + z^2)", () => {
    const z2 = 1.959963984540054 ** 2;
    const got = wilson(0, 30);
    expect(got.lower).toBe(0);
    expect(got.upper).toBeCloseTo(z2 / (30 + z2), 12);
    expect(got.upper).toBeCloseTo(0.1135, 4);
  });

  test("[unit] R5.e Wilson matches Newcombe 1998 (unpaired) textbook values", () => {
    const a = wilson(81, 263);
    expect(a.lower).toBeCloseTo(0.2553, 4);
    expect(a.upper).toBeCloseTo(0.3662, 4);
    const b = wilson(15, 148);
    expect(b.lower).toBeCloseTo(0.0624, 4);
    expect(b.upper).toBeCloseTo(0.1605, 4);
  });

  test("[unit] R5.e Wilson(n, n) upper is exactly 1", () => {
    expect(wilson(30, 30).upper).toBe(1);
  });

  test("[unit] R5.e phi: a*d - b*c is reduced by n/2 and not below 0", () => {
    // a*d - b*c = 1 and n/2 = 1: reduced to 0, so phi is 0, not 1.
    expect(pairedPhi({ a: 1, b: 0, c: 0, d: 1 })).toBe(0);
    // a*d - b*c = 12, n = 8: (12 - 4) / sqrt(6*2*6*2) = 8 / 12.
    expect(pairedPhi({ a: 6, b: 0, c: 0, d: 2 })).toBeCloseTo(8 / 12, 12);
    // A negative product is not reduced: (0 - 4) / sqrt(2*2*2*2).
    expect(pairedPhi({ a: 0, b: 2, c: 2, d: 0 })).toBeCloseTo(-1, 12);
  });

  test("[unit] R5.e phi is 0 when the root is 0", () => {
    // c + d = 0, so (a+b)(c+d)(a+c)(b+d) = 0.
    expect(pairedPhi({ a: 36, b: 14, c: 0, d: 0 })).toBe(0);
  });

  test("[unit] R5.e n = 0 throws EmptySampleError", () => {
    expect(() => wilson(0, 0)).toThrow(EmptySampleError);
    expect(() => newcombePaired({ a: 0, b: 0, c: 0, d: 0 })).toThrow(EmptySampleError);
  });

  test("[unit] R5.e invalid counts throw RangeError", () => {
    expect(() => wilson(5, 4)).toThrow(RangeError);
    expect(() => wilson(-1, 4)).toThrow(RangeError);
    expect(() => newcombePaired({ a: 1.5, b: 0, c: 0, d: 1 })).toThrow(RangeError);
  });
});
