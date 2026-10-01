import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { genCases, invNormal, makeRng, partA, partB, render, SEED, type SimSizes } from "./sim.ts";

const TINY: SimSizes = { repsNewcombe: 20, repsBootstrap: 4, bootA: 50, repsB: 4, bootB: 50 };

function tinyRun(seed: number): string {
  return render(partA(seed, TINY), partB(seed + 1, TINY), TINY);
}

// Numbers vary in width, so each run of spaces plus a number reads as one token.
function layout(text: string): string {
  return text.replace(/ *\d+(\.\d+)?/g, "#");
}

describe("verdict-minimums simulation (#38)", () => {
  test("[unit] R6 sim is deterministic for a seed", () => {
    expect(tinyRun(SEED)).toBe(tinyRun(SEED));
    expect(tinyRun(SEED)).not.toBe(tinyRun(SEED + 7));
  });

  test("[unit] R6 sim output keeps the committed sim_out.txt layout", async () => {
    const committed = await Bun.file(join(import.meta.dir, "..", "..", "decision", "sim_out.txt")).text();
    expect(layout(tinyRun(SEED))).toBe(layout(committed));
  });

  test("[unit] R6 sim rejects counts that are not positive integers", () => {
    const bad = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of bad) {
      expect(() => partA(SEED, { ...TINY, bootA: value })).toThrow(RangeError);
      expect(() => partA(SEED, { ...TINY, repsNewcombe: value })).toThrow(RangeError);
      expect(() => partA(SEED, { ...TINY, repsBootstrap: value })).toThrow(RangeError);
      expect(() => partB(SEED, { ...TINY, repsB: value })).toThrow(RangeError);
      expect(() => partB(SEED, { ...TINY, bootB: value })).toThrow(RangeError);
    }
  });

  test("[unit] R6 sim rejects a correlation outside [-1, 1]", () => {
    const rng = makeRng(SEED);
    for (const rho of [1.5, -1.01, Number.NaN]) expect(() => genCases(rng, 10, 0.8, 0.8, rho)).toThrow(RangeError);
    expect(genCases(rng, 10, 0.8, 0.8, 1).jev.length).toBe(10);
  });

  test("[unit] R6 sim labels each interval with its own test-set count", () => {
    const text = tinyRun(SEED);
    expect(text).toContain("-- interval = newcombe  reps=20\n");
    expect(text).toContain("-- interval = bootstrap  reps=4\n");
    expect(text).not.toMatch(/== PART A .*reps=/);
  });

  test("[unit] R6 inverse normal matches known quantiles", () => {
    expect(invNormal(0.5)).toBeCloseTo(0, 9);
    expect(invNormal(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(invNormal(0.01)).toBeCloseTo(-2.3263478740408408, 8);
  });
});
