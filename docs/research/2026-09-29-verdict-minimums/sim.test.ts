import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { invNormal, partA, partB, render, SEED, type SimSizes } from "./sim.ts";

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

  test("[unit] R6 inverse normal matches known quantiles", () => {
    expect(invNormal(0.5)).toBeCloseTo(0, 9);
    expect(invNormal(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(invNormal(0.01)).toBeCloseTo(-2.3263478740408408, 8);
  });
});
