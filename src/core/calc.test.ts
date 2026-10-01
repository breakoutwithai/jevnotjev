import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "../format/validate.ts";
import {
  costRatio,
  costRatioInterval,
  EmptySampleError,
  fileSeed,
  mulberry32,
  newcombePaired,
  pairedPhi,
  percentile,
  resampleCostRatios,
  RESAMPLES,
  wilson,
  type CostCase,
} from "./calc.ts";
import { cohortMetrics, cohorts, pairedCostCases } from "./metrics.ts";

const TINY = fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url));
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

/** d06 decision points, Jev against the LLM, read through validate() and cohortMetrics(). */
function tinyPairs() {
  const result = validate(readFileSync(TINY, "utf8"));
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  return cohorts(result.rows).map((key) => {
    const pair = cohortMetrics(result.rows, key).jevVsLlm;
    if (pair === null) throw new Error(`${key.questionId}: no Jev and LLM pair`);
    return pair;
  });
}

function side(spendUsd: number, accepted: number) {
  return { spendUsd, accepted };
}

/** A generator that returns the given uniforms in order, then fails: the test controls every draw. */
function scripted(values: readonly number[]): () => number {
  let next = 0;
  return () => {
    const value = values[next];
    if (value === undefined) throw new Error(`scripted generator ran out after ${next} draws`);
    next += 1;
    return value;
  };
}

describe("calc: cost ratio and its resampled interval", () => {
  test("[unit] R5.f d06 q1 ratio 0.0125 and q2 0.01", () => {
    const [q1, q2] = tinyPairs();
    const ratio = (pair: NonNullable<typeof q1>): number | null => {
      if (pair.jev.spend.kind !== "complete" || pair.otherArm.spend.kind !== "complete") throw new Error("spend incomplete");
      return costRatio(side(pair.jev.spend.usd, pair.jev.accepted), side(pair.otherArm.spend.usd, pair.otherArm.accepted));
    };
    expect(ratio(q1!)).toBeCloseTo(0.0125, 12);
    expect(ratio(q2!)).toBeCloseTo(0.01, 12);
  });

  test("[unit] R5.f ratio is 0 when the LLM has 0 accepted, infinity when Jev has 0, none when both have 0", () => {
    expect(costRatio(side(0.0006, 30), side(0.06, 0))).toBe(0);
    expect(costRatio(side(0.0006, 0), side(0.06, 27))).toBe(Number.POSITIVE_INFINITY);
    expect(costRatio(side(0.0006, 0), side(0.06, 0))).toBeNull();
  });

  test("[unit] R5.g both-zero resample is redrawn", () => {
    // Case 0: both accepted. Case 1: both rejected. Draw 1 picks case 1 twice (both 0 accepted),
    // so it is thrown away; draw 2 picks case 0 then case 1 and is kept.
    const cases: readonly CostCase[] = [
      { jevAccepted: true, jevCostUsd: 0.00002, llmAccepted: true, llmCostUsd: 0.002 },
      { jevAccepted: false, jevCostUsd: 0.00002, llmAccepted: false, llmCostUsd: 0.002 },
    ];
    const run = resampleCostRatios(cases, scripted([0.9, 0.9, 0.1, 0.9]), 1);
    expect(run.redrawn).toBe(1);
    expect(run.ratios).toHaveLength(1);
    // Kept draw: Jev 0.00004 / 1, LLM 0.004 / 1.
    expect(run.ratios[0]).toBeCloseTo(0.01, 12);
  });

  test("[unit] R5.g 2,000 resamples on the paired cases, 2.5th and 97.5th percentiles", () => {
    const [q1] = tinyPairs();
    const cases = pairedCostCases(q1!);
    if (cases === null) throw new Error("d06 q1 has a missing cost");
    const seed = 20261002;
    const got = costRatioInterval(cases, seed);
    expect(RESAMPLES).toBe(2000);
    expect(got.resamples).toBe(2000);
    // Same draws by hand: every resample's ratio from the same generator, sorted, then the percentiles.
    const run = resampleCostRatios(cases, mulberry32(seed), 2000);
    const sorted = Float64Array.from(run.ratios).sort();
    expect(got.lower).toBe(percentile(sorted, 2.5));
    expect(got.upper).toBe(percentile(sorted, 97.5));
    expect(got.redrawn).toBe(run.redrawn);
    // d06 q1: Jev rejects only cv4, so each resample's ratio is 0.01 x (LLM accepted / Jev accepted), at least 0.01.
    expect(got.lower).toBeGreaterThanOrEqual(0.01 - 1e-15);
    expect(got.lower).toBeLessThanOrEqual(got.upper);
  });

  test("[unit] R5.g percentile handles infinite ratios without NaN", () => {
    const sorted = Float64Array.from([0.5, 1, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]);
    expect(percentile(sorted, 100)).toBe(Number.POSITIVE_INFINITY);
    expect(percentile(sorted, 0)).toBe(0.5);
    expect(Number.isNaN(percentile(sorted, 90))).toBe(false);
  });

  test("[unit] R13.a same file gives identical interval twice", async () => {
    const text = readFileSync(TINY, "utf8");
    const seed = await fileSeed(text);
    // The seed is the first 32 bits of the SHA-256 of the file text (plan.md "Reproducibility").
    const digest = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(seed).toBe(Number.parseInt(digest.slice(0, 8), 16));
    expect(await fileSeed(text)).toBe(seed);
    const [q1] = tinyPairs();
    const cases = pairedCostCases(q1!);
    if (cases === null) throw new Error("d06 q1 has a missing cost");
    const first = costRatioInterval(cases, seed);
    const second = costRatioInterval(cases, await fileSeed(readFileSync(TINY, "utf8")));
    expect(second).toEqual(first);
    // A changed file gives a different seed.
    expect(await fileSeed(`${text}\n`)).not.toBe(seed);
  });
});
