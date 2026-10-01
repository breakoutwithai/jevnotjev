// The verdict for one decision point (T8, R6.a to R6.g).
// The rules are docs/decision/verdict-rules.md "Verdict, in order, first match wins", and only those:
// rule 1 not enough evidence, rule 2 don't use Jev, rule 3 use Jev, rule 4 not enough evidence otherwise.
// Pure: no Node or Bun APIs, so the browser can import it.

import { costRatio, costRatioInterval, newcombePaired, type CostRatioInterval, type PairedCounts } from "./calc.ts";
import { pairedCostCases, type CohortMetrics, type PairedSample } from "./metrics.ts";

/** Minimum paired labelled cases (verdict-rules.md "Settings"). */
export const MIN_PAIRED = 30;
/** Accept-rate margin: 10 points. */
export const MARGIN = 0.1;
/** Cost ratio to count as cheaper. */
export const CHEAPER = 0.8;
/**
 * Tolerance on the cost comparisons (0.8 and 1). Spend is a float sum, so a ratio that is exactly 0.8 in
 * decimal can come out as 0.8000000000000002; a value within this distance of a bound counts as on it.
 */
export const COST_TOLERANCE = 1e-9;

export type VerdictName = "use Jev" | "don't use Jev" | "not enough evidence";

export type Condition =
    // Rule 1 additions, not in verdict-rules.md: the cost ratio cannot be computed
  | "no-cost-ratio"
  | "cost-not-finite"
// Rule 1
  | "no-jev-rows"
  | "no-llm-rows"
  | "too-few-paired"
  | "both-zero-accepted"
  | "cost-missing"
  // Rule 2
  | "rule-within-margin"
  | "jev-clearly-worse"
  | "jev-zero-accepted"
  | "jev-clearly-dearer"
  // Rule 3
  | "use-jev"
  // Rule 4: which rule-3 condition was not met
  | "accept-rate-not-shown"
  | "cheaper-by-less-than-20"
  | "not-cheaper"
  | "cost-upper-bound-not-below-1";

/** Jev against another answerer on paired cases: counts, rates and the Newcombe 95% interval. */
export interface Comparison extends PairedCounts {
  readonly n: number;
  readonly p1: number;
  readonly p2: number;
  readonly diff: number;
  readonly lower: number;
  readonly upper: number;
}

export interface RatioNumbers extends CostRatioInterval {
  readonly ratio: number;
}

/** Rule against Jev, rule first (rule minus Jev), or why it was skipped. */
export type RuleComparison =
  | { readonly kind: "skipped"; readonly reason: "no rule rows" | "fewer than 30 paired rule cases"; readonly paired: number }
  | ({ readonly kind: "compared" } & Comparison);

export interface VerdictNumbers {
  /** Jev minus the LLM; null when either has no rows or nothing is paired. */
  readonly jevVsLlm: Comparison | null;
  readonly jevAccepted: number | null;
  readonly llmAccepted: number | null;
  /** Null until rule 1 has passed: a ratio is only read once every paired cost is known. */
  readonly costRatio: RatioNumbers | null;
}

export interface Verdict {
  readonly verdict: VerdictName;
  readonly rule: 1 | 2 | 3 | 4;
  /** The condition that fired (rules 1 and 2), "use-jev" (rule 3), or the first unmet rule-3 condition (rule 4). */
  readonly condition: Condition;
  /** Rule 4 only: every rule-3 condition that was not met, in order. */
  readonly unmet: readonly Condition[];
  /** One line for the screen. */
  readonly reason: string;
  /** Labelled paired cases still needed when the file is short; null otherwise. */
  readonly addN: number | null;
  readonly numbers: VerdictNumbers;
  readonly ruleComparison: RuleComparison;
}

function compare(counts: PairedCounts): Comparison {
  const interval = newcombePaired(counts);
  return { ...counts, n: interval.n, p1: interval.p1, p2: interval.p2, diff: interval.diff, lower: interval.lower, upper: interval.upper };
}

/** Rule minus Jev: the pair's b (Jev only) and c (rule only) swap places. */
function ruleComparison(pair: PairedSample | null, hasRuleRows: boolean): RuleComparison {
  if (!hasRuleRows) return { kind: "skipped", reason: "no rule rows", paired: 0 };
  const paired = pair?.n ?? 0;
  if (pair === null || paired < MIN_PAIRED) return { kind: "skipped", reason: "fewer than 30 paired rule cases", paired };
  return { kind: "compared", ...compare({ a: pair.a, b: pair.c, c: pair.b, d: pair.d }) };
}

function plural(n: number): string {
  return n === 1 ? "1 more labelled case" : `${n} more labelled cases`;
}

function fixed(x: number): string {
  return x.toFixed(2);
}

/**
 * Apply the four rules in order to one decision point; the first match wins.
 * `seed` drives the cost ratio resample (fileSeed() of the file text), so the same file gives the same verdict.
 */
export function verdict(metrics: CohortMetrics, seed: number): Verdict {
  const hasArm = (arm: "jev" | "llm" | "rule"): boolean => metrics.arms.some((totals) => totals.arm === arm);
  const rule = ruleComparison(metrics.jevVsRule, hasArm("rule"));
  const pair = metrics.jevVsLlm;
  const jevVsLlm = pair === null || pair.n === 0 ? null : compare(pair);
  const base: VerdictNumbers = {
    jevVsLlm,
    jevAccepted: pair?.jev.accepted ?? null,
    llmAccepted: pair?.otherArm.accepted ?? null,
    costRatio: null,
  };
  const result = (
    verdictName: VerdictName,
    ruleNumber: Verdict["rule"],
    condition: Condition,
    reason: string,
    extra: { readonly addN?: number; readonly unmet?: readonly Condition[]; readonly numbers?: VerdictNumbers } = {},
  ): Verdict => ({
    verdict: verdictName,
    rule: ruleNumber,
    condition,
    unmet: extra.unmet ?? [],
    reason: `${verdictName}: ${reason}`,
    addN: extra.addN ?? null,
    numbers: extra.numbers ?? base,
    ruleComparison: rule,
  });
  const notEnough = (condition: Condition, reason: string, addN?: number): Verdict =>
    result("not enough evidence", 1, condition, reason, addN === undefined ? {} : { addN });

  // Rule 1: not enough evidence.
  if (!hasArm("jev")) return notEnough("no-jev-rows", "no Jev results");
  if (!hasArm("llm")) return notEnough("no-llm-rows", "no LLM results");
  if (pair === null || jevVsLlm === null || pair.n < MIN_PAIRED) {
    const n = pair?.n ?? 0;
    const add = MIN_PAIRED - n;
    return notEnough("too-few-paired", `${n} paired Jev and LLM cases, fewer than ${MIN_PAIRED}; add ${plural(add)}`, add);
  }
  if (pair.jev.accepted === 0 && pair.otherArm.accepted === 0) {
    return notEnough("both-zero-accepted", "Jev and the LLM both have 0 accepted; neither answer is being accepted");
  }
  const cases = pairedCostCases(pair);
  if (cases === null || pair.jev.spend.kind !== "complete" || pair.otherArm.spend.kind !== "complete") {
    return notEnough("cost-missing", "cost missing on a paired Jev or LLM row, so the cost ratio would look complete on partial spend");
  }
  // A resample can repeat the dearest case n times, so n x the largest cost must stay finite too.
  const largest = Math.max(...cases.map((one) => Math.max(one.jevCostUsd, one.llmCostUsd)));
  if (!Number.isFinite(pair.jev.spend.usd) || !Number.isFinite(pair.otherArm.spend.usd) || !Number.isFinite(largest * cases.length)) {
    return notEnough("cost-not-finite", "costs too large to add up, so there is no cost ratio");
  }
  const ratio = costRatio(
    { spendUsd: pair.jev.spend.usd, accepted: pair.jev.accepted },
    { spendUsd: pair.otherArm.spend.usd, accepted: pair.otherArm.accepted },
  );
  if (ratio === null) return notEnough("no-cost-ratio", "Jev and the LLM both cost $0 per accepted answer, so there is no cost ratio");
  if (Number.isNaN(ratio)) return notEnough("cost-not-finite", "the cost ratio is not a number");

  // Rule 2: don't use Jev, conditions in the order verdict-rules.md lists them.
  const dont = (condition: Condition, reason: string, numbers?: VerdictNumbers): Verdict =>
    result("don't use Jev", 2, condition, reason, numbers === undefined ? {} : { numbers });
  if (rule.kind === "compared" && rule.lower > -MARGIN) {
    return dont("rule-within-margin", `the rule is within 10 points of Jev (lower bound of rule minus Jev ${fixed(rule.lower)}, above -0.10, on ${rule.n} paired cases); a free rule does the job`);
  }
  if (jevVsLlm.upper < -MARGIN) {
    return dont("jev-clearly-worse", `Jev is clearly worse than the LLM (upper bound of Jev minus LLM ${fixed(jevVsLlm.upper)}, below -0.10)`);
  }
  if (pair.jev.accepted === 0) {
    return dont("jev-zero-accepted", `Jev has 0 accepted and the LLM has ${pair.otherArm.accepted}`);
  }
  const ci: RatioNumbers = { ratio, ...costRatioInterval(cases, seed) };
  const numbers: VerdictNumbers = { ...base, costRatio: ci };
  if (ci.lower > 1 + COST_TOLERANCE) {
    return dont("jev-clearly-dearer", `Jev is clearly dearer (cost ratio ${ratio.toFixed(3)}, lower bound ${ci.lower.toFixed(3)}, above 1)`, numbers);
  }

  // Rule 3: use Jev when every condition holds; rule 4 names the ones that did not.
  const unmet: Condition[] = [];
  if (!(jevVsLlm.lower > -MARGIN)) unmet.push("accept-rate-not-shown");
  if (ratio > CHEAPER + COST_TOLERANCE) unmet.push(ratio < 1 - COST_TOLERANCE ? "cheaper-by-less-than-20" : "not-cheaper");
  if (!(ci.upper < 1 - COST_TOLERANCE)) unmet.push("cost-upper-bound-not-below-1");
  const [first] = unmet;
  if (first === undefined) {
    return result("use Jev", 3, "use-jev", `Jev is within 10 points of the LLM (lower bound ${fixed(jevVsLlm.lower)}) and costs ${ratio.toFixed(3)} of it per accepted answer (upper bound ${ci.upper.toFixed(3)})`, { numbers });
  }
  const said: Partial<Record<Condition, string>> = {
    "accept-rate-not-shown": `Jev is not shown within 10 points of the LLM (lower bound of Jev minus LLM ${fixed(jevVsLlm.lower)}, not above -0.10)`,
    "cheaper-by-less-than-20": `cheaper, but by less than 20% (cost ratio ${ratio.toFixed(3)})`,
    "not-cheaper": `Jev is not cheaper (cost ratio ${ratio.toFixed(3)})`,
    "cost-upper-bound-not-below-1": `the cost ratio's upper bound ${ci.upper.toFixed(3)} is not below 1`,
  };
  return result("not enough evidence", 4, first, unmet.map((condition) => said[condition] ?? condition).join("; "), { unmet, numbers });
}
