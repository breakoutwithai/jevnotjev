import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, buildFiles, quad, render, type Label } from "../../examples/d08-verdicts/make.ts";
import { formatRow, readDictRows } from "../format/csv.ts";
import { validate } from "../format/validate.ts";
import { fileSeed } from "./calc.ts";
import { armsInFile, cohortMetrics, cohorts } from "./metrics.ts";
import { verdict, verdictLimitations, type Verdict } from "./verdict.ts";

const D08 = fileURLToPath(new URL("../../examples/d08-verdicts/", import.meta.url));
const TINY = fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url));
const D14 = fileURLToPath(new URL("../../examples/d14-gaps/records.csv", import.meta.url));

/** Verdicts that know every method the whole file has rows for, as the loader, result view and replay call it. */
async function fileVerdictsOf(text: string): Promise<Verdict[]> {
  const result = validate(text);
  if (result.errors.length > 0) throw new Error(result.errors.join("\n"));
  const seed = await fileSeed(text);
  const arms = armsInFile(result.rows);
  return cohorts(result.rows).map((key) => verdict(cohortMetrics(result.rows, key), seed, arms));
}

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
      ["r1-both-zero", "zero-accepted", "Jev and the LLM both accepted 0 of 30 paired cases"],
      ["r1-jev-zero", "zero-accepted", "Jev accepted 0 of 30 paired cases and the LLM 1"],
      ["r1-llm-zero", "zero-accepted", "the LLM accepted 0 of 30 paired cases and Jev 1"],
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

  test("[unit] D16 Jev 0 accepted and the LLM some is not enough evidence, not don't use Jev", async () => {
    const got = await d08("r1-jev-zero");
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "zero-accepted", addN: null });
    // The accept-rate upper bound is not below -0.10, so jev-clearly-worse does not fire first.
    expect(got.numbers.jevVsLlm?.upper).toBeGreaterThan(-0.1);
    expect(got.numbers.costRatio).toBeNull();
  });

  test("[unit] D16 the LLM 0 accepted and Jev some is not enough evidence, never use Jev on a ratio of 0", async () => {
    const got = await d08("r1-llm-zero");
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "zero-accepted", addN: null });
    expect(got.numbers.jevVsLlm?.lower).toBeGreaterThan(-0.1);
    expect(got.numbers.costRatio).toBeNull();
  });

  test("[unit] D16 order: Jev 0 of 30 with the LLM 30 of 30 is still don't use Jev, Jev clearly worse", async () => {
    // The zero guard runs after rule-within-margin and jev-clearly-worse, so an accept-rate verdict is kept.
    const [got] = await verdictsOf(render(build({ name: "jev-zero-llm-all", pairs: quad(0, 0, 30, 0) })));
    expect(got).toMatchObject({ verdict: "don't use Jev", rule: 2, condition: "jev-clearly-worse" });
    expect(got?.numbers.jevAccepted).toBe(0);
    expect(got?.numbers.llmAccepted).toBe(30);
  });

  test("[unit] D16 order: both 0 accepted with the rule within the margin is zero-accepted, never a free rule does the job", async () => {
    // Rule 3 of 30, Jev 0 of 30: rule minus Jev lower bound is above -0.10, but nothing Jev or the LLM said was accepted.
    const rule = Array.from({ length: 30 }, (_, i): Label => (i < 3 ? "A" : "R"));
    const [got] = await verdictsOf(render(build({ name: "both-zero-rule", pairs: quad(0, 0, 0, 30), rule })));
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "zero-accepted" });
    expect(got?.reason).toContain("both accepted 0 of 30 paired cases");
    if (got?.ruleComparison.kind !== "compared") throw new Error("rule comparison skipped");
    expect(got.ruleComparison.lower).toBeGreaterThan(-0.1);
  });

  test("[unit] D16 order: both 0 accepted with a missing cost is zero-accepted, before cost-missing", async () => {
    const [got] = await verdictsOf(render(build({ name: "both-zero-cost", pairs: quad(0, 0, 0, 30), jevCostMissing: [0] })));
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "zero-accepted" });
  });

  test("[unit] D16 order: the LLM 0 accepted with all costs $0 is zero-accepted, before the cost guards", async () => {
    const [got] = await verdictsOf(render(build({ name: "llm-zero-free", pairs: quad(0, 20, 0, 10), jevCost: 0, llmCost: 0 })));
    expect(got).toMatchObject({ verdict: "not enough evidence", rule: 1, condition: "zero-accepted" });
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
    expect(others).toHaveLength(12);
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

  test("[unit] R6.a rule within margin fires before the zero-accepted guard", async () => {
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
    expect(checked).toBe(19);
  });
});

/** The verdict's reason, one branch per row: the verdict name leads and the deciding number follows (D08 "plain-language reason"). */
describe("verdict: the reason of each of the five branches names the verdict and the deciding number", () => {
  test("[unit] D08 use Jev: reason starts with use Jev and holds the lower bound, the cost ratio and its upper bound", async () => {
    const got = await d08("r3-use-jev");
    expect(got.reason.startsWith("use Jev: ")).toBe(true);
    expect(got.reason).toBe("use Jev: Jev is within 10 points of the LLM (lower bound -0.03) and costs 0.009 of it per accepted answer (upper bound 0.010)");
  });

  test("[unit] D08 don't use Jev, rule within margin: reason starts with the verdict and holds the rule's lower bound and the 30 cases", async () => {
    const got = await d08("r2-rule-within-margin");
    expect(got.reason.startsWith("don't use Jev: ")).toBe(true);
    expect(got.reason).toContain("lower bound of rule minus Jev -0.03");
    expect(got.reason).toContain("on 30 paired cases");
  });

  test("[unit] D08 don't use Jev, Jev clearly worse: reason starts with the verdict and holds the upper bound", async () => {
    const got = await d08("r2-jev-worse");
    expect(got.reason.startsWith("don't use Jev: ")).toBe(true);
    expect(got.reason).toContain("upper bound of Jev minus LLM -0.30");
  });

  test("[unit] D16 0 accepted: the reason names the arm, both counts and the labels to check", async () => {
    expect((await d08("r1-jev-zero")).reason).toBe(
      "not enough evidence: Jev accepted 0 of 30 paired cases and the LLM 1, so Jev has no cost per accepted answer; check the Jev labels",
    );
    expect((await d08("r1-llm-zero")).reason).toBe(
      "not enough evidence: the LLM accepted 0 of 30 paired cases and Jev 1, so the LLM has no cost per accepted answer; check the LLM labels",
    );
    expect((await d08("r1-both-zero")).reason).toBe(
      "not enough evidence: Jev and the LLM both accepted 0 of 30 paired cases, so neither has a cost per accepted answer; check both arms' labels",
    );
  });

  test("[unit] D08 don't use Jev, Jev clearly dearer: reason starts with the verdict and holds the ratio and its lower bound", async () => {
    const got = await d08("r2-jev-dearer");
    expect(got.reason.startsWith("don't use Jev: ")).toBe(true);
    expect(got.reason).toContain("cost ratio 1.800");
    expect(got.reason).toContain("lower bound 1.600");
  });
});

/** Rule 4 names the unmet conditions and gives no case count (#49): the rules doc does not promise one. */
describe("verdict: rule 4 gives no case count (#49)", () => {
  test("[unit] #49 every rule-4 file has addN null and its reason does not say add", async () => {
    for (const name of ["r4-accept-rate", "r4-cheaper-under-20"]) {
      const got = await d08(name);
      expect({ name, rule: got.rule, addN: got.addN }).toEqual({ name, rule: 4, addN: null });
      expect(got.reason).not.toMatch(/\badd\b/);
    }
  });

  test("[unit] #49 the rules doc does not promise a count for rule 4", () => {
    const doc = readFileSync(fileURLToPath(new URL("../../docs/decision/verdict-rules.md", import.meta.url)), "utf8");
    const rule4 = doc.split("\n").find((line) => line.startsWith("4. **Not enough evidence** otherwise"));
    expect(rule4).toBeDefined();
    expect(rule4).not.toContain("how many more cases would be needed");
    expect(rule4).toContain("It gives no count of more cases");
  });
});

const TEST_SET_ONLY = "These results are for this test set only, not production.";
const DASHES = new RegExp(`${String.fromCharCode(0x2014)}|${String.fromCharCode(0x2013)}|NaN`);

/** The first llm row's label and label_source blanked: one unlabelled row. */
function blankFirstLlmLabel(text: string): string {
  const { header, rows } = readDictRows(text);
  if (header === null) throw new Error("no header");
  const [answerer, label, source] = [header.indexOf("answerer"), header.indexOf("label"), header.indexOf("label_source")];
  let done = false;
  const lines = rows.map(({ fields }) => {
    const next = [...fields];
    if (!done && next[answerer] === "llm") {
      next[label] = "";
      next[source] = "";
      done = true;
    }
    return next;
  });
  if (!done) throw new Error("no llm row");
  return [header, ...lines].map((fields) => formatRow(fields, "\n")).join("");
}

describe("verdict: limitations (D08)", () => {
  test("[unit] D08 a full file with a rule arm lists only that the results are for this test set", async () => {
    expect((await d08("r3-use-jev")).limitations).toEqual([TEST_SET_ONLY]);
  });

  test("[unit] D08 every verdict, whatever its rule, lists the test-set limitation first", async () => {
    const names = readdirSync(D08).filter((name) => name.endsWith(".csv")).map((name) => name.slice(0, -4));
    expect(names).toHaveLength(13);
    for (const name of names) expect({ name, first: (await d08(name)).limitations[0] }).toEqual({ name, first: TEST_SET_ONLY });
  });

  test("[unit] D08 below the minimum names the paired count", async () => {
    const got = await d08("r1-29-paired");
    expect(got.limitations).toContain("Below the minimum: 29 paired labelled Jev and LLM cases, fewer than 30.");
  });

  test("[unit] D08 no rule rows says the rule comparison was skipped for that reason", async () => {
    const [got] = await verdictsOf(render(build({ name: "no-rule", pairs: quad(27, 3, 0, 0) })));
    expect(got?.limitations).toEqual([TEST_SET_ONLY, "Rule comparison skipped: no rule rows."]);
  });

  test("[unit] D08 d06 q1 is below the minimum and has too few rule cases", async () => {
    const [q1] = await verdictsOf(readFileSync(TINY, "utf8"));
    expect(q1?.limitations).toContain("Rule comparison skipped: fewer than 30 paired rule cases.");
    expect(q1?.limitations.some((line) => line.startsWith("Below the minimum: 5 paired"))).toBe(true);
  });

  test("[unit] D08 a missing cost is listed with its count", async () => {
    const [got] = await verdictsOf(readFileSync(`${D08}r1-cost-missing.csv`, "utf8"));
    expect(got?.limitations.filter((line) => line.startsWith("Missing costs: "))).toEqual(["Missing costs: jev 1 row with no cost, so spend is incomplete."]);
  });

  test("[unit] evidence missing labels and costs name each method with its own count", async () => {
    const { header, rows } = readDictRows(readFileSync(`${D08}r3-use-jev.csv`, "utf8"));
    if (header === null) throw new Error("no header");
    const [answerer, label, source, costCol] = [header.indexOf("answerer"), header.indexOf("label"), header.indexOf("label_source"), header.indexOf("cost_usd")];
    const seen: Record<string, number> = {};
    const lines = rows.map(({ fields }) => {
      const next = [...fields];
      const who = next[answerer] ?? "";
      seen[who] = (seen[who] ?? 0) + 1;
      if (who === "rule" && (seen[who] ?? 0) <= 4) {
        next[label] = "";
        next[source] = "";
      }
      if ((who === "jev" || who === "llm") && seen[who] === 1) next[costCol] = "";
      return next;
    });
    const text = [header, ...lines].map((fields) => formatRow(fields, "\n")).join("");
    const [got] = await verdictsOf(text);
    expect(got?.limitations).toContain("Missing labels: rule 4 rows with no label, left out of every pairing.");
    expect(got?.limitations).toContain("Missing costs: llm 1 row, jev 1 row with no cost, so spend is incomplete.");
  });

  test("[unit] evidence methods with different case counts in one question are flagged with each count", async () => {
    const { header, rows } = readDictRows(readFileSync(`${D08}r3-use-jev.csv`, "utf8"));
    if (header === null) throw new Error("no header");
    const answerer = header.indexOf("answerer");
    let dropped = 0;
    const kept = rows.filter(({ fields }) => !(fields[answerer] === "rule" && dropped++ < 6));
    const text = [header, ...kept.map(({ fields }) => fields)].map((fields) => formatRow(fields, "\n")).join("");
    const [got] = await verdictsOf(text);
    expect(got?.limitations).toContain("Uneven cases across methods: llm 30, rule 24, jev 30.");
  });

  test("[unit] evidence methods with equal case counts add no uneven line", async () => {
    const [got] = await verdictsOf(readFileSync(`${D08}r3-use-jev.csv`, "utf8"));
    expect(got?.limitations.some((line) => line.startsWith("Uneven"))).toBe(false);
  });

  test("[unit] evidence a method with rows in another question of the file is named with 0 where it has none", async () => {
    const { header, rows } = readDictRows(readFileSync(`${D08}r3-use-jev.csv`, "utf8"));
    if (header === null) throw new Error("no header");
    const [answerer, question] = [header.indexOf("answerer"), header.indexOf("question_id")];
    const second = rows.filter(({ fields }) => fields[answerer] !== "rule").map(({ fields }) => fields.map((cell, i) => (i === question ? "q-norule" : cell)));
    const text = [header, ...rows.map(({ fields }) => fields), ...second].map((fields) => formatRow(fields, "\n")).join("");
    const [full, noRule] = await fileVerdictsOf(text);
    expect(full?.limitations.some((line) => line.startsWith("Uneven"))).toBe(false);
    expect(noRule?.limitations).toContain("Uneven cases across methods: llm 30, rule 0, jev 30.");
  });

  test("[unit] evidence a file with no rule rows anywhere is not flagged as uneven", async () => {
    const [got] = await fileVerdictsOf(render(build({ name: "no-rule", pairs: quad(27, 3, 0, 0) })));
    expect(got?.limitations).toEqual([TEST_SET_ONLY, "Rule comparison skipped: no rule rows."]);
  });

  test("[unit] evidence the planted d14 file gives one missing label, one missing cost and one zero-row method", async () => {
    const [q1, q2] = await fileVerdictsOf(readFileSync(D14, "utf8"));
    expect(q1?.limitations).toContain("Missing labels: rule 1 row with no label, left out of every pairing.");
    expect(q1?.limitations).toContain("Missing costs: llm 1 row with no cost, so spend is incomplete.");
    expect(q1?.limitations.some((line) => line.startsWith("Uneven"))).toBe(false);
    expect(q2?.limitations).toContain("Uneven cases across methods: llm 2, rule 0, jev 2.");
  });

  test("[unit] evidence verdictLimitations gives the same lines as the verdict", async () => {
    const text = readFileSync(D14, "utf8");
    const result = validate(text);
    const arms = armsInFile(result.rows);
    const seed = await fileSeed(text);
    for (const key of cohorts(result.rows)) {
      const metrics = cohortMetrics(result.rows, key);
      expect(verdictLimitations(metrics, arms)).toEqual([...verdict(metrics, seed, arms).limitations]);
    }
  });

  test("[unit] D08 a missing label is listed with its count and pushes a 30-case file under the minimum", async () => {
    const text = blankFirstLlmLabel(readFileSync(`${D08}r3-use-jev.csv`, "utf8"));
    const [got] = await verdictsOf(text);
    expect(got?.limitations).toContain("Missing labels: llm 1 row with no label, left out of every pairing.");
    expect(got?.limitations).toContain("Below the minimum: 29 paired labelled Jev and LLM cases, fewer than 30.");
    expect(got?.verdict).toBe("not enough evidence");
  });

  test("[unit] D08 no limitation line contains NaN, an em dash or an en dash", async () => {
    for (const name of readdirSync(D08).filter((file) => file.endsWith(".csv"))) {
      for (const line of (await d08(name.slice(0, -4))).limitations) expect(line).not.toMatch(DASHES);
    }
  });
});
