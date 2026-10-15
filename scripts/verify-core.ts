/**
 * D26 core-workflow check: do the Backstage page and the export agree?
 *
 *   bun scripts/verify-core.ts      runs the safe sample (32 fictional cases, Jev + LLM + keyword rule, no provider
 *                                   call, no credential) and prints PASS or FAIL per check; exits 0 only when all pass.
 *
 * "Page data" is BackstageRun.report(), the object src/backstage/main.ts renders the comparison from. "Export" is
 * BackstageRun.evidence(), serialised to JSON text. Five checks, always in this order:
 *   export-check       checkExportText accepts the export (reproducible, no credential). Not proof it came from a real run.
 *   three-methods      the arms on the page and in the export are exactly Jev, the LLM and the rule.
 *   cost-per-accepted  for every (armId, runId) pair and arm, the page cost per accepted answer deep-equals the one
 *                      recomputed from the export's own comparison records.
 *   verdict            every page verdict deep-equals the verdict the export carries for the same pair, and at least one exists.
 *   hand-math          scripts/math-check.ts, written from the verdict rules alone, agrees with the app on the export's records.
 * It does NOT open a browser, so it cannot see a rendering fault between report() and the screen. It does not spend money.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkExportText } from "../src/backstage/export-check.ts";
import { cohortVerdict, type BackstageRun } from "../src/backstage/run.ts";
import { describeCostPerAccepted, type CostPerAccepted } from "../src/core/metrics.ts";
import { sampleRun } from "./d17-sample-export.ts";
import { EXIT_CODES, main as mathCheck } from "./math-check.ts";

export type CheckId = "export-check" | "three-methods" | "cost-per-accepted" | "verdict" | "hand-math";
export interface CheckResult {
  readonly id: CheckId;
  readonly ok: boolean;
  readonly detail: string;
}
export type PageReport = Awaited<ReturnType<BackstageRun["report"]>>;

const IDS: readonly CheckId[] = ["export-check", "three-methods", "cost-per-accepted", "verdict", "hand-math"];
const METHODS: readonly string[] = ["jev", "llm", "rule"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
const pairKey = (armId: string, runId: string): string => JSON.stringify([armId, runId]);
/**
 * Output never quotes a string read from the export (the contract in src/backstage/export-check.ts): pairs are named by
 * position, and an arm is named only when it is one of the fixed three.
 */
const armLabel = (arm: string): string => (METHODS.includes(arm) ? arm : "an unexpected arm");
const hasRepeat = (list: readonly string[]): boolean => new Set(list).size !== list.length;
const COUNTS_LINE = /^compared=\d+ states=\d+ mismatches=\d+ excluded=\d+$/;
type MathRunner = typeof mathCheck;

/** What one export comparison yields when pushed through the app's own verdict chain. */
interface ExportPair {
  /** Position in the export's comparisons list. */
  readonly index: number;
  readonly armId: string;
  readonly runId: string;
  /** Every arm the comparison yielded, repeats kept (the map below keeps only the last of a repeated arm). */
  readonly arms: readonly string[];
  readonly costs: ReadonlyMap<string, CostPerAccepted>;
}
interface ExportSide {
  /** Why the export side could not be read at all; null when it was. */
  readonly fatal: string | null;
  readonly pairs: readonly ExportPair[];
  /** Per-comparison defects found while reading (invalid records). */
  readonly defects: readonly string[];
}

function emptyCsv(csv: string): boolean {
  return csv.split(/\r?\n/).filter((l) => l.trim() !== "").length <= 1;
}

async function readExportSide(data: unknown): Promise<ExportSide> {
  if (!isRecord(data)) return { fatal: "the export is not a JSON object", pairs: [], defects: [] };
  const m = data.manifest;
  if (!isRecord(m)) return { fatal: "the export has no manifest", pairs: [], defects: [] };
  const mode = str(m.mode);
  const promptVersion = str(m.promptVersion);
  const questionId = str(m.questionId);
  const scene = m.scene;
  const question = isRecord(scene) ? str(scene.question) : null;
  const choices = isRecord(scene) && Array.isArray(scene.choices) ? scene.choices.map((c) => (isRecord(c) ? str(c.name) : null)) : null;
  if (mode === null || promptVersion === null || questionId === null || question === null || choices === null || choices.some((c) => c === null))
    return { fatal: "the manifest lacks mode, promptVersion, questionId, question or choices", pairs: [], defects: [] };
  if (!Array.isArray(data.comparisons)) return { fatal: "the export has no comparisons list", pairs: [], defects: [] };
  const pairs: ExportPair[] = [];
  const defects: string[] = [];
  for (const [i, c] of data.comparisons.entries()) {
    const armId = isRecord(c) ? str(c.armId) : null;
    const runId = isRecord(c) ? str(c.runId) : null;
    const csv = isRecord(c) ? str(c.csv) : null;
    if (armId === null || runId === null || csv === null) {
      defects.push(`comparisons[${i}] lacks armId, runId or csv`);
      continue;
    }
    try {
      const outcome = await cohortVerdict(
        csv,
        { mode, key: { runId, promptVersion, questionId }, question, answerSet: choices.join("|") },
        emptyCsv(csv),
      );
      if (!outcome.ok) {
        defects.push(`comparisons[${i}] records fail validation (${outcome.errors.length} error(s))`);
        continue;
      }
      pairs.push({
        index: i,
        armId,
        runId,
        arms: outcome.metrics.arms.map((a) => a.arm),
        costs: new Map(outcome.metrics.arms.map((a) => [a.arm, a.costPerAccepted])),
      });
    } catch (error) {
      defects.push(`comparisons[${i}] could not be recomputed (${error instanceof Error ? error.name : "unknown error"})`);
    }
  }
  return { fatal: null, pairs, defects };
}

/** Each of jev, llm and rule exactly once, nothing else. `where` is a positional name like `page pairs[0]`. */
function armProblems(where: string, arms: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set(arms);
  if (hasRepeat(arms)) out.push(`${where} repeats an arm`);
  for (const arm of METHODS) if (!seen.has(arm)) out.push(`${where} is missing ${arm}`);
  if ([...seen].some((arm) => !METHODS.includes(arm))) out.push(`${where} has an unexpected arm`);
  return out;
}

/** A pair key with its position in the list it was read from (`exportLabel` names that list). */
interface Keyed {
  readonly key: string;
  readonly index: number;
}
function matchProblems(pageKeys: readonly string[], exportEntries: readonly Keyed[], exportLabel: string): string[] {
  const out: string[] = [];
  const exportSet = new Set(exportEntries.map((e) => e.key));
  const pageSet = new Set(pageKeys);
  const pageSeen = new Set<string>();
  for (const [i, k] of pageKeys.entries()) {
    if (pageSeen.has(k)) out.push(`page pairs[${i}] repeats an earlier pair`);
    pageSeen.add(k);
    if (!exportSet.has(k)) out.push(`page pairs[${i}] is not in the export ${exportLabel}`);
  }
  const exportSeen = new Set<string>();
  for (const e of exportEntries) {
    if (exportSeen.has(e.key)) out.push(`export ${exportLabel}[${e.index}] repeats an earlier pair`);
    exportSeen.add(e.key);
    if (!pageSet.has(e.key)) out.push(`export ${exportLabel}[${e.index}] is not on the page`);
  }
  return out;
}

function result(id: CheckId, problems: readonly string[], good: string): CheckResult {
  return problems.length ? { id, ok: false, detail: problems.join("; ") } : { id, ok: true, detail: good };
}
function failed(id: CheckId, error: unknown): CheckResult {
  return { id, ok: false, detail: `check could not run (${error instanceof Error ? error.name : "unknown error"})` };
}

function checkThreeMethods(page: PageReport, side: ExportSide): CheckResult {
  // The rule joins every pair (src/backstage/records.ts), so every pair is checked, not the union across pairs.
  const problems: string[] = [];
  if (page.pairs.length === 0) problems.push("page has no pairs");
  for (const [i, pair] of page.pairs.entries()) problems.push(...armProblems(`page pairs[${i}]`, pair.metrics.arms.map((a) => a.arm)));
  if (side.fatal !== null) problems.push(`export side unreadable: ${side.fatal}`);
  else {
    if (side.pairs.length === 0) problems.push("export has no readable comparisons");
    for (const pair of side.pairs) problems.push(...armProblems(`export comparisons[${pair.index}]`, pair.arms));
    problems.push(...side.defects.map((d) => `export side: ${d}`));
  }
  return result("three-methods", problems, `${page.pairs.length} page pairs and ${side.pairs.length} export comparisons each have jev, llm and rule once`);
}

function checkCost(page: PageReport, side: ExportSide): CheckResult {
  if (side.fatal !== null) return { id: "cost-per-accepted", ok: false, detail: `export side unreadable: ${side.fatal}` };
  const problems = side.defects.map((d) => `export side: ${d}`);
  const pageKeys = page.pairs.map((p) => pairKey(p.armId, p.runId));
  const exportPairs = new Map(side.pairs.map((p) => [pairKey(p.armId, p.runId), p]));
  problems.push(...matchProblems(pageKeys, side.pairs.map((p) => ({ key: pairKey(p.armId, p.runId), index: p.index })), "comparisons"));
  let compared = 0;
  const done = new Set<string>();
  for (const [i, pagePair] of page.pairs.entries()) {
    const key = pageKeys[i] ?? "";
    if (done.has(key)) continue;
    done.add(key);
    const exportPair = exportPairs.get(key);
    if (!exportPair) continue;
    const pageArms = pagePair.metrics.arms.map((a) => a.arm);
    // A repeated arm would overwrite itself in the maps below, so compare nothing for a pair that has one.
    if (hasRepeat(pageArms)) problems.push(`page pairs[${i}] repeats an arm`);
    if (hasRepeat(exportPair.arms)) problems.push(`export comparisons[${exportPair.index}] repeats an arm`);
    if (hasRepeat(pageArms) || hasRepeat(exportPair.arms)) continue;
    const pageCosts = new Map<string, CostPerAccepted>(pagePair.metrics.arms.map((a) => [a.arm, a.costPerAccepted]));
    for (const arm of new Set([...pageCosts.keys(), ...exportPair.costs.keys()])) {
      const a = pageCosts.get(arm);
      const b = exportPair.costs.get(arm);
      if (a === undefined || b === undefined) {
        problems.push(`page pairs[${i}]: arm ${armLabel(arm)} is only on the ${a === undefined ? "export" : "page"} side`);
        continue;
      }
      compared += 1;
      if (!isDeepStrictEqual(a, b))
        problems.push(`page pairs[${i}]: arm ${armLabel(arm)}: page ${describeCostPerAccepted(a)} vs export ${describeCostPerAccepted(b)}`);
    }
  }
  if (compared === 0 && problems.length === 0) problems.push("no arm cost was compared");
  return result("cost-per-accepted", problems, `${compared} arm costs equal across ${done.size} pairs`);
}

/** True when a NaN sits anywhere in the value (objects and arrays, recursively). Infinity is allowed: it is a real cost-ratio bound. */
function holdsNaN(value: unknown): boolean {
  if (typeof value === "number") return Number.isNaN(value);
  if (Array.isArray(value)) return value.some((item) => holdsNaN(item));
  if (isRecord(value)) return Object.values(value).some((item) => holdsNaN(item));
  return false;
}

function checkVerdict(page: PageReport, data: unknown): CheckResult {
  if (!isRecord(data)) return { id: "verdict", ok: false, detail: "the export is not a JSON object" };
  const verdicts = data.verdicts;
  if (!Array.isArray(verdicts)) return { id: "verdict", ok: false, detail: "export verdicts is not an array (null means report() was not run first)" };
  const entries = new Map<string, unknown>();
  const keys: Keyed[] = [];
  const problems: string[] = [];
  for (const [i, v] of verdicts.entries()) {
    const armId = isRecord(v) ? str(v.armId) : null;
    const runId = isRecord(v) ? str(v.runId) : null;
    if (!isRecord(v) || armId === null || runId === null || !("verdict" in v)) {
      problems.push(`export verdicts[${i}] lacks armId, runId or verdict`);
      continue;
    }
    keys.push({ key: pairKey(armId, runId), index: i });
    entries.set(pairKey(armId, runId), v.verdict);
  }
  problems.push(
    ...matchProblems(
      page.pairs.map((p) => pairKey(p.armId, p.runId)),
      keys,
      "verdicts",
    ),
  );
  let present = 0;
  for (const [i, pair] of page.pairs.entries()) {
    const key = pairKey(pair.armId, pair.runId);
    if (!entries.has(key)) continue;
    const exported = entries.get(key);
    if (pair.verdict !== null || exported !== null) present += 1;
    // NaN also becomes null on the wire, so the round trip below would hide it: the page would show NaN against a null export.
    if (holdsNaN(pair.verdict)) problems.push(`page pairs[${i}]: the verdict holds NaN`);
    // The export went through JSON, which turns an Infinity in a verdict (a cost-ratio bound) into null: compare the page
    // verdict after the same round trip, as src/backstage/export-check.ts does.
    const wire: unknown = JSON.parse(JSON.stringify(pair.verdict));
    if (!isDeepStrictEqual(wire, exported)) problems.push(`page pairs[${i}] verdict differs from its export verdict`);
  }
  const nonNull = page.pairs.filter((p) => p.verdict !== null).length;
  if (nonNull === 0) problems.push("no pair has a verdict (a compare run must have at least one)");
  return result("verdict", problems, `${page.pairs.length} pair verdicts equal, ${present} present`);
}

function checkHandMath(data: unknown, mathRunner: MathRunner): CheckResult {
  const records = isRecord(data) ? data.records : undefined;
  if (typeof records !== "string") return { id: "hand-math", ok: false, detail: "export records is missing or not text" };
  const dir = mkdtempSync(join(tmpdir(), "verify-core-"));
  try {
    const file = join(dir, "records.csv");
    writeFileSync(file, records);
    const run = mathRunner([file]);
    // Only the exit-code name and a counts line of the fixed shape are printed: math-check's err text can quote the records.
    const summary = run.out.split("\n").map((l) => l.trim()).find((l) => COUNTS_LINE.test(l));
    if (run.code === EXIT_CODES.ok) return { id: "hand-math", ok: true, detail: summary ?? "exit ok" };
    const name = Object.entries(EXIT_CODES).find(([, code]) => code === run.code)?.[0] ?? `code ${run.code}`;
    return { id: "hand-math", ok: false, detail: `math-check ${name}${summary ? `: ${summary}` : ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every check, always all five in this order, never throws on bad input (a defect is a FAIL with a detail). */
export async function verifyCore(page: PageReport, exportText: string, mathRunner: MathRunner = mathCheck): Promise<CheckResult[]> {
  let data: unknown = null;
  let parseError: string | null = null;
  try {
    data = JSON.parse(exportText);
  } catch {
    parseError = "the export is not valid JSON";
  }
  let side: ExportSide = { fatal: parseError ?? "the export is not a JSON object", pairs: [], defects: [] };
  if (parseError === null) {
    try {
      side = await readExportSide(data);
    } catch (error) {
      side = { fatal: `could not be read (${error instanceof Error ? error.name : "unknown error"})`, pairs: [], defects: [] };
    }
  }
  const out: CheckResult[] = [];
  const run = async (id: CheckId, work: () => CheckResult | Promise<CheckResult>): Promise<void> => {
    try {
      out.push(await work());
    } catch (error) {
      out.push(failed(id, error));
    }
  };
  await run("export-check", async () => {
    const check = await checkExportText(exportText);
    return { id: "export-check", ok: check.ok, detail: `problems=${check.problems.length} cases=${check.cases} labels=${check.labels}` };
  });
  await run("three-methods", () => checkThreeMethods(page, side));
  await run("cost-per-accepted", () => checkCost(page, side));
  await run("verdict", () => checkVerdict(page, data));
  await run("hand-math", () => checkHandMath(data, mathRunner));
  return IDS.map((id) => out.find((r) => r.id === id) ?? failed(id, null));
}

/** All five ids exactly once, in order, each ok; five ok results sharing one id are not a pass. */
function allPassed(results: readonly CheckResult[]): boolean {
  return results.length === IDS.length && IDS.every((id, i) => results[i]?.id === id) && results.every((r) => r.ok);
}

/** One line per check: `PASS <id>: <detail>` or `FAIL <id>: <detail>`, then `verify-core: PASS (5/5)` or `verify-core: FAIL (k/5)`. */
export function render(results: readonly CheckResult[]): string {
  const lines = results.map((r) => `${r.ok ? "PASS" : "FAIL"} ${r.id}: ${r.detail}`);
  const passed = results.filter((r) => r.ok).length;
  const all = allPassed(results);
  lines.push(`verify-core: ${all ? "PASS" : "FAIL"} (${passed}/${IDS.length})`);
  return lines.join("\n") + "\n";
}

/** CLI: runs sampleRun(), page = await run.report(), exportText = JSON.stringify(run.evidence(), null, 2); prints render(); returns 0 when all pass else 1. */
export async function main(): Promise<number> {
  const run = await sampleRun();
  // evidence() exports verdicts only after report() has computed them from the same records.
  const page = await run.report();
  const exportText = JSON.stringify(run.evidence(), null, 2);
  const results = await verifyCore(page, exportText);
  console.log(render(results).trimEnd());
  return allPassed(results) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main();
