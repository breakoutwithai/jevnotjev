import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readDictRows, formatRows } from "../../src/format/csv.ts";
import { validate } from "../../src/format/validate.ts";
import { cohortMetrics } from "../../src/core/metrics.ts";
import { verdict as computeVerdict, type Condition, type Verdict, type VerdictName } from "../../src/core/verdict.ts";
import { CRITERIA, QUESTION } from "../uc13/arms.ts";

export type Arm = "jev" | "llm" | "rule";
export interface OpeningNight { readonly arm: string; readonly verdict: VerdictName; readonly condition: Condition; readonly reason: string }
export const REASON_PATTERNS: Readonly<Record<Condition, RegExp>> = {
  "no-jev-rows": /no Jev results/,
  "no-llm-rows": /no LLM results/,
  "too-few-paired": /paired Jev and LLM cases, fewer than/,
  "both-zero-accepted": /both have 0 accepted/,
  "cost-missing": /cost missing on a paired/,
  "no-cost-ratio": /both cost \$0 per accepted answer.*no cost ratio/,
  "cost-not-finite": /costs too large|cost ratio is too large/,
  "rule-within-margin": /rule is within 10 points/,
  "jev-clearly-worse": /Jev is clearly worse/,
  "jev-zero-accepted": /Jev has 0 accepted/,
  "jev-clearly-dearer": /Jev is clearly dearer/,
  "use-jev": /Jev is within 10 points/,
  "accept-rate-not-shown": /Jev is not shown within 10 points/,
  "cheaper-by-less-than-20": /cheaper, but by less than 20%/,
  "not-cheaper": /Jev is not cheaper/,
  "cost-upper-bound-not-below-1": /upper bound .* is not below 1/,
};
export const CONDITION_VERDICTS: Readonly<Record<Condition, VerdictName>> = {
  "no-jev-rows": "not enough evidence",
  "no-llm-rows": "not enough evidence",
  "too-few-paired": "not enough evidence",
  "both-zero-accepted": "not enough evidence",
  "cost-missing": "not enough evidence",
  "no-cost-ratio": "not enough evidence",
  "cost-not-finite": "not enough evidence",
  "rule-within-margin": "don't use Jev",
  "jev-clearly-worse": "don't use Jev",
  "jev-zero-accepted": "don't use Jev",
  "jev-clearly-dearer": "don't use Jev",
  "use-jev": "use Jev",
  "accept-rate-not-shown": "not enough evidence",
  "cheaper-by-less-than-20": "not enough evidence",
  "not-cheaper": "not enough evidence",
  "cost-upper-bound-not-below-1": "not enough evidence",
};
const conditions: readonly Condition[] = [
  "no-jev-rows", "no-llm-rows", "too-few-paired", "both-zero-accepted", "cost-missing", "no-cost-ratio", "cost-not-finite",
  "rule-within-margin", "jev-clearly-worse", "jev-zero-accepted", "jev-clearly-dearer", "use-jev",
  "accept-rate-not-shown", "cheaper-by-less-than-20", "not-cheaper", "cost-upper-bound-not-below-1",
];
const verdicts: readonly VerdictName[] = ["use Jev", "don't use Jev", "not enough evidence"];
const RULE4: readonly Condition[] = ["accept-rate-not-shown", "cheaper-by-less-than-20", "not-cheaper", "cost-upper-bound-not-below-1"];
/** Parse #verdict innerText; reject hidden, rehearsal, invalid, and ambiguous verdicts. */
export function readOpeningNight(text: string): OpeningNight | { readonly error: string } {
  const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heads = lines.filter((line) => line.includes(" — "));
  if (heads.length !== 1) return { error: "Opening Night must show exactly one comparison verdict" };
  const match = /^(.+?) — (use Jev|don't use Jev|not enough evidence)$/.exec(heads[0] ?? "");
  if (!match || !lines[1]?.startsWith("Per-pair, uncorrected comparison. ")) return { error: "Opening Night has no recognized verdict and reason" };
  const arm = match[1] ?? "";
  const name = match[2] ?? "";
  if (!verdicts.some((value) => value === name)) return { error: "Unknown verdict" };
  const reason = lines[1].slice("Per-pair, uncorrected comparison. ".length);
  if (!reason.startsWith(`${name}: `)) return { error: "Verdict reason does not match verdict" };
  const matched = conditions.filter((key) => REASON_PATTERNS[key].test(reason));
  const condition = matched[0];
  if (!condition) return { error: "Unknown verdict reason" };
  // Only rule 4 (src/core/verdict.ts) joins several conditions, with "; ", and then every part names exactly one of them.
  if (matched.length > 1) {
    const parts = reason.slice(name.length + 2).split("; ");
    const oneEach = parts.every((part) => conditions.filter((key) => REASON_PATTERNS[key].test(part)).length === 1);
    if (!matched.every((key) => RULE4.includes(key)) || !oneEach) return { error: "Verdict reason names conflicting conditions" };
  }
  if (CONDITION_VERDICTS[condition] !== name) return { error: "Verdict condition does not match verdict" };
  const verdict = verdicts.find((value) => value === name);
  if (!verdict) return { error: "Unknown verdict" };
  return { arm, verdict, condition, reason };
}
export interface RecordProblem { readonly caseId: string; readonly problem: string }
/** What the run actually sent: the case inputs by case id and the model id requested for each arm. */
export interface RecordExpectations { readonly inputs?: ReadonlyMap<string, string>; readonly models?: Readonly<Partial<Record<Arm, string>>> }
/** Check exactly one unlabelled, valid output from every arm for every expected case, from one run, for the inputs and models sent. */
export function checkRecords(csv: string, caseIds: readonly string[], arms: readonly Arm[], allowLabels = false, expect: RecordExpectations = {}): readonly RecordProblem[] {
  const problems: RecordProblem[] = [];
  const parsed = readDictRows(csv);
  const header = parsed.header ?? [];
  const at = (name: string): number => header.indexOf(name);
  if (!header.includes("case_id") || !header.includes("answerer")) return [{ caseId: "file", problem: "records.csv needs case_id and answerer columns" }];
  if (caseIds.length === 0) problems.push({ caseId: "file", problem: "no expected cases" });
  const counts = new Map<string, number>();
  const expected = new Set(caseIds);
  const cohorts = new Set<string>();
  for (const row of parsed.rows) {
    const get = (name: string): string => row.fields[at(name)] ?? "";
    const id = get("case_id");
    const arm = get("answerer");
    cohorts.add([get("run_id"), get("prompt_version"), get("question_id")].join("\0"));
    if (!expected.has(id)) problems.push({ caseId: id, problem: "case outside expected set" });
    const knownArm = arms.find((value) => value === arm);
    if (!knownArm) problems.push({ caseId: id, problem: `unexpected arm ${arm}` });
    const input = expect.inputs?.get(id);
    if (input !== undefined && get("case_input") !== input) problems.push({ caseId: id, problem: `${arm}: case_input differs from the case sent` });
    const model = knownArm ? expect.models?.[knownArm] : undefined;
    if (model !== undefined && get("answerer_model") !== model) problems.push({ caseId: id, problem: `${arm}: answerer_model is not the requested ${model}` });
    const key = `${id}\0${arm}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!allowLabels) for (const label of ["label", "label_final", "label_source", "labelled_by", "labelled_at", "label_blind"]) {
      if (get(label) !== "") problems.push({ caseId: id, problem: `${label} is present` });
    }
    if (!get("answer_set").split("|").includes(get("output"))) problems.push({ caseId: id, problem: "output outside answer_set" });
  }
  for (const id of caseIds) for (const arm of arms) {
    const count = counts.get(`${id}\0${arm}`) ?? 0;
    if (count !== 1) problems.push({ caseId: id, problem: `${arm}: expected exactly one row, got ${count}${count > 1 ? " (duplicate)" : ""}` });
  }
  if (cohorts.size > 1) problems.push({ caseId: "file", problem: `rows from more than one run (${cohorts.size} run/prompt/question keys)` });
  for (const error of validate(csv).errors) problems.push({ caseId: "file", problem: error });
  return problems;
}
/** SHA-256 seed of a CSV, the synchronous twin of src/core/calc.ts fileSeed (the seed Backstage passes to verdict). */
export function seedOf(text: string): number {
  return createHash("sha256").update(text, "utf8").digest().readUInt32BE(0);
}
/** The verdict Backstage computes from this export (src/backstage/run.ts report(): one comparator, so records.csv is the cohort CSV). */
export function expectedVerdict(csv: string): Verdict | { readonly error: string } {
  const parsed = validate(csv);
  if (parsed.errors.length || parsed.rows.length === 0) return { error: "records.csv cannot support a verdict" };
  const { header, rows } = readDictRows(csv);
  const at = (name: string): number => (header ?? []).indexOf(name);
  const keys = new Set(rows.map((row) => ["run_id", "prompt_version", "question_id"].map((name) => row.fields[at(name)] ?? "").join("\0")));
  const [only] = keys;
  if (keys.size !== 1 || only === undefined) return { error: "records.csv holds more than one run" };
  const [runId = "", promptVersion = "", questionId = ""] = only.split("\0");
  return computeVerdict(cohortMetrics(parsed.rows, { runId, promptVersion, questionId }), seedOf(csv));
}
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Check a downloaded evidence.json belongs to the exported records: same run, one label entry per row, same outputs. */
export function checkEvidence(text: string, csv: string, allowLabels: boolean): readonly string[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return ["evidence.json is not JSON"]; }
  if (!isRecord(data)) return ["evidence.json is not an object"];
  const problems: string[] = [];
  if (typeof data.version !== "string" || data.version === "") problems.push("evidence.json has no version");
  if (!Array.isArray(data.attempts)) problems.push("evidence.json has no attempts list");
  const manifest = data.manifest;
  const runId = isRecord(manifest) && typeof manifest.runId === "string" ? manifest.runId : null;
  if (runId === null) problems.push("evidence.json has no manifest.runId");
  if (!Array.isArray(data.labels)) return [...problems, "evidence.json has no labels list"];
  const { header, rows } = readDictRows(csv);
  const at = (name: string): number => (header ?? []).indexOf(name);
  const fromCsv = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.fields[at("case_id")] ?? ""}\0${row.fields[at("output")] ?? ""}`;
    fromCsv.set(key, (fromCsv.get(key) ?? 0) + 1);
    if (runId !== null && (row.fields[at("run_id")] ?? "") !== runId) { problems.push(`records.csv run ${row.fields[at("run_id")] ?? ""} is not evidence run ${runId}`); break; }
  }
  const fromEvidence = new Map<string, number>();
  let labelled = 0;
  for (const entry of data.labels) {
    if (!isRecord(entry) || typeof entry.caseId !== "string" || typeof entry.output !== "string") { problems.push("evidence.json has a malformed label entry"); continue; }
    const key = `${entry.caseId}\0${entry.output}`;
    fromEvidence.set(key, (fromEvidence.get(key) ?? 0) + 1);
    if (entry.label !== null && entry.label !== undefined) labelled++;
  }
  if (rows.length === 0) problems.push("records.csv has no rows to reconcile");
  if (data.labels.length !== rows.length) problems.push(`evidence.json has ${data.labels.length} answers; records.csv has ${rows.length}`);
  const differing = [...new Set([...fromCsv.keys(), ...fromEvidence.keys()])].filter((key) => fromCsv.get(key) !== fromEvidence.get(key));
  if (differing.length) problems.push(`${differing.length} case/output pair(s) differ between evidence.json and records.csv`);
  if (!allowLabels && labelled) problems.push(`evidence.json has ${labelled} label(s); agents never label`);
  return problems;
}
/** Scan path names and raw bytes; report only relative paths and secret names. */
export function scanForSecrets(dir: string, secrets: ReadonlyMap<string, string>): readonly { readonly file: string; readonly name: string }[] {
  const hits: { file: string; name: string }[] = [];
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      const rel = relative(dir, full).split("\\").join("/");
      for (const [name, value] of secrets) if (value.length >= 8 && rel.includes(value)) hits.push({ file: rel, name });
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) { hits.push({ file: rel, name: "unsupported entry" }); continue; }
      const bytes = readFileSync(full);
      for (const [name, value] of secrets) {
        if (value.length < 8 || bytes.includes(Buffer.from(value))) hits.push({ file: rel, name });
      }
    }
  };
  walk(dir);
  if (hits.length === 0) for (const [name, value] of secrets) if (value.length < 8) hits.push({ file: ".", name });
  return hits;
}
export interface ReportInput {
  readonly base: string;
  readonly version: string;
  readonly cloneSha: string | null;
  readonly csv: string;
  readonly caseIds: readonly string[];
  /** Case inputs sent, by case id, and the model id requested per arm; both are checked against records.csv. */
  readonly caseInputs: ReadonlyMap<string, string>;
  readonly armModels: Readonly<Record<Arm, string>>;
  /** Downloaded evidence.json text; checked against records.csv in a non-dry run. */
  readonly evidence?: string;
  readonly verdictText: string;
  readonly steps: readonly { room: string; step: string; pass: boolean; detail: string; shot: string }[];
  readonly secretHits: readonly { file: string; name: string }[];
  readonly runTime?: string;
  readonly labels?: string;
  readonly notes?: readonly string[];
  readonly dryRun?: boolean;
}
const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ");
/** Replace every nonempty provider key with its role label before text leaves the process. */
export function redact(text: string, secrets: ReadonlyMap<string, string>): string {
  let clean = text;
  for (const [name, secret] of [...secrets].sort((left, right) => right[1].length - left[1].length)) {
    if (secret) clean = clean.replaceAll(secret, `[${name} redacted]`);
  }
  return clean;
}
/** The Opening Night text must parse, and must be the verdict Backstage computes from the exported records. */
function verdictProblem(verdictText: string, csv: string): string | null {
  const opening = readOpeningNight(verdictText);
  if ("error" in opening) return opening.error;
  const expected = expectedVerdict(csv);
  if ("error" in expected) return `Opening Night verdict does not follow from records.csv: ${expected.error}`;
  if (expected.verdict !== opening.verdict || expected.condition !== opening.condition || expected.reason !== opening.reason)
    return `Opening Night verdict does not follow from records.csv (records give ${expected.reason})`;
  return null;
}
/** Render a report and refuse any failed or missing step, record, evidence, verdict, or secret check. */
export function buildReport(input: ReportInput): { readonly ok: boolean; readonly exitCode: 0 | 1; readonly markdown: string } {
  const allowLabels = input.labels === "by a person (--pause-for-labels)";
  const problems = input.dryRun ? [] : checkRecords(input.csv, input.caseIds, ["jev", "llm", "rule"], allowLabels, { inputs: input.caseInputs, models: input.armModels });
  const evidenceProblems = input.dryRun ? [] : checkEvidence(input.evidence ?? "", input.csv, allowLabels);
  const verdictError = input.dryRun ? null : verdictProblem(input.verdictText, input.csv);
  const ok = input.steps.length > 0 && input.steps.every((s) => s.pass) && problems.length === 0 && evidenceProblems.length === 0 && !verdictError && input.secretHits.length === 0;
  const models = `jev ${input.armModels.jev}, llm ${input.armModels.llm}, rule ${input.armModels.rule}`;
  const lines = [
    input.dryRun ? "# DRY RUN: not evidence for criteria 2-6" : "# Fresh-clone happy path",
    "", `Base: ${cell(input.base)}`, `Version: ${cell(input.version)}`, `Clone SHA: ${cell(input.cloneSha ?? "unknown")}`,
    `Run time: ${cell(input.runTime ?? new Date().toISOString())}`,
    `Model ids: ${cell(models)} (${input.dryRun ? "requested; dry run, not checked" : problems.length === 0 ? "checked against records.csv" : "requested; records check failed"})`,
    `Case count: ${input.caseIds.length}`, `Labels: ${input.labels ?? "none (agents never label)"}`,
    ...(input.notes ?? []).map((note) => cell(note)),
    `Verdict: ${cell(input.verdictText || "unavailable")}`, `Records check: ${problems.length === 0 ? "pass" : `${problems.length} problem(s)`}`,
    "", "| # | Room | Step | Result | Detail | Screenshot |", "|---:|---|---|---|---|---|",
    ...input.steps.map((s, i) => `| ${i + 1} | ${cell(s.room)} | ${cell(s.step)} | ${s.pass ? "PASS" : "FAIL"} | ${cell(s.detail)} | ${s.shot ? `[image](${encodeURI(s.shot)})` : ""} |`),
    "", ...(input.steps.length === 0 ? ["- No steps ran"] : []),
    ...problems.map((p) => `- ${cell(p.caseId)}: ${cell(p.problem)}`),
    ...evidenceProblems.map((p) => `- Evidence: ${cell(p)}`),
    ...(verdictError ? [`- Verdict: ${cell(verdictError)}`] : []),
    ...input.secretHits.map((hit) => `- Secret found: ${cell(hit.name)} in ${cell(hit.file)}`),
  ];
  return { ok, exitCode: ok ? 0 : 1, markdown: lines.join("\n") + "\n" };
}
/** Prepare New Scene fields for the UC13 shop bot. */
export function uc13Scene(factSheet: string): { readonly question: string; readonly choiceA: string; readonly choiceB: string; readonly definitionA: string; readonly definitionB: string; readonly acceptance: string } {
  const lines = factSheet.trim().split("\n").filter((line) => line.trim());
  const fields = [QUESTION, CRITERIA.hand_off, CRITERIA.answer];
  for (const line of lines) {
    const index = fields.findIndex((field) => field.length + line.length + 1 <= 1000);
    if (index < 0) throw new Error("Fact sheet exceeds scene field limits");
    fields[index] = `${fields[index]}\n${line}`;
  }
  return { question: fields[0] ?? QUESTION, choiceA: "hand_off", choiceB: "answer", definitionA: fields[1] ?? CRITERIA.hand_off, definitionB: fields[2] ?? CRITERIA.answer, acceptance: "Use the fact sheet only; hand off anything it does not cover." };
}
/** RFC 4180 case_id,case_input CSV. */
export function casesCsv(cases: readonly { case_id: string; case_input: string }[]): string {
  return formatRows([["case_id", "case_input"], ...cases.map((c) => [c.case_id, c.case_input])]);
}
/** Extract comma-separated keyword terms from rule.md. */
export function ruleKeywords(ruleMd: string): readonly string[] {
  const line = ruleMd.split("\n").find((value) => value.startsWith("available, "));
  if (!line) throw new Error("rule.md has no keyword list");
  return line.split(",").map((term) => term.trim()).filter(Boolean);
}

/**
 * Fit a keyword list into Backstage's cap (src/backstage/run.ts:448, 20 literals). Backstage matches by
 * case-insensitive substring (run.ts:1220), so a term that contains another term never changes the answer and is
 * removed first; terms still over the cap are dropped from the end and reported, never silently. A term is redundant
 * only when a KEPT term covers it; one covered only by a dropped term is dropped too.
 */
export function fitKeywords(terms: readonly string[], cap: number): { readonly kept: readonly string[]; readonly redundant: readonly string[]; readonly dropped: readonly string[] } {
  const lower = terms.map((term) => term.toLowerCase());
  // j covers i when i contains j; of two equal terms the earlier one covers the later.
  const covers = (j: number, i: number): boolean => j !== i && (lower[i] ?? "").includes(lower[j] ?? "") && (lower[i] !== lower[j] || j < i);
  const minimal = terms.map((_, i) => i).filter((i) => !terms.some((_, j) => covers(j, i)));
  const keptIdx = new Set(minimal.slice(0, cap));
  const redundantIdx = new Set(terms.map((_, i) => i).filter((i) => !keptIdx.has(i) && [...keptIdx].some((k) => covers(k, i))));
  const pick = (test: (i: number) => boolean): string[] => terms.filter((_, i) => test(i));
  return { kept: pick((i) => keptIdx.has(i)), redundant: pick((i) => redundantIdx.has(i)), dropped: pick((i) => !keptIdx.has(i) && !redundantIdx.has(i)) };
}

/** A clone pin that does not match the served build; null when they match or no pin was given. */
export function pinError(version: string, cloneSha: string | null): string | null {
  return cloneSha && version !== cloneSha ? `health version ${version} is not the clone ${cloneSha}; another server owns the port, so nothing was driven` : null;
}

export const CHROMIUM_INSTALL = "bunx playwright-core install chromium";
/** Chromium for the driver: --chromium, then UAT_CHROMIUM_PATH, then Playwright's own cache. Never downloads. */
export function resolveChromium(explicit: string | null, fromEnv: string | undefined, bundled: string, exists: (path: string) => boolean): { readonly path: string } | { readonly error: string } {
  const how = `Install Playwright's Chromium with \`${CHROMIUM_INSTALL}\`, or pass --chromium <path> or set UAT_CHROMIUM_PATH to an installed Chrome or Chromium.`;
  const chosen = explicit ?? (fromEnv ? fromEnv : null);
  if (chosen !== null) return exists(chosen) ? { path: chosen } : { error: `Chromium not found at ${chosen} (from ${explicit !== null ? "--chromium" : "UAT_CHROMIUM_PATH"}). ${how}` };
  if (bundled && exists(bundled)) return { path: bundled };
  return { error: `Playwright's Chromium is not installed${bundled ? ` (expected at ${bundled})` : ""}. ${how}` };
}

/** One folder per invocation: time to the millisecond plus a random nonce, so concurrent or repeated runs never share one. */
export function reportDirName(now: Date, suffix: string, nonce: string): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-happy-path-${suffix}-${nonce}`;
}

/** Parse one dotenv value: quotes around a quoted value and an inline ` # comment` are not part of it. */
export function envValue(text: string, name: string): string | null {
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (match?.[1] !== name) continue;
    const rest = (match[2] ?? "").trim();
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(rest);
    if (quoted) return quoted[2] ?? "";
    return rest.replace(/(^|\s)#.*$/, "").trim();
  }
  return null;
}

export type PollState = { readonly done: string } | { readonly fail: string } | null;
/** Re-check until done (returns its detail), failed (throws its reason) or the deadline passes (throws). */
export async function pollUntil(check: () => Promise<PollState>, timeoutMs: number, intervalMs: number, sleep: (ms: number) => Promise<void>, now: () => number = Date.now): Promise<string> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = await check();
    if (state !== null && "done" in state) return state.done;
    if (state !== null) throw new Error(state.fail);
    if (now() >= deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await sleep(intervalMs);
  }
}
/** Run start: progress text appears once the app has started calls; a #run-reason means it refused to start. */
export function runStartState(progress: string, runReason: string): PollState {
  if (progress.trim()) return { done: "started" };
  if (runReason.trim()) return { fail: `Run blocked: ${runReason.trim()}` };
  return null;
}
/** Run end: every selected case/model cell processed with an answer, and no call still in flight. */
export function runCompleteState(preview: string, progress: string, cells: number): PollState {
  const all = new RegExp(`(^|\\D)${cells} of ${cells} selected case/model cells processed; 0 have no answer`).test(preview);
  return all && /No calls in progress/.test(progress) ? { done: "complete" } : null;
}
