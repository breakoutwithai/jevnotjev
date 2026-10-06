// D12 / F5: the case-by-method rows shared by the result view and the browser loader.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validate, type Row } from "../format/validate.ts";
import { caseCell, caseLines, matchingMethods } from "./case-table.ts";

const ROOT = join(import.meta.dir, "..", "..");

async function rowsOf(rel: string): Promise<Row[]> {
  const result = validate(await readFile(join(ROOT, rel), "utf8"));
  expect(result.errors).toEqual([]);
  return result.rows.map((r) => r.values);
}

describe("case table: shared rows (F5)", () => {
  test("[unit] F5-T1 cases come in file order with one row per method, and a method with no row is undefined", async () => {
    const lines = caseLines(await rowsOf("examples/d12-three-methods/records.csv"));
    expect(lines.map((l) => l.caseId)).toEqual(["d01", "d02", "d03", "d04"]);
    const d04 = lines[3];
    expect(d04?.rows.llm?.get("output")).toBe("yes");
    expect(d04?.rows.rule).toBeUndefined();
    expect(d04?.rows.jev?.get("output")).toBe("yes");
  });

  test("[unit] F5-T2 a cell says output and cost, and names a missing cost, a missing label and a missing row in words", async () => {
    const lines = caseLines(await rowsOf("examples/d12-three-methods/records.csv"));
    expect(caseCell(lines[0]?.rows.llm)).toBe("yes, $0.000330");
    expect(caseCell(lines[1]?.rows.llm)).toBe("no, cost missing");
    expect(caseCell(lines[3]?.rows.rule)).toBe("missing");
  });

  test("[unit] F5-T3 matching methods: every accepted method in llm, rule, jev order, none, or unlabelled", async () => {
    const lines = caseLines(await rowsOf("examples/d12-three-methods/records.csv"));
    expect(matchingMethods(lines[0] ?? { caseId: "", rows: { llm: undefined, rule: undefined, jev: undefined } })).toBe("llm, rule, jev");
    expect(matchingMethods(lines[2] ?? { caseId: "", rows: { llm: undefined, rule: undefined, jev: undefined } })).toBe("llm, jev");
    expect(matchingMethods({ caseId: "x", rows: { llm: undefined, rule: undefined, jev: undefined } })).toBe("unlabelled");
    const rejected = new Map([["label", "reject"]]);
    expect(matchingMethods({ caseId: "x", rows: { llm: rejected, rule: undefined, jev: rejected } })).toBe("none");
    const blank = new Map([["label", null]]);
    expect(matchingMethods({ caseId: "x", rows: { llm: blank, rule: undefined, jev: rejected } })).toBe("none among labelled methods; llm unlabelled");
    expect(matchingMethods({ caseId: "x", rows: { llm: blank, rule: rejected, jev: rejected } })).toBe("none among labelled methods; llm unlabelled");
    const accepted = new Map([["label", "accept"]]);
    expect(matchingMethods({ caseId: "x", rows: { llm: blank, rule: undefined, jev: accepted } })).toBe("jev; llm unlabelled");
    expect(matchingMethods({ caseId: "x", rows: { llm: blank, rule: undefined, jev: blank } })).toBe("unlabelled");
  });

  test("[unit] F5-T4 the result view and the browser loader both use this module and neither keeps its own copy of the cell wording", async () => {
    const view = await readFile(join(ROOT, "scripts", "result-view.ts"), "utf8");
    const loader = await readFile(join(ROOT, "src", "browser", "results-loader.ts"), "utf8");
    for (const src of [view, loader]) {
      expect(src).toContain("case-table.ts");
      expect(src).not.toContain("function caseCell");
      expect(src).not.toContain('"cost missing"');
    }
  });
});
