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
import { REASON_PATTERNS, CONDITION_VERDICTS, buildReport, casesCsv, checkRecords, fitKeywords, readOpeningNight, redact, ruleKeywords, scanForSecrets, uc13Scene, type Arm, type ReportInput } from "./happy-path-lib.ts";

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
function report(overrides: Partial<ReportInput> = {}): ReportInput {
  return { base: "origin/main", version: "uat", cloneSha: "abc123", csv, caseIds, verdictText: pairedText, steps: [{ room: "Opening Night", step: "reveal", pass: true, detail: "shown", shot: "opening.png" }], secretHits: [], ...overrides };
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
    expect(new Set(problems.map((p) => p.caseId)).size).toBe(40);
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

test("[unit] #134 driver never clicks agent labels", async () => {
  const source = await Bun.file(new URL("./backstage-happy-path.ts", import.meta.url)).text();
  for (const forbidden of ["pick-first", "pick-second", "#accept", "#reject", "label-"]) expect(source).not.toContain(forbidden);
  expect(source).not.toMatch(/(?:getByRole|locator)\([\s\S]{0,160}?(?:hand_off|answer)[\s\S]{0,160}?\)\.click\(/i);
  expect(source).not.toMatch(/getByRole\(\s*["']button["'][\s\S]{0,160}?(?:accept|reject|hand_off|answer)[\s\S]{0,160}?\.click\(/i);
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
