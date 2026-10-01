// Wilson score interval and Newcombe's paired method 10 for the accept-rate difference (T5, R5.e).
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
