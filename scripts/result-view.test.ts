import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileSeed } from "../src/core/calc.ts";
import { cohortMetrics, cohorts } from "../src/core/metrics.ts";
import { verdict, type Verdict } from "../src/core/verdict.ts";
import { validate } from "../src/format/validate.ts";
import { isNumberCell, renderResultView } from "./result-view.ts";

const SOURCE = "examples/d06-tiny/records.csv";
const RECORDS = fileURLToPath(new URL(`../${SOURCE}`, import.meta.url));
const PAGE = fileURLToPath(new URL("../site/result-d06.html", import.meta.url));
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
const REPO = fileURLToPath(new URL("../", import.meta.url));

/** The tracked page's bytes and mtime, to prove a test run never touches it. */
function trackedPage(): { readonly text: string; readonly mtimeMs: number } {
  return { text: readFileSync(PAGE, "utf8"), mtimeMs: statSync(PAGE).mtimeMs };
}

/** A temp copy of what the CLI needs (its script, src/, format/, the d06 records), with an empty site/. */
function cliCopy(): string {
  const root = mkdtempSync(join(tmpdir(), "result-view-repo-"));
  for (const part of ["scripts/result-view.ts", "src", "format", SOURCE, "package.json", "tsconfig.json"]) {
    cpSync(join(REPO, part), join(root, part), { recursive: true });
  }
  mkdirSync(join(root, "site"));
  return root;
}

/** True when the HTML opens a script element, in any letter case. */
function hasScript(page: string): boolean {
  return /<script\b/i.test(page);
}

/**
 * Every reference to another resource, absolute or relative: a resource-bearing attribute with any value,
 * a CSS @import, a CSS url(), or an http(s) URL anywhere. The page must reference nothing at all.
 */
function resourceRefs(page: string): string[] {
  const patterns = [/\b(?:src|href|srcset|action|formaction|poster|data|background|xlink:href)\s*=/gi, /@import\b/gi, /\burl\s*\(/gi, /https?:\/\//gi];
  return patterns.flatMap((pattern) => [...page.matchAll(pattern)].map((match) => match[0]));
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
    // Whole-file cost per accepted: jev 0.0002 / 8 = $0.000025, llm 0.02 / 8 = $0.0025.
    expect(cell("file.jev.cpa")).toBe("$0.000025");
    expect(cell("file.llm.cpa")).toBe("$0.002500");
  });

  test("[unit] D09 the glossary says what not enough evidence means and why two LLM costs differ", () => {
    expect(html).toContain(
      "The rules could not establish either use Jev or don't use Jev from this test set; too few cases or missing data are the usual reasons.",
    );
    expect(html).not.toContain("too small or too incomplete");
    expect(html).toContain("All-answers spend includes rows with no label");
    expect(html).toContain("the verdict comparison uses only cases where both Jev and the LLM have a label");
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
    expect(hasScript(html)).toBe(false);
  });

  test("[unit] D09 the script check is case-insensitive", () => {
    expect(hasScript("<p>x</p>")).toBe(false);
    expect(hasScript("<script>x</script>")).toBe(true);
    expect(hasScript("<SCRIPT src=x></SCRIPT>")).toBe(true);
    expect(hasScript("<Script>x</Script>")).toBe(true);
  });

  test("[unit] D09 the page references no resource at all, absolute or relative", () => {
    expect(resourceRefs(html)).toEqual([]);
  });

  test("[unit] D09 the resource check rejects every reference form", () => {
    const bad = [
      '<link rel="stylesheet" href="./x.css">',
      '<img src="./p.png">',
      "<img src=p.png>",
      '<link href="//cdn.example/x.css">',
      '<a href="https://example.com/">x</a>',
      '<img srcset="a.png 2x">',
      "<style>@import 'x.css';</style>",
      "<style>body { background: url(p.png); }</style>",
    ];
    for (const fixture of bad) expect([fixture, resourceRefs(fixture).length > 0]).toEqual([fixture, true]);
    expect(resourceRefs('<td data-cell="q1.jev.cpa">$0.000025</td>')).toEqual([]);
  });
});

/** The one cohort's verdict for a records file, computed by src/core exactly as the view does. */
async function onlyVerdict(text: string): Promise<{ readonly scope: string; readonly result: Verdict }> {
  const parsed = validate(text);
  const [key, ...rest] = cohorts(parsed.rows);
  if (key === undefined || rest.length > 0) throw new Error("expected one cohort");
  return { scope: `${key.runId}/${key.promptVersion}/${key.questionId}`, result: verdict(cohortMetrics(parsed.rows, key), await fileSeed(text)) };
}

function four(x: number): string {
  return x.toFixed(4);
}

/** Every "Numbers the verdict computed" cell of a page, keyed by the part after `<scope>.numbers.`. */
function numberCells(page: string, scope: string): Map<string, string> {
  const prefix = `${scope}.numbers.`;
  return new Map(keys(page).filter((key) => key.startsWith(prefix)).map((key) => [key.slice(prefix.length), cellIn(page, key)]));
}

/** The cells the view must show for a verdict: exactly the fields result.numbers computed, to 4 places. */
function expectedCells(result: Verdict): Map<string, string> {
  const out = new Map<string, string>();
  const { jevVsLlm, costRatio } = result.numbers;
  if (jevVsLlm !== null) {
    out.set("paired", String(jevVsLlm.n));
    out.set("jev-rate", four(jevVsLlm.p1));
    out.set("llm-rate", four(jevVsLlm.p2));
    out.set("accept-diff", four(jevVsLlm.diff));
    out.set("accept-lower", four(jevVsLlm.lower));
    out.set("accept-upper", four(jevVsLlm.upper));
  }
  if (costRatio !== null) {
    out.set("cost-ratio", four(costRatio.ratio));
    out.set("cost-lower", four(costRatio.lower));
    out.set("cost-upper", four(costRatio.upper));
  }
  return out;
}

function d08(name: string): { readonly source: string; readonly text: string } {
  const source = `examples/d08-verdicts/${name}.csv`;
  return { source, text: readFileSync(fileURLToPath(new URL(`../${source}`, import.meta.url)), "utf8") };
}

describe("result view: numbers the verdict computed (R7.b)", () => {
  // Values from examples/d08-verdicts/expected.md "Intervals" (4 places) and its cost ratio percentiles.
  const cases: ReadonlyArray<readonly [string, Verdict["rule"], Readonly<Record<string, string>>]> = [
    [
      "r4-accept-rate",
      4,
      { paired: "30", "accept-diff": "0.0000", "accept-lower": "-0.1097", "accept-upper": "0.1097", "cost-ratio": "0.0100", "cost-lower": "0.0100", "cost-upper": "0.0100" },
    ],
    [
      "r4-cheaper-under-20",
      4,
      { paired: "30", "accept-lower": "-0.0310", "accept-upper": "0.2562", "cost-ratio": "0.9000", "cost-lower": "0.8000", "cost-upper": "1.0000" },
    ],
    ["r3-use-jev", 3, { paired: "30", "accept-lower": "-0.0310", "accept-upper": "0.2562", "cost-ratio": "0.0090", "cost-lower": "0.0077", "cost-upper": "0.0100" }],
    ["r2-jev-dearer", 2, { paired: "30", "accept-lower": "-0.0310", "accept-upper": "0.2562", "cost-ratio": "1.8000", "cost-lower": "1.6000", "cost-upper": "2.0000" }],
  ];
  for (const [name, rule, stated] of cases) {
    test(`[unit] R7.b ${name}: every number result.numbers holds is shown, matching expected.md`, async () => {
      const { source, text } = d08(name);
      const { scope, result } = await onlyVerdict(text);
      expect(result.rule).toBe(rule);
      const shown = numberCells(await renderResultView(text, source), scope);
      expect(Object.fromEntries(shown)).toEqual(Object.fromEntries(expectedCells(result)));
      for (const [key, value] of Object.entries(stated)) expect([key, shown.get(key)]).toEqual([key, value]);
    });
  }

  test("[unit] R7.b the table says computed, not read, and that the rule may not use every number", async () => {
    const { source, text } = d08("r4-accept-rate");
    const page = await renderResultView(text, source);
    expect(page).toContain(
      "<caption>Numbers the verdict computed. Rule 4 may not use all of these; the reason above names the condition that decided.</caption>",
    );
    expect(html).toContain(
      "<caption>Numbers the verdict computed. Rule 1 may not use all of these; the reason above names the condition that decided.</caption>",
    );
    expect(page).not.toContain("Numbers the verdict read");
  });

  test("[unit] R7.b a verdict with no cost ratio shows no cost rows (r1-cost-missing)", async () => {
    const { source, text } = d08("r1-cost-missing");
    const { scope, result } = await onlyVerdict(text);
    expect(result.numbers.costRatio).toBeNull();
    const shown = numberCells(await renderResultView(text, source), scope);
    expect(Object.fromEntries(shown)).toEqual(Object.fromEntries(expectedCells(result)));
    expect([...shown.keys()].some((key) => key.startsWith("cost-"))).toBe(false);
  });

  for (const name of ["r1-no-jev", "r1-no-llm"]) {
    test(`[unit] R7.b with no Jev-versus-LLM comparison the view says only that (${name})`, async () => {
      const { source, text } = d08(name);
      const { scope, result } = await onlyVerdict(text);
      expect(result.numbers.jevVsLlm).toBeNull();
      const page = await renderResultView(text, source);
      expect(numberCells(page, scope).size).toBe(0);
      expect(cellIn(page, `${scope}.numbers`)).toBe("No Jev-versus-LLM numbers were computed for this question.");
      expect(page).not.toContain("computed no numbers");
    });
  }

  test("[unit] R7.b d06-tiny shows what each question's verdict computed, and no cost ratio", async () => {
    for (const q of [Q1, Q2]) {
      const shown = numberCells(html, q);
      expect(shown.get("paired")).toBe(cell(`${q}.vs-llm.n`));
      expect([...shown.keys()].some((key) => key.startsWith("cost-"))).toBe(false);
    }
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

  test("[integration] D09 CLI takes no arguments: any argument is a usage error and writes nothing", () => {
    const root = cliCopy();
    const output = join(root, "site", "result-d06.html");
    const tracked = trackedPage();
    for (const args of [[join(root, SOURCE), join(root, "out.html")], [join(root, SOURCE)], ["--help"]]) {
      const run = Bun.spawnSync(["bun", join(root, "scripts", "result-view.ts"), ...args], { cwd: root });
      expect([args, run.exitCode]).toEqual([args, 2]);
    }
    expect(existsSync(output)).toBe(false);
    expect(existsSync(join(root, "out.html"))).toBe(false);
    expect(trackedPage()).toEqual(tracked);
  });

  test("[integration] D09 CLI in a copy of the repo, from its root and from the fixture directory, writes the committed page", () => {
    const root = cliCopy();
    const output = join(root, "site", "result-d06.html");
    const tracked = trackedPage();
    for (const cwd of [root, join(root, "examples", "d06-tiny")]) {
      writeFileSync(output, "sentinel");
      const run = Bun.spawnSync(["bun", join(root, "scripts", "result-view.ts")], { cwd });
      expect([cwd, run.exitCode]).toEqual([cwd, 0]);
      expect(readFileSync(output, "utf8")).toBe(tracked.text);
    }
    expect(trackedPage()).toEqual(tracked);
  });

  test("[unit] D09 heading says CV questions only for the d06 fixture", async () => {
    expect(html).toContain("on the same CV questions");
    const page = await renderResultView(recordsText, "runs/other.csv");
    expect(page).toContain("on the same questions");
    expect(page).not.toContain("CV questions");
  });

  test("[unit] R4.d human rows are counted and shown with their gap lines, and kept out of the verdict", async () => {
    // Lines 32-36: the five q1 Jev rows re-answered by a person; line 32 unlabelled, line 33 without a cost.
    const q1Jev = dataLines.filter((line) => line.includes(",q1,") && line.includes(",jev,jev-1.13.0,"));
    expect(q1Jev).toHaveLength(5);
    const human = q1Jev.map((line, i) => {
      let out = line.replace(",jev,jev-1.13.0,", ",human,person,");
      if (i === 0) out = out.replace(",accept,human,", ",,,");
      if (i === 1) out = out.replace(",0.00002,", ",,");
      return out;
    });
    const page = await renderResultView([header, ...dataLines, ...human, ""].join("\n"), "with-human.csv");
    expect(cellIn(page, `${Q1}.human.rows`)).toBe("5");
    expect(cellIn(page, `${Q1}.human.labelled`)).toBe("4");
    expect(cellIn(page, `${Q1}.human.accepted`)).toBe("3");
    expect(cellIn(page, `${Q1}.human.gaps`)).toBe("1 unlabelled (line 32), 1 cost missing (line 33)");
    expect(cellIn(page, `${Q1}.human.spend`).startsWith("incomplete")).toBe(true);
    expect(cellIn(page, "file.human.rows")).toBe("5");
    expect(keys(page).some((key) => key.startsWith(`${Q2}.human.`))).toBe(false);
    // The verdict and its paired figures are the same as without the human rows.
    for (const key of [`${Q1}.reason`, `${Q1}.rule`, `${Q1}.vs-llm.n`, `${Q1}.jev.accepted`]) expect([key, cellIn(page, key)]).toEqual([key, cell(key)]);
  });

  test("[unit] R4.d a file with no human rows shows no human table", () => {
    expect(keys(html).some((key) => key.includes(".human."))).toBe(false);
  });

  test("[unit] D09 narrow screens keep numbers whole: number cells never wrap, tables scroll in a wrapper, not the body", () => {
    expect(html).toContain("td.num { white-space: nowrap; overflow-wrap: normal; }");
    expect(html).toContain(".scroll { overflow-x: auto; max-width: 100%; }");
    // Only row headers may break anywhere; data cells never do.
    expect(html).toContain("th { overflow-wrap: anywhere; }");
    expect(html).not.toMatch(/\btd\b[^{}]*\{[^}]*overflow-wrap: anywhere/);
    // Every table, with or without attributes, sits directly in the scroll wrapper.
    const tables = [...html.matchAll(/<table\b/g)];
    expect(tables.length).toBeGreaterThan(0);
    for (const match of tables) {
      const at = match.index ?? 0;
      expect([at, html.slice(at - '<div class="scroll">'.length, at)]).toEqual([at, '<div class="scroll">']);
    }
    // Number and money cells carry the class; text cells do not.
    for (const key of ["file.jev.cpa", "file.llm.spend", `${Q1}.vs-llm.jev.cpa`, `${Q1}.numbers.accept-lower`, `${Q1}.jev.accepted`]) {
      expect([key, html.includes(`<td data-cell="${key}" class="num">`)]).toEqual([key, true]);
    }
    for (const key of [`${Q2}.rule.gaps`, `${Q2}.rule.spend`]) expect([key, html.includes(`<td data-cell="${key}">`)]).toEqual([key, true]);
  });

  test("[unit] D09 number cells: plain, money, signed and exponent forms are numbers; text is not", () => {
    for (const value of ["30", "-0.1097", "$0.000025", "1,278,617", "4.4999999999999984e+26", "$4.4999999999999984e+26", "1e-7", "-2.5E+3"]) {
      expect([value, isNumberCell(value)]).toEqual([value, true]);
    }
    for (const value of ["none", "incomplete (cost missing)", "undefined (0 accepted)", "1 cost missing (line 21)", "e+26", "4e", "4e+"]) {
      expect([value, isNumberCell(value)]).toEqual([value, false]);
    }
  });

  test("[unit] R7.b the glossary explains 95% interval and cost ratio", () => {
    expect(html).toContain("<dt>95% interval</dt>");
    expect(html).toContain("<dt>Cost ratio</dt>");
  });

  test("[unit] D09 the intro does not claim every method answered or every answer was labelled", () => {
    expect(html).not.toContain("was answered by three methods");
    expect(html).not.toContain("marked each answer");
    expect(html).toContain("up to three methods");
    expect(html).toContain("listed as gaps");
  });
});
