import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderResultView } from "./result-view.ts";

const RECORDS = fileURLToPath(new URL("../examples/d06-tiny/records.csv", import.meta.url));
const PAGE = fileURLToPath(new URL("../site/result-d06.html", import.meta.url));

const html = await renderResultView(readFileSync(RECORDS, "utf8"));

/** Text of the element tagged data-cell="<key>", tags stripped; throws when the key is absent or repeated. */
function cell(key: string): string {
  const pattern = new RegExp(`data-cell="${key.replaceAll(".", "\\.")}"[^>]*>(.*?)</`, "gs");
  const found = [...html.matchAll(pattern)];
  if (found.length !== 1) throw new Error(`data-cell ${key}: found ${found.length}`);
  const [only] = found;
  return (only?.[1] ?? "").replace(/<[^>]*>/g, "").trim();
}

describe("result view of d06-tiny", () => {
  test("[unit] D09 whole-file accepted counts and spend match expected.md", () => {
    // expected.md "Per answerer, whole file": jev 10/10/8 $0.0002, rule 10/10/6 incomplete, llm 10/9/8 $0.02.
    const rows: ReadonlyArray<readonly [string, string, string, string]> = [
      ["jev", "10", "8", "$0.000200"],
      ["rule", "10", "6", "incomplete"],
      ["llm", "9", "8", "$0.020000"],
    ];
    for (const [arm, labelled, accepted, spend] of rows) {
      expect([arm, cell(`file.${arm}.labelled`), cell(`file.${arm}.accepted`)]).toEqual([arm, labelled, accepted]);
      expect(cell(`file.${arm}.spend`).startsWith(spend)).toBe(true);
    }
  });

  test("[unit] D09 per-question Jev and LLM figures match expected.md", () => {
    // expected.md q1 and q2 "Jev against the LLM" tables, shown to 6 decimals:
    // q2 Jev 0.00008 / 3 = $0.0000267 -> $0.000027; q2 LLM 0.008 / 3 = $0.00267 -> $0.002667.
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["q1.vs-llm.n", "5"],
      ["q1.vs-llm.jev.accepted", "4"],
      ["q1.vs-llm.llm.accepted", "5"],
      ["q1.vs-llm.jev.spend", "$0.000100"],
      ["q1.vs-llm.llm.spend", "$0.010000"],
      ["q1.vs-llm.jev.cpa", "$0.000025"],
      ["q1.vs-llm.llm.cpa", "$0.002000"],
      ["q2.vs-llm.n", "4"],
      ["q2.vs-llm.jev.accepted", "3"],
      ["q2.vs-llm.llm.accepted", "3"],
      ["q2.vs-llm.jev.spend", "$0.000080"],
      ["q2.vs-llm.llm.spend", "$0.008000"],
      ["q2.vs-llm.jev.cpa", "$0.000027"],
      ["q2.vs-llm.llm.cpa", "$0.002667"],
    ];
    for (const [key, value] of rows) expect([key, cell(key)]).toEqual([key, value]);
  });

  test("[unit] D09 per-question accepted counts for all three methods match expected.md", () => {
    // expected.md "Every row, by hand": q1 jev 4 rule 2 llm 5; q2 jev 4 rule 4 llm 3 (cv2 unlabelled).
    const rows: ReadonlyArray<readonly [string, string]> = [
      ["q1.jev.accepted", "4"],
      ["q1.rule.accepted", "2"],
      ["q1.llm.accepted", "5"],
      ["q2.jev.accepted", "4"],
      ["q2.rule.accepted", "4"],
      ["q2.llm.accepted", "3"],
      ["q2.llm.labelled", "4"],
    ];
    for (const [key, value] of rows) expect([key, cell(key)]).toEqual([key, value]);
  });

  test("[unit] D09 both verdicts and their reasons are shown", () => {
    expect(cell("q1.verdict")).toBe("not enough evidence");
    expect(cell("q2.verdict")).toBe("not enough evidence");
    expect(cell("q1.reason")).toContain("add 25 more labelled cases");
    expect(cell("q2.reason")).toContain("add 26 more labelled cases");
    expect(cell("q1.rule-comparison")).toContain("fewer than 30 paired rule cases");
  });

  test("[unit] D09 missing rule cost shows as incomplete, never $0", () => {
    expect(cell("q2.rule.spend").startsWith("incomplete")).toBe(true);
    expect(cell("q2.rule.cpa").startsWith("incomplete")).toBe(true);
    expect(cell("file.rule.cpa").startsWith("incomplete")).toBe(true);
    expect(html).toContain("undefined");
  });

  test("[unit] D09 the page states its limitations", () => {
    for (const phrase of ["fictional", "30", "invented", "not production"]) expect(html).toContain(phrase);
  });

  test("[unit] D09 committed site/result-d06.html equals the rendered view", () => {
    expect(readFileSync(PAGE, "utf8")).toBe(html);
  });

  test("[unit] D09 no em or en dash and no script or network reference", () => {
    expect(html.includes("\u2014")).toBe(false);
    expect(html.includes("\u2013")).toBe(false);
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/(src|href)="https?:/);
  });
});
