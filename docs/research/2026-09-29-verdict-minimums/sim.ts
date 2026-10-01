// Minimum-evidence simulation behind the verdict rules (#38). Seed fixed: `bun sim.ts > ../../decision/sim_out.txt`.
// Part A: paired accept/reject decision rule, Newcombe paired interval and paired bootstrap.
// Part B: bootstrap CI width of cost per accepted result when costs differ 100x.
// ASSUMPTION (not from data): Jev and LLM outcomes on the same case are correlated via a Gaussian copula
// with latent correlation rho. Both 0.0 and 0.5 are run.
// Wilson and Newcombe come from src/core/calc.ts. Random numbers: mulberry32 (docs/spec/plan.md § Reproducibility),
// normals by Box-Muller. A different generator from the first run, so cells match within Monte Carlo error, not exactly.

import { type Interval, newcombePaired } from "../../../src/core/calc.ts";

export const SEED = 20260929;
export const NS: readonly number[] = [10, 20, 30, 50, 100];
export const PLLM: readonly number[] = [0.8, 0.9];
export const DROPS: readonly number[] = [0.0, 0.05, 0.1];
export const MARGINS: readonly number[] = [0.05, 0.1];
export const RHOS: readonly number[] = [0.0, 0.5];

/** Monte Carlo sizes. DEFAULT_SIZES reproduces sim_out.txt; tests pass smaller ones. */
export interface SimSizes {
  /** Test sets per cell, Newcombe interval. */
  readonly repsNewcombe: number;
  /** Test sets per cell, bootstrap interval. */
  readonly repsBootstrap: number;
  /** Resamples per bootstrap interval in Part A. */
  readonly bootA: number;
  /** Test sets per Part B row. */
  readonly repsB: number;
  /** Resamples per Part B bootstrap. */
  readonly bootB: number;
}

export const DEFAULT_SIZES: SimSizes = { repsNewcombe: 2000, repsBootstrap: 400, bootA: 1000, repsB: 300, bootB: 500 };

export interface Rng {
  /** Uniform on [0, 1). */
  readonly uniform: () => number;
  /** Standard normal. */
  readonly normal: () => number;
  /** Uniform integer on [0, n). */
  readonly int: (n: number) => number;
}

/** mulberry32: 32-bit state, uniform on [0, 1) in steps of 2^-32. */
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

/** Seeded generator; normals by Box-Muller, the second of each pair kept for the next call. */
export function makeRng(seed: number): Rng {
  const uniform = mulberry32(seed);
  let spare = Number.NaN;
  const normal = (): number => {
    if (!Number.isNaN(spare)) {
      const kept = spare;
      spare = Number.NaN;
      return kept;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - uniform()));
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  };
  const int = (n: number): number => Math.floor(uniform() * n);
  return { uniform, normal, int };
}

const ACKLAM_A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const ACKLAM_B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const ACKLAM_C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const ACKLAM_D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];

function poly(coefficients: readonly number[], x: number): number {
  return coefficients.reduce((sum, coefficient) => sum * x + coefficient, 0);
}

/** Inverse standard normal CDF (Acklam, relative error below 1.2e-9). */
export function invNormal(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`invNormal needs 0 < p < 1, got ${p}`);
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  }
  if (p > 1 - low) return -invNormal(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (poly(ACKLAM_A, r) * q) / (poly(ACKLAM_B, r) * r + 1);
}

/** Percentile of sorted values with linear interpolation between ranks (numpy's default). */
export function percentile(sorted: Float64Array, q: number): number {
  const position = (q / 100) * (sorted.length - 1);
  const below = Math.floor(position);
  const above = Math.min(below + 1, sorted.length - 1);
  const lo = sorted[below] ?? Number.NaN;
  const hi = sorted[above] ?? Number.NaN;
  return lo + (hi - lo) * (position - below);
}

function median(values: readonly number[]): number {
  const sorted = Float64Array.from(values).sort();
  return percentile(sorted, 50);
}

export interface Cases {
  readonly jev: Uint8Array;
  readonly llm: Uint8Array;
}

/** n paired cases; accept when the latent normal is below the quantile of the accept rate. */
export function genCases(rng: Rng, n: number, pLlm: number, pJev: number, rho: number): Cases {
  const jevCut = invNormal(pJev);
  const llmCut = invNormal(pLlm);
  const spread = Math.sqrt(1 - rho * rho);
  const jev = new Uint8Array(n);
  const llm = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const z1 = rng.normal();
    const z2 = rho * z1 + spread * rng.normal();
    jev[i] = z1 < jevCut ? 1 : 0;
    llm[i] = z2 < llmCut ? 1 : 0;
  }
  return { jev, llm };
}

type Decision = "ok" | "reject" | "nee";

function decide(lower: number, upper: number, margin: number): Decision {
  if (lower > -margin) return "ok";
  if (upper < -margin) return "reject";
  return "nee";
}

/** Paired bootstrap percentile interval of (Jev rate minus LLM rate), resampling whole cases. */
function bootPaired(rng: Rng, a: number, b: number, c: number, n: number, boots: number): Interval {
  const diffs = new Float64Array(boots);
  for (let k = 0; k < boots; k++) {
    let jevOnly = 0;
    let llmOnly = 0;
    for (let i = 0; i < n; i++) {
      const pick = rng.int(n);
      if (pick >= a && pick < a + b) jevOnly++;
      else if (pick >= a + b && pick < a + b + c) llmOnly++;
    }
    diffs[k] = (jevOnly - llmOnly) / n;
  }
  diffs.sort();
  return { lower: percentile(diffs, 2.5), upper: percentile(diffs, 97.5) };
}

export type Method = "newcombe" | "bootstrap";

/** Unrounded percentages of test sets per decision. */
export interface Shares {
  readonly ok: number;
  readonly reject: number;
  readonly nee: number;
}

function cellShares(rng: Rng, method: Method, setting: { n: number; pLlm: number; drop: number; rho: number; margin: number }, sizes: SimSizes): Shares {
  const { n, pLlm, drop, rho, margin } = setting;
  const reps = method === "newcombe" ? sizes.repsNewcombe : sizes.repsBootstrap;
  const counts: Record<Decision, number> = { ok: 0, reject: 0, nee: 0 };
  for (let rep = 0; rep < reps; rep++) {
    const { jev, llm } = genCases(rng, n, pLlm, pLlm - drop, rho);
    let a = 0;
    let b = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
      if (jev[i] && llm[i]) a++;
      else if (jev[i]) b++;
      else if (llm[i]) c++;
    }
    const d = n - a - b - c;
    const interval = method === "newcombe" ? newcombePaired({ a, b, c, d }) : bootPaired(rng, a, b, c, n, sizes.bootA);
    counts[decide(interval.lower, interval.upper, margin)]++;
  }
  return { ok: (100 * counts.ok) / reps, reject: (100 * counts.reject) / reps, nee: (100 * counts.nee) / reps };
}

export interface PartARow {
  readonly pLlm: number;
  readonly drop: number;
  readonly cells: readonly Shares[];
}

export interface PartABlock {
  readonly rho: number;
  readonly margin: number;
  readonly tables: readonly { readonly method: Method; readonly rows: readonly PartARow[] }[];
}

/** Part A: share of test sets reaching ok / reject / not enough evidence, per setting. One stream, in print order. */
export function partA(seed: number, sizes: SimSizes = DEFAULT_SIZES): PartABlock[] {
  const rng = makeRng(seed);
  const methods: readonly Method[] = ["newcombe", "bootstrap"];
  return RHOS.flatMap((rho) =>
    MARGINS.map((margin) => ({
      rho,
      margin,
      tables: methods.map((method) => ({
        method,
        rows: PLLM.flatMap((pLlm) =>
          DROPS.map((drop) => ({ pLlm, drop, cells: NS.map((n) => cellShares(rng, method, { n, pLlm, drop, rho, margin }, sizes)) })),
        ),
      })),
    })),
  );
}

export interface PartBRow {
  readonly n: number;
  readonly pLlm: number;
  /** Medians over reps of the 95% CI width as % of the point estimate. */
  readonly llmWidth: number;
  readonly jevWidth: number;
  readonly ratioWidth: number;
  /** % of reps where Jev has 2 or fewer accepts. */
  readonly fewJev: number;
}

const SIGMA = 0.5;
const LLM_COST = 0.01;
const JEV_COST = 0.0001;

function widthPct(values: Float64Array, point: number): number {
  const sorted = Float64Array.from(values).sort();
  return ((percentile(sorted, 97.5) - percentile(sorted, 2.5)) / point) * 100;
}

function sum(values: Uint8Array | Float64Array): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/** One Part B test set: the three widths, or undefined when the set is skipped (too few usable resamples). */
function costWidths(rng: Rng, n: number, cases: Cases, sizes: SimSizes): readonly [number, number, number] | undefined {
  const { jev, llm } = cases;
  const lognormal = (): number => Math.exp(-(SIGMA * SIGMA) / 2 + SIGMA * rng.normal());
  const costLlm = Float64Array.from({ length: n }, () => LLM_COST * lognormal());
  const costJev = Float64Array.from({ length: n }, () => JEV_COST * lognormal());
  const llmEach: number[] = [];
  const jevEach: number[] = [];
  for (let k = 0; k < sizes.bootB; k++) {
    let acceptedLlm = 0;
    let acceptedJev = 0;
    let totalLlm = 0;
    let totalJev = 0;
    for (let i = 0; i < n; i++) {
      const pick = rng.int(n);
      acceptedLlm += llm[pick] ?? 0;
      acceptedJev += jev[pick] ?? 0;
      totalLlm += costLlm[pick] ?? 0;
      totalJev += costJev[pick] ?? 0;
    }
    if (acceptedLlm > 0 && acceptedJev > 0) {
      llmEach.push(totalLlm / acceptedLlm);
      jevEach.push(totalJev / acceptedJev);
    }
  }
  const llmAccepted = sum(llm);
  const jevAccepted = sum(jev);
  if (llmEach.length < sizes.bootB * 0.5 || llmAccepted === 0 || jevAccepted === 0) return undefined;
  const pointLlm = sum(costLlm) / llmAccepted;
  const pointJev = sum(costJev) / jevAccepted;
  const ratio = Float64Array.from(llmEach, (value, i) => value / (jevEach[i] ?? Number.NaN));
  return [
    widthPct(Float64Array.from(llmEach), pointLlm),
    widthPct(Float64Array.from(jevEach), pointJev),
    widthPct(ratio, pointLlm / pointJev),
  ];
}

/** Part B: cost-per-accepted CI widths, rho 0.5, Jev drop 0.05. */
export function partB(seed: number, sizes: SimSizes = DEFAULT_SIZES): PartBRow[] {
  const rng = makeRng(seed);
  return PLLM.flatMap((pLlm) =>
    NS.map((n) => {
      const widths: (readonly [number, number, number])[] = [];
      let few = 0;
      for (let rep = 0; rep < sizes.repsB; rep++) {
        const cases = genCases(rng, n, pLlm, pLlm - 0.05, 0.5);
        if (sum(cases.jev) <= 2) few++;
        const w = costWidths(rng, n, cases, sizes);
        if (w) widths.push(w);
      }
      return {
        n,
        pLlm,
        llmWidth: median(widths.map((w) => w[0])),
        jevWidth: median(widths.map((w) => w[1])),
        ratioWidth: median(widths.map((w) => w[2])),
        fewJev: (100 * few) / sizes.repsB,
      };
    }),
  );
}

/** Fixed-point text with ties to even, as printf-style formatting of the exact binary value does. */
export function fixed(x: number, digits: number, width: number): string {
  const scale = 10 ** digits;
  const scaled = x * scale;
  const rounded = Number.isInteger(scaled - 0.5) ? 2 * Math.round(scaled / 2) : Math.round(scaled);
  return (rounded / scale).toFixed(digits).padStart(width);
}

function shareText(s: Shares): string {
  return `${fixed(s.ok, 0, 3)}/${fixed(s.reject, 0, 3)}/${fixed(s.nee, 0, 3)}`;
}

/** The text of sim_out.txt for these results. */
export function render(blocks: readonly PartABlock[], rows: readonly PartBRow[], sizes: SimSizes = DEFAULT_SIZES): string {
  const lines: string[] = [];
  const header = "p_llm  drop |" + NS.map((n) => `  n=${String(n).padEnd(3)}          `).join("");
  for (const block of blocks) {
    lines.push("", `== PART A  rho=${block.rho.toFixed(1)}  margin X=${block.margin.toFixed(2)}  reps=${sizes.repsNewcombe}  (cells: %ok / %reject / %not-enough)`);
    for (const table of block.tables) {
      lines.push(`-- interval = ${table.method}`, header);
      for (const row of table.rows) lines.push(`${row.pLlm.toFixed(1)}   ${row.drop.toFixed(2)} | ` + row.cells.map(shareText).join("   "));
    }
  }
  lines.push(
    "",
    "== PART B  cost per accepted, CI width as % of point estimate (median over reps)",
    "LLM mean cost/call $0.01, Jev $0.0001 (100x), lognormal sigma 0.5, rho=0.5, Jev drop 0.05",
    "cols: n | p_llm | LLM width% | Jev width% | ratio(LLM/Jev) width% | %reps Jev has <=2 accepts",
  );
  for (const row of rows) {
    const cells = [fixed(row.llmWidth, 0, 6), fixed(row.jevWidth, 0, 6), fixed(row.ratioWidth, 0, 6), fixed(row.fewJev, 1, 5)];
    lines.push(`n=${String(row.n).padEnd(3)} | ${row.pLlm.toFixed(1)} | ${cells.join(" | ")}`);
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const started = performance.now();
  const text = render(partA(SEED), partB(SEED + 1));
  process.stdout.write(text);
  process.stderr.write(`sim.ts: ${((performance.now() - started) / 1000).toFixed(1)} s\n`);
}
