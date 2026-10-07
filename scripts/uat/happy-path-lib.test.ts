import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cohortMetrics } from "../../src/core/metrics.ts";
import { verdict } from "../../src/core/verdict.ts";
import { readDictRows } from "../../src/format/csv.ts";
import { validate } from "../../src/format/validate.ts";
import { CRITERIA, formatRecords, loadExample, record, type RecordRow } from "../uc13/arms.ts";
import { fileSeed } from "../../src/core/calc.ts";
import { REASON_PATTERNS, CONDITION_VERDICTS, buildReport, casesCsv, checkEvidence, checkRecords, envValue, expectedVerdict, fitKeywords, pinError, pollUntil, readOpeningNight, redact, reportDirName, resolveChromium, ruleKeywords, runCompleteState, runStartState, scanForSecrets, seedOf, uc13Scene, type Arm, type ReportInput } from "./happy-path-lib.ts";

const EXAMPLE = fileURLToPath(new URL("../../examples/uc13-shop-bot/", import.meta.url));
const example = await loadExample(EXAMPLE);
const caseIds = example.cases.map((c) => c.case_id);
const arms: readonly Arm[] = ["jev", "llm", "rule"];
const rows = example.cases.flatMap((c) => arms.map((arm) => record(c, arm, `${arm}.v1`, "answer")));
const csv = formatRecords(rows);
const key = { runId: "run-shopbot-2026-10-01", promptVersion: "shop-bot-handoff.v1", questionId: "q1" };

function realVerdict(source: readonly RecordRow[]) {
  const parsed = validate(formatRecords(source));
  expect(parsed.errors).toEqual([]);
  return verdict(cohortMetrics(parsed.rows, key), 134);
}
const pairedVerdict = realVerdict(rows);
const pairedText = `claude-haiku-4-5-20251001 — ${pairedVerdict.verdict}\nPer-pair, uncorrected comparison. ${pairedVerdict.reason}`;
function withRows(source: readonly RecordRow[]): string { return formatRecords(source); }
const caseInputs: ReadonlyMap<string, string> = new Map(example.cases.map((c) => [c.case_id, c.case_input]));
const armModels: Readonly<Record<Arm, string>> = { jev: "jev.v1", llm: "llm.v1", rule: "rule.v1" };
const evidence = JSON.stringify({ version: "backstage/2", manifest: { runId: rows[0]?.run_id ?? "" }, attempts: [], labels: rows.map((r) => ({ caseId: r.case_id, armId: r.answerer, output: r.output, label: null })) });
function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return { base: "origin/main", version: "uat", cloneSha: "abc123", csv, caseIds, caseInputs, armModels, evidence, verdictText: pairedText, steps: [{ room: "Opening Night", step: "reveal", pass: true, detail: "shown", shot: "opening.png" }], secretHits: [], ...overrides };
}
function hasError(result: ReturnType<typeof readOpeningNight>): boolean { return "error" in result; }

describe("#134 Opening Night", () => {
  test("[unit] #134 row 1 RED1 maps a real unlabelled too-few-paired reason", () => {
    expect(pairedVerdict.condition).toBe("too-few-paired");
    expect(pairedVerdict.reason).toMatch(REASON_PATTERNS[pairedVerdict.condition]);
    expect(pairedVerdict.verdict).toBe(CONDITION_VERDICTS[pairedVerdict.condition]);
    expect(readOpeningNight(pairedText)).toEqual({ arm: "claude-haiku-4-5-20251001", verdict: pairedVerdict.verdict, condition: "too-few-paired", reason: pairedVerdict.reason });
  });
  test("[unit] #134 row 2 maps the real no-llm-rows reason", () => {
    const v = realVerdict(rows.filter((r) => r.answerer === "jev"));
    expect(v.condition).toBe("no-llm-rows");
    expect(v.reason).toMatch(REASON_PATTERNS[v.condition]);
    expect(v.verdict).toBe(CONDITION_VERDICTS[v.condition]);
    expect(readOpeningNight(`claude-haiku-4-5-20251001 — ${v.verdict}\nPer-pair, uncorrected comparison. ${v.reason}`)).toEqual({ arm: "claude-haiku-4-5-20251001", verdict: v.verdict, condition: v.condition, reason: v.reason });
  });
  test("[unit] #134 row 3 refuses Jev-only rehearsal", () => expect(hasError(readOpeningNight("Jev-only rehearsal\nNo comparative recommendation. Export records and attempt evidence below."))).toBe(true));
  test("[unit] #134 row 4 refuses No successful answers", () => expect(hasError(readOpeningNight("No successful answers\nNo comparative recommendation."))).toBe(true));
  test("[unit] #134 row 5 refuses empty and whitespace", () => { expect(hasError(readOpeningNight(""))).toBe(true); expect(hasError(readOpeningNight("  \n "))).toBe(true); });
  test("[unit] #134 row 6 refuses hidden results", () => expect(hasError(readOpeningNight("Results stay hidden until you reveal them in Rehearsals."))).toBe(true));
  test("[unit] #134 row 7 refuses a fourth verdict", () => expect(hasError(readOpeningNight("x — maybe use Jev\nPer-pair, uncorrected comparison. maybe use Jev: why"))).toBe(true));
  test("[unit] #134 row 8 refuses an unknown reason", () => expect(hasError(readOpeningNight("x — not enough evidence\nPer-pair, uncorrected comparison. not enough evidence: invented reason"))).toBe(true));
  test("[unit] #134 row 9 refuses two pairs", () => expect(hasError(readOpeningNight(`${pairedText}\n${pairedText}`))).toBe(true));
  test("[unit] #134 row 10 reason pattern record covers every Condition", () => {
    expect(Object.keys(REASON_PATTERNS)).toHaveLength(16);
    expect(Object.keys(CONDITION_VERDICTS)).toEqual(Object.keys(REASON_PATTERNS));
    expect(pairedVerdict.reason).toMatch(REASON_PATTERNS[pairedVerdict.condition]);
    const v = realVerdict(rows.filter((r) => r.answerer === "jev"));
    expect(v.reason).toMatch(REASON_PATTERNS[v.condition]);
  });
  test("[unit] #134 rejects a condition that contradicts the heading verdict", () => {
    expect(hasError(readOpeningNight("x — use Jev\nPer-pair, uncorrected comparison. use Jev: no LLM results"))).toBe(true);
  });
  test("[unit] #134 rejects a reason prefix that differs from the heading", () => {
    expect(hasError(readOpeningNight("x — use Jev\nPer-pair, uncorrected comparison. not enough evidence: no LLM results"))).toBe(true);
  });
});

describe("#134 records", () => {
  test("[unit] #134 row 11 accepts the complete unlabelled 120 rows", () => { expect(rows).toHaveLength(120); expect(checkRecords(csv, caseIds, arms)).toEqual([]); });
  for (const arm of arms) test(`[unit] #134 row 12 reports a missing ${arm} row by case and arm`, () => {
    const problems = checkRecords(withRows(rows.filter((r) => !(r.case_id === "m07" && r.answerer === arm))), caseIds, arms);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.caseId).toBe("m07");
    expect(problems[0]?.problem).toContain(arm);
  });
  test("[unit] #134 row 13 reports a duplicate case arm", () => {
    const problems = checkRecords(withRows([...rows, rows[0] ?? record(example.cases[0] ?? { case_id: "m01", case_input: "x" }, "jev", "jev.v1", "answer")]), caseIds, arms);
    expect(problems.some((p) => p.caseId === "m01" && /duplicate|more than one|exactly one/i.test(p.problem))).toBe(true);
  });
  test("[unit] #134 row 14 reports a case outside the 40", () => {
    const extra = record({ case_id: "m41", case_input: "extra" }, "jev", "jev.v1", "answer");
    expect(checkRecords(withRows([...rows, extra]), caseIds, arms).some((p) => p.caseId === "m41")).toBe(true);
  });
  test("[unit] #134 row 15 refuses a label", () => {
    const changed = rows.map((r) => r.case_id === "m01" && r.answerer === "jev" ? { ...r, label: "accept" } : r);
    expect(checkRecords(withRows(changed), caseIds, arms).some((p) => p.caseId === "m01" && /label/i.test(p.problem))).toBe(true);
  });
  test("[unit] #134 row 15 refuses label_final", () => {
    const base = csv.trimEnd().split("\n");
    const header = base[0] ?? "";
    const rest = base.slice(1);
    const labelled = [header + ",label_final", ...rest.map((line, i) => line + (i === 0 ? ",accept" : ","))].join("\n") + "\n";
    expect(checkRecords(labelled, caseIds, arms).some((p) => p.caseId === "m01" && /label_final|label/i.test(p.problem))).toBe(true);
  });
  test("[unit] #134 row 16 refuses output outside answer_set", () => {
    const changed = rows.map((r) => r.case_id === "m01" && r.answerer === "jev" ? { ...r, output: "maybe" } : r);
    expect(checkRecords(withRows(changed), caseIds, arms).some((p) => p.caseId === "m01" && /output|answer_set/i.test(p.problem))).toBe(true);
  });
  test("[unit] #134 row 17 header-only file reports every missing player", () => {
    const problems = checkRecords(withRows([]), caseIds, arms);
    expect(problems.length).toBeGreaterThanOrEqual(40);
    expect(new Set(problems.filter((p) => p.caseId !== "file").map((p) => p.caseId)).size).toBe(40);
    // #143 F13: the file-level validation error is reported even when there are no rows.
    expect(problems.some((p) => p.caseId === "file")).toBe(true);
  });
});

describe("#134 secret scan", () => {
  const secret = "planted-value-134-long";
  async function inDir(run: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "jnj-134-secret-"));
    try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
  }
  test("[unit] #134 row 18 reports a nested Markdown key without returning its value", async () => inDir(async (dir) => {
    await mkdir(join(dir, "nested")); await writeFile(join(dir, "nested", "note.md"), `before ${secret} after`);
    const hits = scanForSecrets(dir, new Map([["API_KEY", secret]]));
    expect(hits).toContainEqual({ file: "nested/note.md", name: "API_KEY" });
    expect(JSON.stringify(hits)).not.toContain(secret);
  }));
  test("[unit] #134 row 19 scans raw binary image bytes", async () => inDir(async (dir) => {
    await writeFile(join(dir, "shot.jpg"), Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(secret), Buffer.from([0xfe])]));
    expect(scanForSecrets(dir, new Map([["API_KEY", secret]]))).toContainEqual({ file: "shot.jpg", name: "API_KEY" });
  }));
  test("[unit] #134 row 20 scans file names", async () => inDir(async (dir) => {
    await writeFile(join(dir, `shot-${secret}.png`), "clean");
    expect(scanForSecrets(dir, new Map([["API_KEY", secret]]))).toContainEqual({ file: `shot-${secret}.png`, name: "API_KEY" });
  }));
  test("[unit] #134 row 21 clean directory has no hits", async () => inDir(async (dir) => {
    await writeFile(join(dir, "report.md"), "clean");
    expect(scanForSecrets(dir, new Map([["API_KEY", secret]]))).toEqual([]);
  }));
  test("[unit] #134 row 22 short and empty secrets are errors", async () => inDir(async (dir) => {
    for (const value of ["short", ""]) {
      const hits = scanForSecrets(dir, new Map([["BAD_KEY", value]]));
      expect(hits.some((hit) => hit.name === "BAD_KEY")).toBe(true);
      expect(JSON.stringify(hits)).not.toContain(value === "" ? "short" : value);
    }
  }));
  test("[unit] #134 scans a symlink name without following its target", async () => inDir(async (dir) => {
    await writeFile(join(dir, "target"), "clean");
    await symlink("target", join(dir, `link-${secret}`));
    const hits = scanForSecrets(dir, new Map([["API_KEY", secret]]));
    expect(hits).toContainEqual({ file: `link-${secret}`, name: "API_KEY" });
    expect(hits).toContainEqual({ file: `link-${secret}`, name: "unsupported entry" });
  }));
  test("[unit] #134 flags a symlink to a file as unsupported", async () => inDir(async (dir) => {
    await writeFile(join(dir, "target"), "clean");
    await symlink("target", join(dir, "link"));
    expect(scanForSecrets(dir, new Map([["API_KEY", secret]]))).toContainEqual({ file: "link", name: "unsupported entry" });
  }));
});

describe("#134 report", () => {
  test("[unit] #134 row 23 passes all evidence and prints the verdict and reason", () => {
    const result = buildReport(report());
    expect(result.ok).toBe(true); expect(result.exitCode).toBe(0);
    expect(result.markdown).toContain(pairedVerdict.verdict);
    expect(result.markdown).toContain(pairedVerdict.reason);
  });
  test("[unit] #134 row 24 RED2 exits 1 for a missing llm row and names the case", () => {
    const bad = withRows(rows.filter((r) => !(r.case_id === "m07" && r.answerer === "llm")));
    const result = buildReport(report({ csv: bad }));
    expect(result.ok).toBe(false); expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain("m07");
  });
  test("[unit] #134 row 25 refuses a rehearsal verdict", () => {
    const result = buildReport(report({ verdictText: "Jev-only rehearsal\nNo comparative recommendation." }));
    expect(result.ok).toBe(false); expect(result.exitCode).toBe(1);
    expect(result.markdown).toMatch(/verdict|rehearsal/i);
  });
  test("[unit] #134 row 26 refuses a secret hit while naming only its file and key name", () => {
    const result = buildReport(report({ secretHits: [{ file: "nested/shot.png", name: "API_KEY" }] }));
    expect(result.ok).toBe(false); expect(result.exitCode).toBe(1);
    expect(result.markdown).toContain("nested/shot.png"); expect(result.markdown).toContain("API_KEY");
    expect(result.markdown).not.toContain("planted-value-134-long");
  });
  test("[unit] #134 row 27 refuses a failed step", () => {
    const result = buildReport(report({ steps: [{ room: "Opening Night", step: "reveal", pass: false, detail: "failed", shot: "opening.png" }] }));
    expect(result.ok).toBe(false); expect(result.exitCode).toBe(1); expect(result.markdown).toContain("reveal");
  });
  test("[unit] #134 report header includes audit notes", () => {
    expect(buildReport(report({ notes: ["Scanned: evidence (all files)", "Screenshots: password fields"] })).markdown).toContain("Scanned: evidence (all files)");
  });
  test("[unit] #134 redacts planted values from report details verdicts and secret hit paths", () => {
    const secret = "planted-value-134-long";
    const secrets = new Map([["Jev key", secret]]);
    const result = buildReport(report({
      verdictText: `x — not enough evidence\nPer-pair, uncorrected comparison. not enough evidence: no LLM results ${secret}`,
      steps: [{ room: "Opening Night", step: "reveal", pass: false, detail: `error ${secret}`, shot: "" }],
      secretHits: [{ file: `name-${secret}.jpg`, name: "Jev key" }],
    }));
    const clean = redact(result.markdown, secrets);
    expect(clean).not.toContain(secret);
    expect(clean).toContain("[Jev key redacted]");
    expect(redact(`error ${secret}`, secrets)).toBe("error [Jev key redacted]");
  });
  test("[unit] #134 redacts overlapping keys without exposing a suffix", () => {
    const secrets = new Map([["Jev key", "planted-value"], ["LLM key", "planted-value-134-long"]]);
    expect(redact("planted-value-134-long", secrets)).toBe("[LLM key redacted]");
  });
});

// Allowlist, not denylist: a denylist of pick selectors was evaded by "#pick-actions button" in review.
// Every selector the driver resolves and every page-level method it calls must be listed here, so a new
// interaction cannot reach a judging control without this test being edited in the same diff.
const DRIVER_SELECTORS: readonly string[] = [
  '"#blind-card"', '"#compare"', '"#confirm-judging-yes"', '"#confirm-reveal-yes"', '"#import-cases"', '"#include-rule"',
  '"#keywords"', '"#llm-player"', '"#next"', '"#notice"', '"#progress"', '"#question"', '"#reveal"', '"#reveal-reason"',
  '"#rule-fields"', '"#run-all"', '"#run-preview"', '"#run-reason"', '"#verdict h3"', '"#verdict"', "'#jev-key[type=\"password\"]'",
  "'#rooms button[data-room=\"4\"]'", "'#rooms button[data-room=\"5\"]'","`#${llmProvider}-key[type=\"password\"]`",
  "`#model-options [id=\"arm-${options.llmModel}\"]`", '"#choice-a"', '"#choice-b"', '"#definition-a"', '"#definition-b"',
  '"#acceptance"', '"#download-csv"', '"#download-evidence"',
];
const DRIVER_ROLE_AND_TEXT: readonly string[] = ['getByRole("button", { name: /Open .*judging/ })', 'getByText("Imported 40 cases", { exact: false })'];
// #143 F3: no waitForFunction; page-side callbacks can mutate the page, so waits poll innerText from Node instead.
const PAGE_METHODS = new Set(["goto", "locator", "getByRole", "getByText", "waitForTimeout", "waitForEvent", "screenshot", "setDefaultTimeout"]);

const LITERAL = String.raw`("[^"\n]*"|'[^'\n]*'|\`[^\`\n]*\`)`;
/** Every interaction surface in a driver source, each required to be in its literal allowlisted form. */
function driverSurfaceProblems(source: string): readonly string[] {
  const problems: string[] = [];
  // Count every call however it is spaced; each must also match the exact literal form, so a variable or a
  // spaced selector is a problem rather than invisible.
  const locatorCalls = source.match(/\blocator\s*\(/g)?.length ?? 0;
  const literalLocators = [...source.matchAll(new RegExp(String.raw`\.locator\(` + LITERAL + String.raw`\)`, "g"))].map((m) => m[1] ?? "");
  if (literalLocators.length !== locatorCalls) problems.push(`${locatorCalls - literalLocators.length} locator call(s) not in literal form`);
  for (const selector of literalLocators) if (!DRIVER_SELECTORS.includes(selector)) problems.push(`selector ${selector}`);
  const getByCalls = source.match(/\bgetBy\w*\s*\(/g)?.length ?? 0;
  const getBys = DRIVER_ROLE_AND_TEXT.reduce((n, call) => n + source.split(call).length - 1, 0);
  if (getByCalls !== getBys) problems.push(`${getByCalls - getBys} getBy call(s) not allowlisted`);
  for (const m of source.matchAll(/\b(?:p|page)\s*\.\s*(\w+)\s*\(/g)) if (!PAGE_METHODS.has(m[1] ?? "")) problems.push(`page method ${m[1] ?? ""}`);
  if (/\.(?:mouse|keyboard|touchscreen)\b|dispatchEvent|evaluate|addScriptTag|exposeFunction|\.route\s*\(|\.first\s*\(|\.last\s*\(|\.nth\s*\(|\.filter\s*\(|\[\s*["'`]click/.test(source)) problems.push("input or script path that bypasses a locator");
  if (/waitForFunction|\$eval|\$\$eval/.test(source)) problems.push("page-side callback (waitForFunction / $eval)");  return problems;
}

test("[unit] #134 driver interacts only through allowlisted selectors (agents never label)", async () => {
  const source = await Bun.file(new URL("./backstage-happy-path.ts", import.meta.url)).text();
  expect(driverSurfaceProblems(source)).toEqual([]);
});

test("[unit] #134 the allowlist guard fails on every pick-click shape seen in review", async () => {
  const source = await Bun.file(new URL("./backstage-happy-path.ts", import.meta.url)).text();
  for (const mutation of [
    'await p.locator("#pick-actions button").click();',
    'await p.locator( "#pick-first").click();',
    'const pick = "#pick-first"; await p.locator(pick).click();',
    'await p.locator("#pick-actions").locator("button").click();',
    'await p.click("#pick-first");',
    'await p . click("#pick-first");',
    'await p.getByRole("button", { name: "hand_off" }).click();',
    'await p.getByRole( "button", { name: "answer" }).click();',
    'await p.locator("#pick-actions button").first().click();',
    // #143 F3: a template selector built from a variable, and a mutation inside a waitForFunction callback.
    'const id = "pick-first"; await p.locator(`#${id}`).click();',
    'await p.waitForFunction(() => { document.querySelector("#pick-first")?.click(); return true; });',
  ]) expect(driverSurfaceProblems(source + "\n" + mutation).length).toBeGreaterThan(0);
});

describe("#134 UC13 inputs", () => {
  test("[unit] #134 row 28 scene retains the fact sheet within server limits", () => {
    const scene = uc13Scene(example.factSheet);
    expect(scene.choiceA).toBe("hand_off"); expect(scene.choiceB).toBe("answer");
    for (const field of [scene.question, scene.definitionA, scene.definitionB]) expect(field.length).toBeLessThanOrEqual(1000);
    const joined = scene.question + scene.definitionA + scene.definitionB;
    for (const line of example.factSheet.split("\n").filter((line) => line.trim() !== "")) expect(joined).toContain(line);
    expect(scene.definitionA).toContain(CRITERIA.hand_off); expect(scene.definitionB).toContain(CRITERIA.answer);
    expect(scene.acceptance.trim()).not.toBe("");
  });
  test("[unit] #134 row 29 cases CSV round-trips 40 rows and RFC 4180 punctuation", () => {
    const out = casesCsv(example.cases);
    const parsed = readDictRows(out);
    expect(parsed.header).toEqual(["case_id", "case_input"]);
    expect(parsed.rows.map((r) => r.fields)).toEqual(example.cases.map((c) => [c.case_id, c.case_input]));
    const synthetic = readDictRows(casesCsv([{ case_id: "x", case_input: 'comma, "quote"\nand newline' }]));
    expect(synthetic.rows[0]?.fields).toEqual(["x", 'comma, "quote"\nand newline']);
  });
  test("[unit] #134 row 30 extracts all 29 rule terms", async () => {
    const rule = await Bun.file(join(EXAMPLE, "rule.md")).text();
    const terms = ruleKeywords(rule);
    expect(terms).toHaveLength(29); expect(terms).toContain("injur"); expect(terms).toContain("this weekend");
    expect(terms.every((term) => term.trim() !== "")).toBe(true);
  });
  test("[unit] #134 row 38 fits rule.md into the Backstage 20-keyword cap and names what it left out", async () => {
    const terms = ruleKeywords(await Bun.file(join(EXAMPLE, "rule.md")).text());
    const fit = fitKeywords(terms, 20);
    expect(fit.kept).toHaveLength(20);
    // Backstage matches by case-insensitive substring (src/backstage/run.ts:1220), so a term containing a kept term adds nothing.
    expect(fit.redundant).toEqual(["in stock", "booked", "booking", "confirmed", "broken"]);
    expect(fit.dropped).toEqual(["this weekend", "saturday", "sunday", "tomorrow"]);
    expect([...fit.kept, ...fit.redundant, ...fit.dropped].sort()).toEqual([...terms].sort());
    for (const term of fit.redundant) expect(fit.kept.some((k) => term.includes(k))).toBe(true);
  });
  test("[unit] #134 row 39 a list within the cap is kept whole and in order", () => {
    expect(fitKeywords(["refund", "money back"], 20)).toEqual({ kept: ["refund", "money back"], redundant: [], dropped: [] });
  });
});

// PR #143 review findings (Codex discovery sweep on 4bdd61e), one test per finding number.
const EM = String.fromCharCode(0x2014);
const HEAD = (verdictName: string): string => `x ${EM} ${verdictName}\nPer-pair, uncorrected comparison. `;
function evidenceFor(source: readonly RecordRow[], overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    version: "backstage/2", manifest: { runId: source[0]?.run_id ?? "run" }, attempts: [],
    labels: source.map((r) => ({ caseId: r.case_id, armId: r.answerer, output: r.output, label: null })), ...overrides,
  });
}
describe("#143 review findings", () => {
  test("[unit] #143 F1 a clone SHA mismatch is a pin error and a match or no pin is not", () => {
    expect(pinError("abc1234", "abc9999")).toContain("abc9999");
    expect(pinError("abc1234", "abc1234")).toBeNull();
    expect(pinError("abc1234", null)).toBeNull();
  });
  test("[unit] #143 F2 missing Chromium fails naming the install command and the override", () => {
    const none = resolveChromium(null, undefined, "/cache/chromium", () => false);
    expect("error" in none ? none.error : "").toContain("bunx playwright-core install chromium");
    expect("error" in none ? none.error : "").toContain("--chromium");
    expect(resolveChromium(null, undefined, "/cache/chromium", (p) => p === "/cache/chromium")).toEqual({ path: "/cache/chromium" });
    expect(resolveChromium("/opt/chrome", "/env/chrome", "/cache/chromium", () => true)).toEqual({ path: "/opt/chrome" });
    expect(resolveChromium(null, "/env/chrome", "/cache/chromium", () => true)).toEqual({ path: "/env/chrome" });
    const badExplicit = resolveChromium("/opt/missing", undefined, "/cache/chromium", (p) => p === "/cache/chromium");
    expect("error" in badExplicit ? badExplicit.error : "").toContain("/opt/missing");
  });
  test("[unit] #143 F4 report folder names carry time and a nonce so two runs never share one", () => {
    const now = new Date("2026-10-07T19:25:18.590Z");
    expect(reportDirName(now, "abc1234", "a1b2c3")).toBe("2026-10-07T19-25-18-590Z-happy-path-abc1234-a1b2c3");
    expect(reportDirName(now, "abc1234", "a1b2c3")).not.toBe(reportDirName(now, "abc1234", "d4e5f6"));
  });
  test("[unit] #143 F7 a displayed verdict the exported records do not support fails the report", async () => {
    const useJev = HEAD("use Jev") + "use Jev: Jev is within 10 points of the LLM (lower bound -0.050) and costs 0.500 of it per accepted answer (upper bound 0.700)";
    expect(hasError(readOpeningNight(useJev))).toBe(false);
    const result = buildReport(report({ verdictText: useJev }));
    expect(result.ok).toBe(false);
    expect(result.markdown).toContain("does not follow from records.csv");
    expect(seedOf(csv)).toBe(await fileSeed(csv));
    expect(expectedVerdict(csv)).toMatchObject({ verdict: pairedVerdict.verdict, condition: pairedVerdict.condition, reason: pairedVerdict.reason });
  });
  test("[unit] #143 F8 wrong case inputs or model ids in the export are record problems", () => {
    expect(checkRecords(csv, caseIds, arms, false, { inputs: caseInputs, models: armModels })).toEqual([]);
    const wrongInput = rows.map((r) => r.case_id === "m01" && r.answerer === "llm" ? { ...r, case_input: "something else" } : r);
    expect(checkRecords(withRows(wrongInput), caseIds, arms, false, { inputs: caseInputs, models: armModels }).some((p) => p.caseId === "m01" && /case_input/.test(p.problem))).toBe(true);
    const wrongModel = rows.map((r) => r.answerer === "llm" ? { ...r, answerer_model: "some-other-model" } : r);
    expect(checkRecords(withRows(wrongModel), caseIds, arms, false, { inputs: caseInputs, models: armModels }).filter((p) => /answerer_model/.test(p.problem))).toHaveLength(40);
    const twoRuns = rows.map((r, i) => i === 0 ? { ...r, run_id: "another-run" } : r);
    expect(checkRecords(withRows(twoRuns), caseIds, arms).some((p) => /more than one run/.test(p.problem))).toBe(true);
    expect(buildReport(report({ armModels: { jev: "jev-1.13.0", llm: "llm.v1", rule: "rule.v1" } })).ok).toBe(false);
  });
  test("[unit] #143 F9 an empty, malformed or unrelated evidence.json fails and a matching one passes", () => {
    expect(checkEvidence(evidenceFor(rows), csv, false)).toEqual([]);
    const flipped = rows.map((r) => ({ ...r, output: r.output === "answer" ? "hand_off" : "answer" }));
    for (const bad of ["", "not json", "{}", "[]", evidenceFor(rows.slice(1)), evidenceFor(rows, { manifest: { runId: "other-run" } }), evidenceFor(flipped)]) {
      expect(checkEvidence(bad, csv, false).length).toBeGreaterThan(0);
    }
    const labelled = rows.map((r) => ({ caseId: r.case_id, armId: r.answerer, output: r.output, label: "accept" }));
    expect(checkEvidence(evidenceFor(rows, { labels: labelled }), csv, false).some((p) => /label/.test(p))).toBe(true);
    expect(buildReport(report({ evidence: "{}" })).ok).toBe(false);
  });
  test("[unit] #143 F10 the run-start wait polls until started, stops on a block reason and times out", async () => {
    let clock = 0;
    const sleep = async (ms: number): Promise<void> => { clock += ms; };
    const progress = ["", "", "2 calls in progress"];
    let i = 0;
    expect(await pollUntil(async () => runStartState(progress[Math.min(i++, 2)] ?? "", ""), 60000, 500, sleep, () => clock)).toBe("started");
    expect(clock).toBe(1000);
    await expect(pollUntil(async () => runStartState("", "Add a key"), 60000, 500, sleep, () => clock)).rejects.toThrow("Run blocked: Add a key");
    // src/backstage/main.ts runReason() reads "Calls are in progress." while the run is starting or running: that is a start, not a block.
    expect(runStartState("", "Calls are in progress.")).toEqual({ done: "started" });
    clock = 0;
    await expect(pollUntil(async () => runStartState("", ""), 3000, 500, sleep, () => clock)).rejects.toThrow("timed out");
    expect(runCompleteState("80 of 80 selected case/model cells processed; 0 have no answer", "No calls in progress", 80)).toEqual({ done: "complete" });
    expect(runCompleteState("79 of 80 selected case/model cells processed; 0 have no answer", "No calls in progress", 80)).toBeNull();
    expect(runCompleteState("80 of 80 selected case/model cells processed; 0 have no answer", "1 call in progress", 80)).toBeNull();
  });
  test("[unit] #143 F12 dotenv values drop inline comments and the quotes around a quoted value", () => {
    const text = ["A=abc12345 # comment", 'B="quoted value" # comment', "C='single' #c", "export D=plain", "E=has#hash", 'F="keep # inside"', "G=  spaced  "].join("\n");
    expect(envValue(text, "A")).toBe("abc12345");
    expect(envValue(text, "B")).toBe("quoted value");
    expect(envValue(text, "C")).toBe("single");
    expect(envValue(text, "D")).toBe("plain");
    expect(envValue(text, "E")).toBe("has#hash");
    expect(envValue(text, "F")).toBe("keep # inside");
    expect(envValue(text, "G")).toBe("spaced");
    expect(envValue(text, "MISSING")).toBeNull();
  });
  test("[unit] #143 F13 a report with no steps, no cases and a header-only CSV does not pass", () => {
    expect(buildReport(report({ steps: [], caseIds: [], csv: "case_id,answerer\n" })).ok).toBe(false);
    expect(checkRecords("case_id,answerer\n", [], arms).some((p) => p.caseId === "file")).toBe(true);
    expect(buildReport(report({ steps: [] })).ok).toBe(false);
  });
  test("[unit] #143 F14 a reason naming contradictory conditions is refused; a real rule-4 list is read", () => {
    expect(hasError(readOpeningNight(HEAD("not enough evidence") + "not enough evidence: no LLM results; Jev is clearly worse"))).toBe(true);
    const rule4 = HEAD("not enough evidence") + "not enough evidence: Jev is not shown within 10 points of the LLM (lower bound of Jev minus LLM -0.150, not above -0.10); Jev is not cheaper (cost ratio 1.050)";
    expect(readOpeningNight(rule4)).toMatchObject({ condition: "accept-rate-not-shown" });
    expect(hasError(readOpeningNight(rule4 + "; Jev is clearly worse"))).toBe(true);
  });
  test("[unit] #143 F15 redundancy is judged against the terms kept, and an uncovered term is dropped", () => {
    expect(fitKeywords(["a", "b", "bb"], 1)).toEqual({ kept: ["a"], redundant: [], dropped: ["b", "bb"] });
    expect(fitKeywords(["a", "b", "bb"], 2)).toEqual({ kept: ["a", "b"], redundant: ["bb"], dropped: [] });
    expect(fitKeywords(["x", "x"], 5)).toEqual({ kept: ["x"], redundant: ["x"], dropped: [] });
  });
});
