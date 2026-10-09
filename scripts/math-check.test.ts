import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importSpecifiers } from "./hand-check.ts";
import { cohortsOf, handCohort, loadRows, main, numericLeaves, runApp, type Report } from "./math-check.ts";

const FIXTURE = fileURLToPath(new URL("../examples/d15-sheet-check/records.csv", import.meta.url));
const EXPECTED = fileURLToPath(new URL("../examples/d15-sheet-check/expected.md", import.meta.url));
const COVERAGE = fileURLToPath(new URL("../examples/d15-sheet-check/coverage.md", import.meta.url));
const D06 = fileURLToPath(new URL("../examples/d06-tiny/records.csv", import.meta.url));
const SOURCE = fileURLToPath(new URL("./math-check.ts", import.meta.url));

const fixtureText = readFileSync(FIXTURE, "utf8");
const tmp = mkdtempSync(join(tmpdir(), "math-check-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let written = 0;
function tempFile(text: string, ext = "csv"): string {
  written += 1;
  const path = join(tmp, `f${written}.${ext}`);
  writeFileSync(path, text);
  return path;
}

function isReport(value: unknown): value is Report {
  return typeof value === "object" && value !== null && "compared" in value && "figures" in value && "mismatches" in value;
}

/** math-check with --json: the exit code and the parsed report. */
function check(args: readonly string[]): { code: number; report: Report; err: string } {
  const result = main([...args, "--json"]);
  const parsed: unknown = JSON.parse(result.out);
  if (!isReport(parsed)) throw new Error(`no report: ${result.err}`);
  return { code: result.code, report: parsed, err: result.err };
}

function mismatchKeys(report: Report): string[] {
  return report.figures.filter((f) => !f.ok).map((f) => f.key);
}

function handValue(report: Report, key: string): unknown {
  return report.figures.find((f) => f.key === key)?.hand;
}

/** The figures table of expected.md: `| key | value |` rows under "## Figures". */
function statedFigures(text: string): Map<string, string> {
  const section = text.split(/^## Figures$/m)[1] ?? "";
  const out = new Map<string, string>();
  for (const line of section.split("\n")) {
    const m = /^\| `([^`]+)` \| ([^|]+) \|/.exec(line.trim());
    if (m === null || m[1] === undefined || m[2] === undefined) continue;
    if (out.has(m[1])) throw new Error(`expected.md states ${m[1]} twice`);
    out.set(m[1], m[2].trim());
  }
  return out;
}

describe("D15 math check", () => {
  // Independence, kept textual like hand-check's test: every static import is a node: built-in, no dynamic import or
  // require, no product module named, and the only app contact is the verdict subcommand (spends 0).
  test("[unit] D15.a math-check.ts imports no product code", () => {
    const source = readFileSync(SOURCE, "utf8");
    const specifiers = importSpecifiers(source);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
    expect(/\bimport\s*\(/.test(source)).toBe(false);
    expect(/\brequire\s*\(/.test(source)).toBe(false);
    expect(source.includes("src/")).toBe(false);
    expect(source.includes("JEV_API_KEY")).toBe(false);
    expect(source.includes('[cli, "verdict", file]')).toBe(true);
    for (const spend of ['"ask"', '"run"', '"estimate"']) expect(source.includes(spend)).toBe(false);
  });

  test("[unit] D15.b fixture matches expected.md, phi != 0", () => {
    const stated = statedFigures(readFileSync(EXPECTED, "utf8"));
    expect(stated.size).toBeGreaterThan(50);
    const num = (key: string): number => {
      const value = Number(stated.get(key));
      expect([key, Number.isFinite(value)]).toEqual([key, true]);
      return value;
    };
    // Fixture reach, read from the stated values.
    const [a, b, c, d] = ["a", "b", "c", "d"].map((cell) => num(`q1:numbers.jevVsLlm.${cell}`));
    if (a === undefined || b === undefined || c === undefined || d === undefined) throw new Error("q1 cells not stated");
    expect(Math.min(a, b, c, d)).toBeGreaterThanOrEqual(1);
    expect(a * d).toBeGreaterThan(b * c);
    expect(num("q1:numbers.jevVsLlm.phi")).not.toBe(0);
    for (const q of ["q1", "q2", "q3"]) expect(num(`${q}:numbers.jevVsLlm.n`)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...["q1", "q2", "q3"].map((q) => num(`${q}:rule`)))).toBeGreaterThan(1);

    // The independent calculation of the fixture against every stated value. The cost-ratio interval is the app's,
    // stated in expected.md as read from the app: it only decides rules 2 to 4.
    const bootstrap = (cohort: { readonly prefix: string }): { lower: number; upper: number } | null => {
      const lower = stated.get(`${cohort.prefix}:app.costRatio.lower`);
      const upper = stated.get(`${cohort.prefix}:app.costRatio.upper`);
      return lower === undefined || upper === undefined ? null : { lower: Number(lower), upper: Number(upper) };
    };
    const computed = new Map<string, number | string>();
    for (const cohort of cohortsOf(loadRows(fixtureText))) {
      const hand = handCohort(cohort, bootstrap);
      for (const f of hand.figures) {
        // The bound checks and the case-id set are comparisons with the app, not hand figures.
        if (f.tolerance === "bound-lower" || f.tolerance === "bound-upper" || f.tolerance === "set" || f.value === null) continue;
        computed.set(f.key, typeof f.value === "number" || typeof f.value === "string" ? f.value : f.value.join(","));
      }
      for (const e of hand.excluded) if (e.hand !== null) computed.set(e.key, e.hand);
    }
    const problems: string[] = [];
    for (const [key, value] of stated) {
      if (key.includes(":app.")) continue;
      const got = computed.get(key);
      if (got === undefined) problems.push(`${key}: stated ${value}, not computed`);
      else if (typeof got === "string") {
        // expected.md writes an empty list of unmet conditions as "(none)".
        if (got !== (value === "(none)" ? "" : value)) problems.push(`${key}: stated ${value}, computed ${got}`);
      } else {
        // Stated to 12 significant figures: equal within 1e-9 relative (1e-15 absolute at zero).
        const stated = Number(value);
        const close = Math.abs(stated - got) <= Math.max(1e-9 * Math.abs(got), 1e-15);
        if (!close) problems.push(`${key}: stated ${value}, computed ${got}`);
      }
    }
    // Every computed figure is stated, apart from the per-case cost echoes (expected.md gives the unit cost instead).
    for (const key of computed.keys()) if (!key.includes(".cases[") && !stated.has(key)) problems.push(`${key}: computed, not stated`);
    expect(problems).toEqual([]);
  });

  test("[unit] D15.c coverage.md lists every verdict leaf", () => {
    const coverage = readFileSync(COVERAGE, "utf8");
    const leaves = new Set([...numericLeaves(runApp(FIXTURE)), ...numericLeaves(runApp(D06))]);
    expect(leaves.size).toBeGreaterThan(30);
    const rows = new Map<string, string>();
    for (const line of coverage.split("\n")) {
      const m = /^\| `([^`]+)` \| (formula|partial|excluded) \|/.exec(line.trim());
      if (m !== null && m[1] !== undefined && m[2] !== undefined) rows.set(m[1], m[2]);
    }
    expect([...leaves].filter((leaf) => !rows.has(leaf))).toEqual([]);
    expect(rows.get("verdicts[].numbers.costRatio.lower")).toBe("partial");
    expect(rows.get("verdicts[].numbers.costRatio.redrawn")).toBe("excluded");
    expect(rows.get("verdicts[].numbers.jevVsLlm.lower")).toBe("formula");
    expect(coverage).toContain("1e-9 absolute");
    expect(coverage).toContain("1e-9 relative");
  });

  test("[unit] D15.d exit 3 when zero figures compared", () => {
    // A valid file of person-answered rows only: the verdict stops at "no Jev results" and prints no figure to check.
    const header = fixtureText.split("\n")[0] ?? "";
    const human = (id: string): string => `jnj-record/1,run-h,h.v1,${id},Fictional note ${id},q1,Is this a refund?,yes|no,human,operator,yes,,accept,human,,,0,1,,,`;
    const file = tempFile([header, human("h1"), human("h2")].join("\n") + "\n");
    const { code, report } = check([file]);
    expect(report.compared).toBe(0);
    expect(report.mismatches).toBe(0);
    expect(report.states_compared).toBeGreaterThan(0);
    expect(code).toBe(3);
  });

  test("[unit] D15.e fewer than N cases exits 2", () => {
    const short = main([FIXTURE, "--last", "43"]);
    expect(short.code).toBe(2);
    expect(short.err).toContain("fewer than 43 cases: the file has 42 distinct case_id values");
    expect(short.out).toBe("");
    for (const bad of ["0", "-1", "x", "1.5"]) expect([bad, main([FIXTURE, "--last", bad]).code]).toEqual([bad, 2]);
    expect(main([join(tmp, "absent.csv")]).code).toBe(2);
    // N cases that exist: the slice is checked, the source, N and the rule are printed.
    const sliced = check([FIXTURE, "--last", "10"]);
    expect(sliced.code).toBe(0);
    expect(sliced.report.n).toBe(10);
    expect(sliced.report.selection_rule).toContain("last 10 distinct case_id values in order of first appearance (of 42)");
    expect(sliced.err).toContain(`source=${FIXTURE} n=10`);
    // c33 to c42: q1 pairs c33 to c40 (c41 unlabelled, c42 agent), so 8 paired and 22 to add.
    expect(handValue(sliced.report, "q1:addN")).toBe(22);
    const table = main([FIXTURE, "--last", "10"]).out;
    expect(table).toContain(`source: ${FIXTURE}`);
    expect(table).toContain("n: 10");
  });

  test("[unit] D15.f unlabelled and agent rows excluded", () => {
    const base = check([FIXTURE]);
    expect(base.code).toBe(0);
    expect(handValue(base.report, "q1:numbers.jevVsLlm.n")).toBe(40);
    expect(handValue(base.report, "q1:numbers.jevVsLlm.excluded")).toBe(2);
    expect(base.report.figures.some((f) => f.key.includes("[c41]") || f.key.includes("[c42]"))).toBe(false);
    // The agent label reviewed by a person counts: 41 paired, and the app agrees.
    const lines = fixtureText.split("\n");
    const agentLine = lines.findIndex((l) => l.includes(",c42,") && l.includes(",q1,") && l.includes(",accept,agent,"));
    const unlabelledLine = lines.findIndex((l) => l.includes(",c41,") && l.includes(",q1,") && l.includes(",llm,") && l.includes(",,,,180,"));
    expect(agentLine).toBeGreaterThan(0);
    expect(unlabelledLine).toBeGreaterThan(0);
    const reviewed = lines.map((l, i) => (i === agentLine ? l.replace(",accept,agent,", ",accept,human,") : l)).join("\n");
    const one = check([tempFile(reviewed)]);
    expect(one.code).toBe(0);
    expect(handValue(one.report, "q1:numbers.jevVsLlm.n")).toBe(41);
    // Label the unlabelled row too: 42 paired.
    const both = reviewed.split("\n").map((l, i) => (i === unlabelledLine ? l.replace(",,,,180,", ",,accept,human,180,") : l)).join("\n");
    const two = check([tempFile(both)]);
    expect(two.code).toBe(0);
    expect(handValue(two.report, "q1:numbers.jevVsLlm.n")).toBe(42);
    expect(handValue(two.report, "q1:numbers.jevVsLlm.excluded")).toBe(0);
  });
});

describe("D15 planted faults on the app side", () => {
  const appText = JSON.stringify(runApp(FIXTURE), null, 2);
  /** Doctor the app's verdict JSON once (the replacement must hit) and check the fixture against it. */
  function planted(from: string, to: string): { code: number; keys: string[]; out: string } {
    const doctored = appText.replace(from, to);
    expect(doctored).not.toBe(appText);
    const file = tempFile(doctored, "json");
    const { code, report } = check([FIXTURE, "--app-json", file]);
    return { code, keys: mismatchKeys(report), out: main([FIXTURE, "--app-json", file]).out };
  }

  test("[unit] D15.g planted count fails and names the figure", () => {
    const r = planted('"a": 28,', '"a": 29,');
    expect(r.code).toBe(1);
    expect(r.keys).toEqual(["q1:numbers.jevVsLlm.a"]);
    expect(r.out).toContain("MISMATCH  q1:numbers.jevVsLlm.a | 28 | 29 | abs 1e-9");
  });

  test("[unit] D15.g planted spend fails and names the figure", () => {
    const r = planted('"usd": 0.0008000000000000008', '"usd": 0.0008000008');
    expect(r.code).toBe(1);
    expect(r.keys).toEqual(["q1:numbers.jevVsLlm.jev.spend.usd"]);
    expect(r.out).toContain("rel 1e-9");
  });

  test("[unit] D15.g planted interval bound fails and names the figure", () => {
    const r = planted('"lower": -0.08170948418222623', '"lower": -0.0817095');
    expect(r.code).toBe(1);
    expect(r.keys).toEqual(["q1:numbers.jevVsLlm.lower"]);
  });

  test("[unit] D15.g a blank or text app value is a mismatch", () => {
    expect(planted('"d": 6,', '"d": null,').keys).toEqual(["q1:numbers.jevVsLlm.d"]);
    expect(planted('"n": 40,', '"n": "40",').keys).toEqual(["q1:numbers.jevVsLlm.n"]);
    expect(planted('"ratio": 0.009375000000000001', '"ratio": "NaN"').keys).toContain("q1:numbers.costRatio.ratio");
  });

  test("[unit] D15.g the hand ratio outside the app's interval fails", () => {
    const r = planted('"upper": 0.010741452991452991', '"upper": 0.009');
    expect(r.code).toBe(1);
    expect(r.keys).toEqual(["q1:numbers.costRatio.upper"]);
  });
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The app's verdict JSON for the fixture, parsed, with a change applied in place; written to a temp file. */
function doctoredJson(change: (verdicts: unknown[]) => void): string {
  const json: unknown = JSON.parse(JSON.stringify(runApp(FIXTURE)));
  if (!isObject(json) || !Array.isArray(json.verdicts)) throw new Error("no verdicts");
  change(json.verdicts);
  return tempFile(JSON.stringify(json, null, 2), "json");
}

function q1Cases(verdicts: unknown[]): unknown[] {
  const q1 = verdicts[0];
  if (!isObject(q1) || !isObject(q1.numbers) || !isObject(q1.numbers.jevVsLlm) || !Array.isArray(q1.numbers.jevVsLlm.cases)) throw new Error("no q1 cases");
  return q1.numbers.jevVsLlm.cases;
}

/** A small records file: `cases` cases, one Jev and one LLM row each, labels and costs from the callbacks. */
function synthetic(cases: number, jev: (i: number) => [string, string], llm: (i: number) => [string, string]): string {
  const header = fixtureText.split("\n")[0] ?? "";
  const line = (i: number, who: string, model: string, [label, cost]: [string, string]): string =>
    `jnj-record/1,run-t,t.v1,t${i},Fictional note ${i},q1,Is it a refund?,yes|no,${who},${model},yes,,${label},${label === "" ? "" : "human"},1,1,${cost},1,,,`;
  const rows = [header];
  for (let i = 1; i <= cases; i += 1) rows.push(line(i, "jev", "jev-1.13.0", jev(i)), line(i, "llm", "example-llm", llm(i)));
  return rows.join("\n") + "\n";
}

describe("D15 review sweep regressions (2a83d38)", () => {
  test("[unit] D15.g malformed or duplicate app verdict entries are refused", () => {
    expect(main([FIXTURE, "--app-json", doctoredJson((v) => v.push(null))]).code).toBe(2);
    expect(main([FIXTURE, "--app-json", doctoredJson((v) => v.push(v[0]))]).err).toContain("twice");
  });

  test("[unit] D15.g app verdicts match on run, prompt version and question", () => {
    const file = doctoredJson((v) => v.forEach((one) => { if (isObject(one)) one.run_id = "WRONG"; }));
    const { code, report } = check([FIXTURE, "--app-json", file]);
    expect(code).toBe(1);
    expect(mismatchKeys(report)).toContain("q1:verdict");
  });

  test("[unit] D15.g extra or duplicate paired cases in the app fail", () => {
    const dup = check([FIXTURE, "--app-json", doctoredJson((v) => { const c = q1Cases(v); c.push(c[0]); })]);
    expect(dup.code).toBe(1);
    // The repeated case fails the membership check, and its per-case costs no longer resolve to one row.
    expect(mismatchKeys(dup.report)).toEqual(["q1:numbers.jevVsLlm.cases[*].caseId", "q1:numbers.jevVsLlm.cases[c01].jevCostUsd", "q1:numbers.jevVsLlm.cases[c01].otherCostUsd"]);
    const extra = check([FIXTURE, "--app-json", doctoredJson((v) => q1Cases(v).push({ caseId: "c99", jevAccepted: true, otherAccepted: true, jevCostUsd: 0.00002, otherCostUsd: 0.002 }))]);
    expect(mismatchKeys(extra.report)).toEqual(["q1:numbers.jevVsLlm.cases[*].caseId"]);
  });

  test("[unit] D15.g accepted counts are checked when nothing pairs", () => {
    const file = tempFile(synthetic(30, () => ["accept", "0.00002"], () => ["", "0.002"]));
    const real = check([file]);
    expect(mismatchKeys(real.report)).toEqual([]);
    expect(handValue(real.report, "q1:numbers.jevAccepted")).toBe(0);
    const app = JSON.stringify(runApp(file), null, 2).replace('"jevAccepted": 0', '"jevAccepted": 5');
    const planted = check([file, "--app-json", tempFile(app, "json")]);
    expect(planted.code).toBe(1);
    expect(mismatchKeys(planted.report)).toEqual(["q1:numbers.jevAccepted"]);
  });

  test("[unit] D15.g states are type-checked: a text rule or a null in unmet fails", () => {
    const text = check([FIXTURE, "--app-json", doctoredJson((v) => { const q1 = v[0]; if (isObject(q1)) q1.rule = "3"; })]);
    expect(mismatchKeys(text.report)).toEqual(["q1:rule"]);
    const unmet = check([FIXTURE, "--app-json", doctoredJson((v) => { const q1 = v[0]; if (isObject(q1)) q1.unmet = [null]; })]);
    expect(mismatchKeys(unmet.report)).toEqual(["q1:unmet"]);
  });

  test("[unit] D15.g invalid records are bad input even with --app-json", () => {
    const app = tempFile(JSON.stringify(runApp(FIXTURE)), "json");
    const garbage = fixtureText.replaceAll(",reject,human,", ",garbage,human,");
    expect(garbage).not.toBe(fixtureText);
    const r = main([tempFile(garbage), "--app-json", app]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("label");
    expect(main([tempFile(fixtureText.replace(",0.002,1800,", ",-0.002,1800,")), "--app-json", app]).code).toBe(2);
  });

  test("[unit] D15.g an infinite cost ratio is expected as null, never compared relatively", () => {
    // LLM rows cost $0: the ratio is infinite and the app prints null for it and its bounds.
    const file = tempFile(synthetic(30, () => ["accept", "0.00002"], () => ["accept", "0"]));
    const real = check([file]);
    expect(mismatchKeys(real.report)).toEqual([]);
    expect(real.code).toBe(0);
    const app = JSON.stringify(runApp(file), null, 2).replace('"ratio": null', '"ratio": 2');
    const planted = check([file, "--app-json", tempFile(app, "json")]);
    expect(planted.code).toBe(1);
    expect(mismatchKeys(planted.report)).toContain("q1:numbers.costRatio.ratio");
  });

  test("[unit] D15.g a negative cost-ratio bound fails", () => {
    const r = check([FIXTURE, "--app-json", doctoredJson((v) => {
      const q1 = v[0];
      if (isObject(q1) && isObject(q1.numbers) && isObject(q1.numbers.costRatio)) q1.numbers.costRatio.lower = -1;
    })]);
    expect(r.code).toBe(1);
    expect(mismatchKeys(r.report)).toEqual(["q1:numbers.costRatio.lower"]);
  });

  test("[unit] D15.g a 6,000-case file is read in full", () => {
    const file = tempFile(synthetic(6000, (i) => [i % 5 === 0 ? "reject" : "accept", "0.00002"], (i) => [i % 7 === 0 ? "reject" : "accept", "0.002"]));
    const { code, report } = check([file]);
    expect(mismatchKeys(report)).toEqual([]);
    expect(report.compared).toBeGreaterThan(12000);
    expect(code).toBe(0);
  }, 60000);

  test("[unit] D15.g a relative path is checked from the caller's directory", () => {
    writeFileSync(join(tmp, "relative.csv"), fixtureText);
    const before = process.cwd();
    process.chdir(tmp);
    try {
      const r = main(["relative.csv"]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
    } finally {
      process.chdir(before);
    }
  });
});

describe("D15 fixtures pass", () => {
  test("[unit] D15.b math-check on the D15 fixture: >= 20 figures, 0 mismatches, exit 0", () => {
    const { code, report } = check([FIXTURE]);
    expect(mismatchKeys(report)).toEqual([]);
    expect(report.compared).toBeGreaterThanOrEqual(20);
    expect(code).toBe(0);
  });

  test("[unit] D15.b math-check on d06-tiny exits 0", () => {
    const { code, report } = check([D06]);
    expect(mismatchKeys(report)).toEqual([]);
    expect(report.compared).toBeGreaterThan(0);
    expect(code).toBe(0);
  });
});
