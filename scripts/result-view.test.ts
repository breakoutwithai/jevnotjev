import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderResultView } from "./result-view.ts";

const SOURCE = "examples/d06-tiny/records.csv";
const RECORDS = fileURLToPath(new URL(`../${SOURCE}`, import.meta.url));
const PAGE = fileURLToPath(new URL("../site/result-d06.html", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./result-view.ts", import.meta.url));
/** d06-tiny's one cohort per question: run-d06, prompt cv-match.v1. */
const Q1 = "run-d06/cv-match.v1/q1";
const Q2 = "run-d06/cv-match.v1/q2";

const recordsText = readFileSync(RECORDS, "utf8");
const html = await renderResultView(recordsText, SOURCE);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text of the element tagged data-cell="<key>", tags stripped; throws when the key is absent or repeated. */
function cellIn(page: string, key: string): string {
  const pattern = new RegExp(`data-cell="${escapeRegExp(key)}"[^>]*>(.*?)</`, "gs");
  const found = [...page.matchAll(pattern)];
  if (found.length !== 1) throw new Error(`data-cell ${key}: found ${found.length}`);
  const [only] = found;
  return (only?.[1] ?? "").replace(/<[^>]*>/g, "").trim();
}

function cell(key: string): string {
  return cellIn(html, key);
}

/** Every data-cell key in a page. */
function keys(page: string): string[] {
  return [...page.matchAll(/data-cell="([^"]*)"/g)].map((match) => match[1] ?? "");
}

const [header = "", ...dataLines] = recordsText.trimEnd().split("\n");

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
      [`${Q1}.vs-llm.n`, "5"],
      [`${Q1}.vs-llm.jev.accepted`, "4"],
      [`${Q1}.vs-llm.llm.accepted`, "5"],
      [`${Q1}.vs-llm.jev.spend`, "$0.000100"],
      [`${Q1}.vs-llm.llm.spend`, "$0.010000"],
      [`${Q1}.vs-llm.jev.cpa`, "$0.000025"],
      [`${Q1}.vs-llm.llm.cpa`, "$0.002000"],
      [`${Q2}.vs-llm.n`, "4"],
      [`${Q2}.vs-llm.jev.accepted`, "3"],
      [`${Q2}.vs-llm.llm.accepted`, "3"],
      [`${Q2}.vs-llm.jev.spend`, "$0.000080"],
      [`${Q2}.vs-llm.llm.spend`, "$0.008000"],
      [`${Q2}.vs-llm.jev.cpa`, "$0.000027"],
      [`${Q2}.vs-llm.llm.cpa`, "$0.002667"],
    ];
    for (const [key, value] of rows) expect([key, cell(key)]).toEqual([key, value]);
  });

  test("[unit] D09 per-question accepted counts for all three methods match expected.md", () => {
    // expected.md "Every row, by hand": q1 jev 4 rule 2 llm 5; q2 jev 4 rule 4 llm 3 (cv2 unlabelled).
    const rows: ReadonlyArray<readonly [string, string]> = [
      [`${Q1}.jev.accepted`, "4"],
      [`${Q1}.rule.accepted`, "2"],
      [`${Q1}.llm.accepted`, "5"],
      [`${Q2}.jev.accepted`, "4"],
      [`${Q2}.rule.accepted`, "4"],
      [`${Q2}.llm.accepted`, "3"],
      [`${Q2}.llm.labelled`, "4"],
    ];
    for (const [key, value] of rows) expect([key, cell(key)]).toEqual([key, value]);
  });

  test("[unit] D09 R7.b both verdicts, the rule that fired and their reasons are shown", () => {
    expect(cell(`${Q1}.verdict`)).toBe("not enough evidence");
    expect(cell(`${Q2}.verdict`)).toBe("not enough evidence");
    expect(cell(`${Q1}.rule`)).toBe("rule 1");
    expect(cell(`${Q2}.rule`)).toBe("rule 1");
    expect(cell(`${Q1}.reason`)).toContain("add 25 more labelled cases");
    expect(cell(`${Q2}.reason`)).toContain("add 26 more labelled cases");
    expect(cell(`${Q1}.rule-comparison`)).toContain("fewer than 30 paired rule cases");
  });

  test("[unit] D09 R8.b missing rule cost shows as incomplete, never $0", () => {
    expect(cell(`${Q2}.rule.spend`).startsWith("incomplete")).toBe(true);
    expect(cell(`${Q2}.rule.cpa`).startsWith("incomplete")).toBe(true);
    expect(cell("file.rule.cpa").startsWith("incomplete")).toBe(true);
  });

  test("[unit] D09 R8.a R8.b gaps name their CSV lines (cost missing line 21, unlabelled line 25)", () => {
    expect(cell(`${Q2}.rule.gaps`)).toBe("1 cost missing (line 21)");
    expect(cell(`${Q2}.llm.gaps`)).toBe("1 unlabelled (line 25)");
    expect(cell("file.rule.gaps")).toBe("1 cost missing (line 21)");
    expect(cell("file.llm.gaps")).toBe("1 unlabelled (line 25)");
    expect(cell(`${Q1}.jev.gaps`)).toBe("none");
  });

  test("[unit] D09 the d06 page states its limitations", () => {
    for (const phrase of ["fictional", "30", "invented", "planted", "not production"]) expect(html).toContain(phrase);
    expect(html).toContain(SOURCE);
  });

  test("[unit] D09 committed site/result-d06.html equals the rendered view", () => {
    expect(readFileSync(PAGE, "utf8")).toBe(html);
  });

  test("[unit] D09 no em or en dash and no script", () => {
    expect(html.includes("\u2014")).toBe(false);
    expect(html.includes("\u2013")).toBe(false);
    expect(html).not.toContain("<script");
  });

  test("[unit] D09 no external resource reference in any syntax", () => {
    expect(html).not.toMatch(/\b(?:src|href|srcset|action|poster|data)\s*=\s*["']?\s*(?:[a-z][a-z0-9+.-]*:)?\/\//i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\s*\(/i);
    expect(html).not.toMatch(/https?:\/\//i);
  });
});

describe("result view of other files", () => {
  test("[unit] D09 two runs in one file: whole file keeps run identity, cohorts get distinct headings and keys", async () => {
    const second = dataLines.map((line) => line.replace(",run-d06,", ",run-b,"));
    expect(second.every((line, i) => line !== dataLines[i])).toBe(true);
    const page = await renderResultView([header, ...dataLines, ...second, ""].join("\n"), "two-runs.csv");
    expect(cellIn(page, "file.jev.labelled")).toBe("20");
    expect(cellIn(page, "file.jev.accepted")).toBe("16");
    expect(cellIn(page, "run-b/cv-match.v1/q1.jev.accepted")).toBe("4");
    expect(cellIn(page, `${Q1}.jev.accepted`)).toBe("4");
    const all = keys(page);
    expect(new Set(all).size).toBe(all.length);
    expect(page).toContain("run run-b, prompt cv-match.v1");
    expect(page).toContain("run run-d06, prompt cv-match.v1");
  });

  test("[unit] D09 one cohort per question keeps the plain heading", () => {
    expect(html).not.toContain("run run-d06, prompt");
  });

  test("[unit] D09 zero accepted shows the cost per accepted as undefined in that cell", async () => {
    const rejected = dataLines.map((line) => (line.includes(",jev,jev-1.13.0,") ? line.replace(",accept,human,", ",reject,human,") : line));
    expect(rejected.filter((line) => line.includes(",jev,jev-1.13.0,") && line.includes(",reject,human,"))).toHaveLength(10);
    const page = await renderResultView([header, ...rejected, ""].join("\n"), "zero.csv");
    expect(cellIn(page, `${Q1}.jev.accepted`)).toBe("0");
    expect(cellIn(page, `${Q1}.jev.cpa`)).toBe("undefined (0 accepted)");
    expect(cellIn(page, "file.jev.cpa")).toBe("undefined (0 accepted)");
  });

  test("[unit] D09 a file other than d06-tiny gets generic limitations and its own source name", async () => {
    const page = await renderResultView(recordsText, "runs/other.csv");
    expect(page).toContain("runs/other.csv");
    expect(page).not.toContain(SOURCE);
    for (const phrase of ["fictional", "planted", "$0.00002 per Jev call"]) expect(page).not.toContain(phrase);
    expect(page).toContain("evidence from this test set only");
  });

  test("[integration] D09 CLI rejects malformed UTF-8 and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "result-view-"));
    const input = join(dir, "bad.csv");
    const output = join(dir, "out.html");
    // A valid file whose cv1 case_input (every row of it) holds a byte that is not UTF-8: a lossy decode
    // turns it into U+FFFD, the rows still agree, and the file would validate and render.
    const parts = recordsText.split("Aurelian");
    expect(parts.length).toBeGreaterThan(1);
    const bad = Buffer.from([0xff]);
    writeFileSync(input, Buffer.concat(parts.flatMap((part, i) => (i === 0 ? [Buffer.from(part)] : [Buffer.from("Aur"), bad, Buffer.from(`lian${part}`)]))));
    const run = Bun.spawnSync(["bun", SCRIPT, input, output]);
    expect(run.exitCode).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  });
});
