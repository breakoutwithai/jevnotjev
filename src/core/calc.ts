// Wilson score interval and Newcombe's paired method 10 for the accept-rate difference (T5, R5.e),
// and the cost ratio with its seeded paired-resample interval (T6, R5.f, R5.g, R13.a).
// Pure: no Node or Bun APIs, so the browser can import it.
// Formulas: docs/decision/verdict-rules.md "Formulas"; oracle: docs/decision/newcombe-table3.json.

/** z for a two-sided 95% interval. */
const Z = 1.959963984540054;

/** Thrown when an interval is asked for on zero cases: there is no rate to bound. */
export class EmptySampleError extends Error {
  constructor(what: string) {
    super(`${what}: n is 0, no interval`);
    this.name = "EmptySampleError";
  }
}

export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

/** Paired counts. a: both accepted; b: first only; c: second only; d: both rejected. */
export interface PairedCounts {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
}

export interface PairedDifference extends Interval {
  readonly n: number;
  readonly p1: number;
  readonly p2: number;
  /** p1 - p2. */
  readonly diff: number;
}

function checkCount(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer, got ${value}`);
}

/** Wilson 95% interval for successes / n. */
export function wilson(successes: number, n: number): Interval {
  checkCount("successes", successes);
  checkCount("n", n);
  if (successes > n) throw new RangeError(`successes ${successes} exceeds n ${n}`);
  if (n === 0) throw new EmptySampleError("wilson");
  const p = successes / n;
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const half = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const denom = 1 + z2 / n;
  // Clamp the exact ends so floating error never leaves 0 or 1 a hair off.
  return {
    lower: successes === 0 ? 0 : (centre - half) / denom,
    upper: successes === n ? 1 : (centre + half) / denom,
  };
}

/** phi for method 10: a*d - b*c reduced by n/2 (not below 0) when positive; 0 when the root is 0. */
export function pairedPhi({ a, b, c, d }: PairedCounts): number {
  const n = a + b + c + d;
  const root = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  if (root === 0) return 0;
  const raw = a * d - b * c;
  const corrected = raw > 0 ? Math.max(raw - n / 2, 0) : raw;
  return corrected / root;
}

/** Newcombe 1998 method 10: 95% interval for p1 - p2 on paired data. */
export function newcombePaired(counts: PairedCounts): PairedDifference {
  const { a, b, c, d } = counts;
  checkCount("a", a);
  checkCount("b", b);
  checkCount("c", c);
  checkCount("d", d);
  const n = a + b + c + d;
  if (n === 0) throw new EmptySampleError("newcombePaired");
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const diff = p1 - p2;
  const w1 = wilson(a + b, n);
  const w2 = wilson(a + c, n);
  const phi = pairedPhi(counts);
  const dl1 = p1 - w1.lower;
  const du1 = w1.upper - p1;
  const dl2 = p2 - w2.lower;
  const du2 = w2.upper - p2;
  // Floating error can push a zero radicand a hair negative.
  const lower = diff - Math.sqrt(Math.max(dl1 * dl1 - 2 * phi * dl1 * du2 + du2 * du2, 0));
  const upper = diff + Math.sqrt(Math.max(du1 * du1 - 2 * phi * du1 * dl2 + dl2 * dl2, 0));
  return { n, p1, p2, diff, lower, upper };
}

/** Paired resamples for the cost ratio interval (verdict-rules.md "Cost ratio interval"). */
export const RESAMPLES = 2000;

/** Spend and accepted count for one answerer over the paired cases. */
export interface CostSide {
  readonly spendUsd: number;
  readonly accepted: number;
}

/**
 * cost_per_accepted(jev) / cost_per_accepted(llm). 0 when the LLM has 0 accepted and Jev some;
 * infinity when Jev has 0 and the LLM some; null when both have 0 (no ratio, rule 1 stops first).
 */
export function costRatio(jev: CostSide, llm: CostSide): number | null {
  checkCount("jev accepted", jev.accepted);
  checkCount("llm accepted", llm.accepted);
  if (jev.accepted === 0 && llm.accepted === 0) return null;
  if (llm.accepted === 0) return 0;
  if (jev.accepted === 0) return Number.POSITIVE_INFINITY;
  const jevPer = jev.spendUsd / jev.accepted;
  const llmPer = llm.spendUsd / llm.accepted;
  if (llmPer === 0) {
    if (jevPer === 0) throw new RangeError("both costs per accepted are $0: no cost ratio");
    return Number.POSITIVE_INFINITY;
  }
  return jevPer / llmPer;
}

/** One paired case for the resample: both labels and both costs (a missing cost stops at rule 1 first). */
export interface CostCase {
  readonly jevAccepted: boolean;
  readonly jevCostUsd: number;
  readonly llmAccepted: boolean;
  readonly llmCostUsd: number;
}

export interface ResampleRun {
  /** One ratio per kept resample, in draw order. */
  readonly ratios: readonly number[];
  /** Resamples thrown away because both answerers had 0 accepted. */
  readonly redrawn: number;
}

export interface CostRatioInterval extends Interval {
  readonly resamples: number;
  readonly redrawn: number;
}

/** mulberry32: 32-bit state, uniform on [0, 1) in steps of 2^-32 (plan.md "Reproducibility"). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed for the resample: the first 32 bits of the SHA-256 of the file text, big-endian. */
export async function fileSeed(text: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return new DataView(digest).getUint32(0, false);
}

/**
 * Percentile of sorted values, linear interpolation between ranks (Hyndman and Fan type 7, as sim.ts uses).
 * Equal neighbours, including two infinities, return that value rather than NaN.
 */
export function percentile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) throw new EmptySampleError("percentile");
  const position = (q / 100) * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  const lo = sorted[below] ?? Number.NaN;
  const hi = sorted[above] ?? Number.NaN;
  if (lo === hi || position === below) return lo;
  return lo + (hi - lo) * (position - below);
}

/**
 * Draw `resamples` paired resamples of the cases with replacement and compute the cost ratio of each.
 * A resample where both answerers have 0 accepted has no ratio and is drawn again.
 */
export function resampleCostRatios(cases: readonly CostCase[], uniform: () => number, resamples: number): ResampleRun {
  checkCount("resamples", resamples);
  const n = cases.length;
  if (n === 0) throw new EmptySampleError("resampleCostRatios");
  if (!cases.some((one) => one.jevAccepted || one.llmAccepted)) {
    throw new RangeError("both answerers have 0 accepted on every case: no resample has a ratio");
  }
  const limit = 1000 * resamples + 1000;
  const ratios: number[] = [];
  let redrawn = 0;
  while (ratios.length < resamples) {
    let jevSpend = 0;
    let llmSpend = 0;
    let jevAccepted = 0;
    let llmAccepted = 0;
    for (let draw = 0; draw < n; draw += 1) {
      const picked = cases[Math.floor(uniform() * n)];
      if (picked === undefined) throw new RangeError("generator returned a value outside [0, 1)");
      jevSpend += picked.jevCostUsd;
      llmSpend += picked.llmCostUsd;
      if (picked.jevAccepted) jevAccepted += 1;
      if (picked.llmAccepted) llmAccepted += 1;
    }
    const ratio = costRatio({ spendUsd: jevSpend, accepted: jevAccepted }, { spendUsd: llmSpend, accepted: llmAccepted });
    if (ratio === null) {
      redrawn += 1;
      if (redrawn > limit) throw new RangeError(`more than ${limit} resamples had both at 0 accepted`);
      continue;
    }
    ratios.push(ratio);
  }
  return { ratios, redrawn };
}

/** 95% interval for the cost ratio: 2.5th and 97.5th percentiles of the seeded paired resamples. */
export function costRatioInterval(cases: readonly CostCase[], seed: number, resamples: number = RESAMPLES): CostRatioInterval {
  const run = resampleCostRatios(cases, mulberry32(seed), resamples);
  const sorted = Float64Array.from(run.ratios).sort();
  return { lower: percentile(sorted, 2.5), upper: percentile(sorted, 97.5), resamples, redrawn: run.redrawn };
}
