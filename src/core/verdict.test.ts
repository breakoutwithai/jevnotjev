import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, buildFiles, quad, render, type Label } from "../../examples/d08-verdicts/make.ts";
import { validate } from "../format/validate.ts";
import { fileSeed } from "./calc.ts";
import { cohortMetrics, cohorts } from "./metrics.ts";
import { verdict, type Verdict } from "./verdict.ts";

const D08 = fileURLToPath(new URL("../../examples/d08-verdicts/", import.meta.url));
const TINY = fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url));

/** Every decision point's verdict for a file's text, seeded from the file as the page does. */
async function verdictsOf(text: string): Promise<Verdict[]> {
  const result = validate(text);
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  const seed = await fileSeed(text);
  return cohorts(result.rows).map((key) => verdict(cohortMetrics(result.rows, key), seed));
}

/** The one verdict of a single-question d08 file. */
async function d08(name: string): Promise<Verdict> {
  const all = await verdictsOf(readFileSync(`${D08}${name}.csv`, "utf8"));
  expect(all).toHaveLength(1);
  const [only] = all;
  if (only === undefined) throw new Error(`${name}: no decision point`);
  return only;
}

describe("[unit] d08 fixtures", () => {
  test("[unit] R6.b d08 files are exactly the make.ts output", () => {
    const built = buildFiles();
    const committed = readdirSync(D08).filter((name) => name.endsWith(".csv")).sort();
    expect(committed).toEqual([...built.keys()].sort());
    for (const [name, text] of built) expect(readFileSync(`${D08}${name}`, "utf8")).toBe(text);
  });
});

describe("verdict: rule 1, not enough evidence", () => {
  test("[unit] R6.b each d08 rule-1 file gives not enough evidence naming its condition", async () => {
    const expected: readonly [string, Verdict["condition"], string][] = [
      ["r1-no-jev", "no-jev-rows", "no Jev results"],
      ["r1-no-llm", "no-llm-rows", "no LLM results"],
      ["r1-29-paired", "too-few-paired", "add 1 more labelled case"],
      ["r1-both-zero", "both-zero-accepted", "neither answer is being accepted"],
      ["r1-cost-missing", "cost-missing", "cost missing"],
    ];
    for (const [name, condition, phrase] of expected) {
      const got = await d08(name);
      expect({ name, verdict: got.verdict, rule: got.rule, condition: got.condition }).toEqual({
        name,
        verdict: "not enough evidence",
        rule: 1,
        condition,
      });
      expect(got.reason).toContain(phrase);
    }
  });

  test("[unit] R6.b 29 paired cases asks for 1 more, the others give no count", async () => {
    const short = await d08("r1-29-paired");
    expect(short.addN).toBe(1);
    expect(short.numbers.jevVsLlm?.n).toBe(29);
    expect((await d08("r1-both-zero")).addN).toBeNull();
  });

  test("[unit] R6.f no Jev rows is never don't use Jev", async () => {
    const got = await d08("r1-no-jev");
    expect(got.verdict).toBe("not enough evidence");
    expect(got.reason).toBe("not enough evidence: no Jev results");
  });

  test("[unit] R6.h with no Jev rows the rule comparison is skipped for that reason", async () => {
    expect((await d08("r1-no-jev")).ruleComparison).toEqual({ kind: "skipped", reason: "no Jev rows", paired: 0 });
  });

  test("[unit] R6.g d06 q1 add 25 and q2 add 26", async () => {
    const [q1, q2] = await verdictsOf(readFileSync(TINY, "utf8"));
    expect(q1).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "too-few-paired", addN: 25 });
    expect(q2).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "too-few-paired", addN: 26 });
    expect(q1?.reason).toContain("add 25 more labelled cases");
    expect(q2?.reason).toContain("add 26 more labelled cases");
    // 5 paired rule cases: the rule comparison is skipped and says so.
    expect(q1?.ruleComparison).toEqual({ kind: "skipped", reason: "fewer than 30 paired rule cases", paired: 5 });
  });
});

describe("verdict: rule 2, don't use Jev", () => {
  test("[unit] R6.c rule within 10 points of Jev on 30 paired rule cases", async () => {
    const got = await d08("r2-rule-within-margin");
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "rule-within-margin" });
    if (got.ruleComparison.kind !== "compared") throw new Error("rule comparison skipped");
    expect(got.ruleComparison.n).toBe(30);
    expect(got.ruleComparison.diff).toBeCloseTo(0.1, 12);
    expect(got.ruleComparison.lower).toBeGreaterThan(-0.1);
  });

  test("[unit] R6.c Jev clearly worse than the LLM", async () => {
    const got = await d08("r2-jev-worse");
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "jev-clearly-worse" });
    expect(got.numbers.jevVsLlm?.upper).toBeLessThan(-0.1);
  });

  test("[unit] R6.c Jev 0 accepted and the LLM some", async () => {
    const got = await d08("r2-jev-zero");
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "jev-zero-accepted" });
    // On its own: the accept-rate upper bound is not below -0.10, so the earlier condition does not fire.
    expect(got.numbers.jevVsLlm?.upper).toBeGreaterThan(-0.1);
  });

  test("[unit] R6.c cost ratio lower bound above 1", async () => {
    const got = await d08("r2-jev-dearer");
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "jev-clearly-dearer" });
    expect(got.numbers.costRatio?.ratio).toBeCloseTo(1.8, 12);
    expect(got.numbers.costRatio?.lower).toBeGreaterThan(1);
  });
});

describe("verdict: rules 3 and 4", () => {
  test("[unit] R6.d use Jev when the accept-rate lower bound is above -0.10 and the ratio is 0.8 or less with upper bound below 1", async () => {
    const got = await d08("r3-use-jev");
    expect(got).toMatchObject({ verdict: "use Jev", rule: 3, condition: "use-jev", addN: null });
    expect(got.numbers.jevVsLlm?.lower).toBeGreaterThan(-0.1);
    expect(got.numbers.costRatio?.ratio).toBeCloseTo(0.009, 12);
    expect(got.numbers.costRatio?.upper).toBeLessThan(1);
    // The rule was compared on 30 cases and is far behind, so rule 2 did not fire.
    expect(got.ruleComparison).toMatchObject({ kind: "compared", n: 30 });
  });

  test("[unit] R6.d no other d08 file gives use Jev", async () => {
    const others = readdirSync(D08)
      .filter((name) => name.endsWith(".csv") && name !== "r3-use-jev.csv")
      .map((name) => name.slice(0, -4));
    expect(others).toHaveLength(11);
    for (const name of others) expect({ name, verdict: (await d08(name)).verdict }).not.toEqual({ name, verdict: "use Jev" });
  });

  test("[unit] R6.e accept-rate lower bound not above -0.10 names the accept-rate condition", async () => {
    const got = await d08("r4-accept-rate");
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 4, condition: "accept-rate-not-shown", addN: null });
    expect(got.numbers.jevVsLlm?.lower).toBeLessThanOrEqual(-0.1);
    expect(got.reason).toContain("-0.10");
  });

  test("[unit] R6.e cost ratio between 0.8 and 1 reads cheaper, but by less than 20%", async () => {
    const got = await d08("r4-cheaper-under-20");
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 4, condition: "cheaper-by-less-than-20" });
    expect(got.numbers.costRatio?.ratio).toBeCloseTo(0.9, 12);
    expect(got.reason).toContain("cheaper, but by less than 20%");
    // Its upper bound is 1 as well: both unmet rule-3 conditions are named.
    expect(got.unmet).toEqual(["cheaper-by-less-than-20", "cost-upper-bound-not-below-1"]);
  });
});

describe("verdict: order", () => {
  test("[unit] R6.a first match wins: 29 paired cases with Jev clearly worse is rule 1, not rule 2", async () => {
    const [got] = await verdictsOf(render(build({ name: "order", pairs: quad(14, 0, 15, 0) })));
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "too-few-paired", addN: 1 });
    expect(got?.numbers.jevVsLlm?.upper).toBeLessThan(-0.1);
  });

  test("[unit] R6.a rule 2 conditions in order: the rule within margin fires before Jev 0 accepted", async () => {
    // Rule 3 of 30, Jev 0 of 30: rule minus Jev is 0.1 and its lower bound is above -0.10.
    const rule = Array.from({ length: 30 }, (_, i): Label => (i < 3 ? "A" : "R"));
    const [got] = await verdictsOf(render(build({ name: "order2", pairs: quad(0, 0, 1, 29), rule })));
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "rule-within-margin" });
  });
});

describe("verdict: cost edge cases", () => {
  test("[unit] R5.f all costs $0 gives not enough evidence with no cost ratio, not a throw", async () => {
    const [got] = await verdictsOf(render(build({ name: "free", pairs: quad(27, 3, 0, 0), jevCost: 0, llmCost: 0 })));
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "no-cost-ratio", addN: null });
    expect(got?.reason).toContain("no cost ratio");
  });

  test("[unit] R5.g some $0 cases: a resample with both costs per accepted $0 is redrawn", async () => {
    // Only c01 costs anything; a resample that never draws it has both costs per accepted at $0.
    const freeCases = Array.from({ length: 71 }, (_, i) => i + 1);
    const [got] = await verdictsOf(render(build({ name: "mostly-free", pairs: quad(72, 0, 0, 0), freeCases })));
    expect(got).toMatchObject({ verdict: "use Jev", rule: 3 });
    expect(got?.numbers.costRatio?.ratio).toBeCloseTo(0.01, 12);
    expect(got?.numbers.costRatio?.redrawn).toBeGreaterThan(0);
  });

  test("[unit] R6.d exactly 20% cheaper passes rule 3 despite float sums", async () => {
    // 72 cases, both accept all: 72 x 0.0016 / 72 over 72 x 0.002 / 72 sums to 0.8000000000000002.
    const [got] = await verdictsOf(render(build({ name: "boundary", pairs: quad(72, 0, 0, 0), jevCost: 0.0016, llmCost: 0.002 })));
    expect(got?.numbers.costRatio?.ratio).toBeGreaterThan(0.8);
    expect(got).toMatchObject({ verdict: "use Jev", rule: 3, condition: "use-jev" });
  });

  test("[unit] R6.a costs too large to sum give not enough evidence, never use Jev", async () => {
    const [got] = await verdictsOf(render(build({ name: "huge", pairs: quad(27, 3, 0, 0), jevCost: 1e307, llmCost: 1e307 })));
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "cost-not-finite" });
  });
});

describe("verdict: cost guards come after the cost-free rules", () => {
  test("[unit] R6.a all costs $0 with Jev clearly worse is don't use Jev, not no-cost-ratio", async () => {
    const [got] = await verdictsOf(render(build({ name: "free-worse", pairs: quad(15, 0, 15, 0), jevCost: 0, llmCost: 0 })));
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "jev-clearly-worse" });
    expect(got?.numbers.jevVsLlm?.upper).toBeCloseTo(-0.2969, 4);
  });

  test("[unit] R6.a no verdict number or reason is NaN", async () => {
    const texts = readdirSync(D08)
      .filter((name) => name.endsWith(".csv"))
      .map((name) => readFileSync(`${D08}${name}`, "utf8"));
    texts.push(readFileSync(TINY, "utf8"));
    const edge: readonly Parameters<typeof build>[0][] = [
      { name: "free", pairs: quad(27, 3, 0, 0), jevCost: 0, llmCost: 0 },
      { name: "huge", pairs: quad(27, 3, 0, 0), jevCost: 1e307, llmCost: 1e307 },
      { name: "skewed", pairs: quad(27, 3, 0, 0), jevCost: 1e300, llmCost: 1e-10 },
      { name: "boundary", pairs: quad(72, 0, 0, 0), jevCost: 0.0016, llmCost: 0.002 },
    ];
    for (const spec of edge) texts.push(render(build(spec)));
    let checked = 0;
    for (const text of texts) {
      for (const got of await verdictsOf(text)) {
        expect(got.reason).not.toContain("NaN");
        const numbers: number[] = [];
        JSON.stringify(got, (_, value: unknown) => {
          if (typeof value === "number") numbers.push(value);
          return value;
        });
        expect(numbers.filter((value) => Number.isNaN(value))).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(18);
  });
});
