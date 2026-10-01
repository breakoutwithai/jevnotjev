import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareFigures, computeFigures, handCheck, importSpecifiers, loadRecords, parseExpected } from "./hand-check.ts";

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

  test("[unit] R5.h hand check imports nothing from src/core", () => {
    const specifiers = importSpecifiers(readFileSync(SOURCE, "utf8"));
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => s.includes("src/core") || s.includes("core/"))).toEqual([]);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
  });

  test("[unit] R5.h import scan sees static, dynamic and require imports", () => {
    const sample = [
      'import { a } from "../src/core/calc.ts";',
      "import type { B } from '../src/core/verdict.ts';",
      'export { c } from "./c.ts";',
      'const d = await import("../src/core/d.ts");',
      'const e = require("node:path");',
      'import "./side-effect.ts";',
    ].join("\n");
    expect(importSpecifiers(sample)).toEqual([
      "../src/core/calc.ts",
      "../src/core/verdict.ts",
      "./c.ts",
      "../src/core/d.ts",
      "node:path",
      "./side-effect.ts",
    ]);
  });
});
