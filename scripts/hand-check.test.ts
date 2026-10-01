import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareFigures, computeFigures, handCheck, importSpecifiers, loadRecords, parseCsv, parseExpected } from "./hand-check.ts";

const RECORDS = fileURLToPath(new URL("../examples/d06-tiny/records.csv", import.meta.url));
const EXPECTED = fileURLToPath(new URL("../examples/d06-tiny/expected.md", import.meta.url));
const SOURCE = fileURLToPath(new URL("./hand-check.ts", import.meta.url));

const recordsText = readFileSync(RECORDS, "utf8");
const expectedText = readFileSync(EXPECTED, "utf8");

describe("hand check of d06", () => {
  test("[unit] R5.h hand check reproduces d06 expected.md", () => {
    const result = handCheck(recordsText, expectedText);
    console.log(`R5.h hand check: figures checked=${result.checked} mismatches=${result.mismatches.length}`);
    expect(result.mismatches).toEqual([]);
    expect(result.checked).toBeGreaterThan(100);
  });

  test("[unit] R5.h hand check covers the figures spec.md R5.h names", () => {
    const expected = parseExpected(expectedText);
    const named: ReadonlyArray<readonly [string, string]> = [
      ["q1.jev-llm.jev.accepted", "4"],
      ["q1.jev-llm.llm.accepted", "5"],
      ["q1.jev-llm.cost_ratio", "0.0125"],
      ["q1.jev-llm.a", "4"],
      ["q1.jev-llm.b", "0"],
      ["q1.jev-llm.c", "1"],
      ["q1.jev-llm.d", "0"],
      ["q1.jev-llm.diff", "-0.2"],
      ["q1.jev-rule.diff", "-0.4"],
      ["q2.jev-llm.paired", "4"],
      ["q2.jev-llm.jev.accepted", "3"],
      ["q2.jev-llm.llm.accepted", "3"],
      ["q2.jev-llm.cost_ratio", "0.01"],
      ["q2.jev-llm.diff", "0"],
      ["q2.jev-rule.diff", "0"],
    ];
    for (const [key, value] of named) expect([key, expected.get(key)]).toEqual([key, value]);
  });

  test("[unit] R5.h a planted change to one figure in expected.md fails the check", () => {
    const planted = expectedText.replace("Jev minus LLM = **-0.2**", "Jev minus LLM = **-0.3**");
    expect(planted).not.toBe(expectedText);
    const result = handCheck(recordsText, planted);
    expect(result.mismatches).toEqual([{ key: "q1.jev-llm.diff", expected: "-0.3", computed: "-0.2" }]);
  });

  test("[unit] R5.h a planted change to a table figure in expected.md fails the check", () => {
    const planted = expectedText.replace("| Cost per accepted | 0.0001 / 4 = $0.000025 |", "| Cost per accepted | 0.0001 / 4 = $0.000026 |");
    expect(planted).not.toBe(expectedText);
    const result = handCheck(recordsText, planted);
    expect(result.mismatches).toEqual([{ key: "q1.jev-llm.jev.cost_per_accepted", expected: "0.000026", computed: "0.000025" }]);
  });

  test("[unit] R5.h a figure the calculation produces but expected.md omits fails the check", () => {
    const dropped = expectedText.replace(" Jev minus LLM = **-0.2**.", "");
    expect(dropped).not.toBe(expectedText);
    const result = handCheck(recordsText, dropped);
    expect(result.mismatches).toEqual([{ key: "q1.jev-llm.diff", expected: "(not stated)", computed: "-0.2" }]);
  });

  test("[unit] R5.h a changed record fails the check", () => {
    const changed = recordsText.replace(",0.62,reject,", ",0.62,accept,");
    expect(changed).not.toBe(recordsText);
    const result = handCheck(changed, expectedText);
    expect(result.mismatches.length).toBeGreaterThan(0);
    const keys = result.mismatches.map((m) => m.key);
    expect(keys).toContain("q1.jev-llm.jev.accepted");
    expect(keys).toContain("correct.cv4.q1");
  });

  test("[unit] R5.h an expected.md with no figures fails rather than passing at zero", () => {
    const result = compareFigures(new Map(), computeFigures(loadRecords(recordsText)));
    expect(result.checked).toBe(0);
    expect(result.mismatches.length).toBeGreaterThan(0);
  });

  // Independence rule, kept textual so a comment or odd syntax cannot hide an import: the source
  // never contains "src/" anywhere (comments included), never calls import() or require(), and
  // every static import names a node: built-in.
  test("[unit] R5.h hand check imports nothing from src/core", () => {
    const source = readFileSync(SOURCE, "utf8");
    expect(source.includes("src/")).toBe(false);
    expect(/\bimport\s*\(/.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
    const specifiers = importSpecifiers(source);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  test("[unit] R5.h import scan sees static imports, re-exports and side-effect imports", () => {
    const sample = [
      'import { a } from "../lib/calc.ts";',
      "import type { B } from '../lib/verdict.ts';",
      'export { c } from "./c.ts";',
      'import "./side-effect.ts";',
    ].join("\n");
    expect(importSpecifiers(sample)).toEqual(["../lib/calc.ts", "../lib/verdict.ts", "./c.ts", "./side-effect.ts"]);
  });
});

/** Apply one replacement to expected.md (it must hit) and return the mismatch keys. */
function plantedKeys(from: string, to: string): string[] {
  const planted = expectedText.replace(from, to);
  expect(planted).not.toBe(expectedText);
  return handCheck(recordsText, planted).mismatches.map((m) => m.key);
}

describe("hand check catches planted changes", () => {
  test("[unit] R5.h figures use a fixed precision, not the stated one: $0 for a non-zero cost fails", () => {
    expect(plantedKeys("| Cost per accepted | 0.0001 / 4 = $0.000025 |", "| Cost per accepted | 0.0001 / 4 = $0 |")).toContain("q1.jev-llm.jev.cost_per_accepted");
    expect(plantedKeys("0.008 / 3 = $0.00267", "0.008 / 3 = $0.003")).toContain("q2.jev-llm.llm.cost_per_accepted");
  });

  test("[unit] R5.h the operands before the = are checked", () => {
    expect(plantedKeys("| Accept rate | 4/5 = 0.8 |", "| Accept rate | 9/5 = 0.8 |")).toContain("q1.jev-llm.jev.accept_rate.num");
    expect(plantedKeys("| Accept rate | 4/5 = 0.8 |", "| Accept rate | 8/10 = 0.8 |")).toContain("q1.jev-llm.jev.accept_rate.den");
    expect(plantedKeys("| Spend | 5 x 0.00002 = $0.0001 |", "| Spend | 6 x 0.00002 = $0.0001 |")).toContain("q1.jev-llm.jev.spend.n");
    expect(plantedKeys("| Spend | 5 x 0.00002 = $0.0001 |", "| Spend | 5 x 0.00003 = $0.0001 |")).toContain("q1.jev-llm.jev.spend.unit");
    expect(plantedKeys("0.0001 / 4 = $0.000025", "0.0002 / 8 = $0.000025")).toContain("q1.jev-llm.jev.cost_per_accepted.num");
    expect(plantedKeys("0.0001 / 4 = $0.000025", "0.0002 / 8 = $0.000025")).toContain("q1.jev-llm.jev.cost_per_accepted.den");
    expect(plantedKeys("| 10 x 0.00002 = $0.0002 |", "| 11 x 0.00002 = $0.0002 |")).toContain("file.jev.spend.n");
    expect(plantedKeys("0.000025 / 0.002 = **1/80", "0.00005 / 0.004 = **1/80")).toContain("q1.jev-llm.cost_ratio.num");
    expect(plantedKeys("**1/80 = 0.0125**", "**1/81 = 0.0125**")).toContain("q1.jev-llm.cost_ratio.fraction");
  });

  test("[unit] R5.h the threshold, paired case ids and missing-cost rows are checked", () => {
    expect(plantedKeys("fewer than 30", "fewer than 300")).toContain("q1.verdict.threshold");
    expect(plantedKeys("(cv1, cv3, cv4, cv5;", "(cv1, cv2, cv4, cv5;")).toContain("q2.jev-llm.paired.cases");
    expect(plantedKeys("(cv1 to cv5)", "(cv1 to cv4)")).toContain("q1.jev-llm.paired.cases");
    expect(plantedKeys("cv2 drops out", "cv3 drops out")).toContain("q2.jev-llm.dropped.cases");
    expect(plantedKeys("incomplete (cv5 q2 missing)", "incomplete (cv4 q2 missing)")).toContain("file.rule.spend.missing");
    expect(plantedKeys("Rule spend is incomplete (cv5 missing)", "Rule spend is incomplete (cv4 missing)")).toContain("q2.jev-rule.rule.spend.missing");
    expect(plantedKeys("the rule row for cv5 q2 has no cost", "the rule row for cv4 q2 has no cost")).toContain("file.cost_missing");
    expect(plantedKeys("the LLM row for cv2 q2 has no label", "the LLM row for cv1 q2 has no label")).toContain("file.unlabelled");
    expect(plantedKeys("fixture of 30 or more", "fixture of 20 or more")).toContain("file.min_paired");
  });

  test("[unit] R5.h an annotation that does not parse is a mismatch", () => {
    expect(plantedKeys("a = 2 (cv2, cv3)", "a = 2 (cv2, cv999, bogus)")).toContain("q1.jev-rule.a.cases");
    expect(plantedKeys("| 4 (rejects cv4) |", "| 4 (approx) |")).toContain("q1.jev-llm.jev.accepted.note");
    expect(plantedKeys("| yes R (cost missing) |", "| yes R (cost unknown) |")).toContain("row.cv5.q2.rule.note");
  });

  test("[unit] R5.h case lists compare as sets, so order does not matter", () => {
    const reordered = expectedText.replace("a = 2 (cv2, cv3)", "a = 2 (cv3, cv2)");
    expect(reordered).not.toBe(expectedText);
    expect(handCheck(recordsText, reordered).mismatches).toEqual([]);
  });

  test("[unit] R5.h a stated figure with no computed value is always a mismatch", () => {
    const result = compareFigures(new Map([["x.y", "(not computed)"]]), new Map());
    expect(result.mismatches).toEqual([{ key: "x.y", expected: "(not computed)", computed: "(no computed value)" }]);
  });

  test("[unit] R5.h markdown alignment delimiters are not read as data", () => {
    const aligned = expectedText.replace("|---|---|---|---|---|", "|:---|---:|:---:|---|---|");
    expect(aligned).not.toBe(expectedText);
    expect(handCheck(recordsText, aligned).mismatches).toEqual([]);
  });
});

describe("hand check CSV", () => {
  test("[unit] R5.h malformed CSV quoting is an error, not repaired", () => {
    expect(() => parseCsv('a,n"o"\n')).toThrow();
    expect(() => parseCsv('a,"x"y\n')).toThrow();
    expect(() => parseCsv('a,"x\n')).toThrow();
    expect(parseCsv('a,"x ""q"", y"\r\nb,\n')).toEqual([["a", 'x "q", y'], ["b", ""]]);
  });
});
