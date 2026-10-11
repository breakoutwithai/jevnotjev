/**
 * Reload and inspect a run export (BackstageRun.evidence() as JSON).
 *
 * Contract: a REPRODUCIBILITY and NO-CREDENTIALS check, not an authenticity check. The export is unsigned, so anyone can
 * rewrite it consistently. `ok` means all of:
 *   (a) nothing shaped like a credential anywhere, key or value (CREDENTIAL_PATTERNS, plus any supplied knownKeys);
 *   (b) calcVersion equals this build's CALC_VERSION;
 *   (c) the manifest and scene are valid (the scene through runScene, the run constructor's own validation);
 *   (d) records, comparisons and spend equal a rebuild from the export's own attempts and labels (records.ts);
 *   (e) each verdict recomputes equal through cohortVerdict, the chain report() runs.
 * It does NOT verify provider response metadata (returnedModel, request fingerprints, Jev probabilities, attempt-id
 * uniqueness, suggestion-attempt relationships), nor that the file came from a real run.
 *
 * Never throws: every defect, however malformed the input, is a problem in the result. Problems never quote a string
 * read from the export; they name fields and positions.
 */
import { isDeepStrictEqual } from "node:util";
import { CALC_VERSION, PROTOCOL_VERSION, type Scene } from "./contracts.ts";
import { JEV_ARM_ID } from "./catalog.ts";
import { cohortVerdict, runScene } from "./run.ts";
import {
  EXPORT_COLUMNS,
  RULE_VALUES,
  comparisonPairs,
  extraSpend as extraSpendOf,
  inComparison,
  recordRow,
  ruleOutput,
  totalSpend as totalSpendOf,
  type ComparisonPair,
  type RecordAnswer,
  type Spend,
} from "./records.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import type { Verdict, VerdictName } from "../core/verdict.ts";

export interface CredentialPattern {
  readonly name: string;
  /** Global; a fixed prefix then ONE quantified run, captured as group 1 (the body), so a scan is linear in the text. */
  readonly pattern: RegExp;
}
/**
 * Credential SHAPES, never words: a fixed vendor prefix (or the Bearer scheme, case-insensitive per RFC 7235) followed
 * by a long random body that mixes letters and digits (isTokenShaped). Words, slugs, version strings and model ids after
 * a look-alike prefix are prose. A credential in a shape not listed is not caught; pass exact values as knownKeys.
 * Any change here is checked against the PROSE_CORPUS and KEY_CORPUS tables in export-check.test.ts.
 */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { name: "Anthropic key (sk-ant-)", pattern: /sk-ant-([A-Za-z0-9_-]{32,})/g },
  { name: "OpenAI project key (sk-proj-)", pattern: /\bsk-(?:proj|svcacct|admin)-([A-Za-z0-9_-]{32,})/g },
  { name: "OpenAI key (sk-)", pattern: /\bsk-([A-Za-z0-9]{32,})/g },
  { name: "xAI key (xai-)", pattern: /\bxai-([A-Za-z0-9]{32,})/g },
  { name: "Google key (AIza)", pattern: /\bAIza([0-9A-Za-z_-]{35})/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_([A-Za-z0-9]{30,})/g },
  { name: "Bearer token", pattern: /\bbearer\s+([A-Za-z0-9._~+/=-]{20,})/gi },
];
/** A random token body holds both letters and digits. */
function isTokenShaped(body: string): boolean {
  return /[0-9]/.test(body) && /[A-Za-z]/.test(body);
}
function matchesCredential({ pattern }: CredentialPattern, s: string): boolean {
  // matchAll copies the pattern, so its lastIndex never leaks between calls; each match consumes its run, so this is linear.
  for (const match of s.matchAll(pattern)) if (isTokenShaped(match[1] ?? "")) return true;
  return false;
}
/** Nesting beyond this is refused before anything else reads the export; a real export nests under ten deep. */
export const MAX_EXPORT_DEPTH = 64;
/** Values (strings, numbers, keys, containers) beyond this are refused; a 400-request run holds well under it. */
export const MAX_EXPORT_NODES = 2_000_000;

export interface VerdictCheck {
  readonly armId: string;
  readonly runId: string;
  /** Recomputed from the rebuilt records; null when the run is not a compare run or the pair has no rows. */
  readonly recomputed: VerdictName | null;
  /** What the export recorded; null when it recorded none for this pair. */
  readonly exported: VerdictName | null;
  /** The whole recomputed verdict (numbers, reason, limitations) equals the exported one. */
  readonly matches: boolean;
}
export type { Spend };
export interface ExportCheck {
  readonly ok: boolean;
  /** The export's calcVersion; always null when the export was refused for holding a credential. */
  readonly calcVersion: string | null;
  readonly cases: number;
  readonly labels: number;
  readonly totalSpend: Spend | null;
  readonly verdicts: readonly VerdictCheck[];
  readonly problems: readonly string[];
}
export interface ExportCheckOptions {
  /** Exact secret values to look for too (the containsKey check run.ts applies to a live run). */
  readonly knownKeys?: readonly string[];
}

type Json = Record<string, unknown>;
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(record: Json, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function nullOr<T>(value: unknown, guard: (v: unknown) => v is T): value is T | null {
  return value === null || guard(value);
}

function credentialNames(s: string, knownKeys: readonly string[]): string[] {
  const names = CREDENTIAL_PATTERNS.filter((p) => matchesCredential(p, s)).map(({ name }) => `looks like a ${name}`);
  if (knownKeys.some((key) => key.length > 0 && s.includes(key))) names.push("contains a supplied key");
  return names;
}

interface Scan {
  readonly hits: string[];
  /** Set when the export is too deep or too large to scan; the scan stopped there. */
  readonly limit: string | null;
}
/**
 * Every string in the value, object keys included, checked against the patterns, iteratively and bounded. A path
 * segment from a key that matched is written {redacted}, so no hit's path, nor any path below it, carries the key.
 */
function scan(value: unknown, knownKeys: readonly string[]): Scan {
  const hits: string[] = [];
  const stack: { value: unknown; path: string; depth: number }[] = [{ value, path: "$", depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (++nodes > MAX_EXPORT_NODES) return { hits, limit: `Refused: the export holds more than ${MAX_EXPORT_NODES} values.` };
    if (item.depth > MAX_EXPORT_DEPTH) return { hits, limit: `Refused: the export nests deeper than ${MAX_EXPORT_DEPTH} levels.` };
    const { value: v, path, depth } = item;
    if (typeof v === "string") for (const name of credentialNames(v, knownKeys)) hits.push(`${path}: ${name}`);
    else if (Array.isArray(v))
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], path: `${path}[${i}]`, depth: depth + 1 });
    else if (isRecord(v)) {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry === undefined) continue;
        const [key, child] = entry;
        const names = credentialNames(key, knownKeys);
        const segment = names.length ? "{redacted}" : key;
        for (const name of names) hits.push(`${path}.${segment}{key}: ${name}`);
        stack.push({ value: child, path: `${path}.${segment}`, depth: depth + 1 });
      }
    }
  }
  return { hits, limit: null };
}

/** Paths and pattern names of credential-shaped strings; never the matched text, nor a matching key in a path. */
export function findCredentials(value: unknown, knownKeys: readonly string[] = []): string[] {
  const { hits, limit } = scan(value, knownKeys);
  return limit === null ? hits : [...hits, limit];
}

// ---- The export's parts, each validated to the shape evidence() writes (src/backstage/run.ts evidence()). ----

interface Manifest {
  readonly mode: string;
  readonly arms: readonly string[];
  readonly providers: ReadonlyMap<string, string>;
  readonly runId: string;
  readonly promptVersion: string;
  readonly questionId: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly keywords: readonly string[];
  readonly matchChoice: string;
  readonly otherwiseChoice: string;
  readonly cases: ReadonlyMap<string, string>;
}
function parseScene(scene: unknown, arms: readonly string[] | null, problems: string[]) {
  if (!isRecord(scene)) {
    problems.push("manifest.scene must be an object.");
    return null;
  }
  const question = text(scene, "question");
  const acceptance = text(scene, "acceptance");
  const exclusions = text(scene, "exclusions");
  const matchChoice = text(scene, "matchChoice");
  const otherwiseChoice = text(scene, "otherwiseChoice");
  const keywords = scene.keywords;
  const rawChoices = scene.choices;
  const named = Array.isArray(rawChoices)
    ? rawChoices.flatMap((c) => (isRecord(c) && typeof c.name === "string" && typeof c.definition === "string" ? [{ name: c.name, definition: c.definition }] : []))
    : [];
  const choices = named.map((c) => c.name);
  let ok = true;
  if (question === null || acceptance === null || exclusions === null || matchChoice === null || otherwiseChoice === null || !isStringArray(keywords)) {
    problems.push("manifest.scene needs question, acceptance, exclusions, keywords, matchChoice and otherwiseChoice.");
    ok = false;
  }
  if (!Array.isArray(rawChoices) || rawChoices.length !== 2 || named.length !== 2) {
    problems.push("manifest.scene needs exactly two choices, each with a name and a definition.");
    ok = false;
  }
  const cases = new Map<string, string>();
  const rawCases = scene.cases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    problems.push("manifest.scene needs at least one case.");
    ok = false;
  } else
    rawCases.forEach((c, i) => {
      const id = isRecord(c) ? text(c, "id") : null;
      const input = isRecord(c) ? text(c, "input") : null;
      if (id === null || input === null) {
        problems.push(`manifest.scene.cases[${i}] needs id and input.`);
        ok = false;
      } else if (cases.has(id)) {
        problems.push(`manifest.scene.cases[${i}]: duplicate case id.`);
        ok = false;
      } else cases.set(id, input);
    });
  const [first, second] = named;
  if (
    !ok ||
    first === undefined ||
    second === undefined ||
    question === null ||
    acceptance === null ||
    exclusions === null ||
    matchChoice === null ||
    otherwiseChoice === null ||
    !isStringArray(keywords)
  )
    return null;
  // The run constructor's own scene validation, for every export, populated or empty. Its messages quote no input.
  if (arms !== null) {
    const full: Scene = {
      question,
      choices: [first, second],
      acceptance,
      exclusions,
      keywords,
      matchChoice,
      otherwiseChoice,
      cases: [...cases].map(([id, input]) => ({ id, input })),
    };
    try {
      runScene(full, arms);
    } catch (error) {
      problems.push(`manifest.scene: ${error instanceof Error ? error.message : "invalid scene"}`);
      return null;
    }
  }
  return { question, choices, keywords, matchChoice, otherwiseChoice, cases };
}
function parseManifest(value: unknown, problems: string[]): Manifest | null {
  if (!isRecord(value)) {
    problems.push("manifest needs mode, arms, models, runId, promptVersion, questionId and scene.");
    return null;
  }
  const before = problems.length;
  const mode = text(value, "mode");
  const runId = text(value, "runId");
  const promptVersion = text(value, "promptVersion");
  const questionId = text(value, "questionId");
  const { arms, models } = value;
  if (mode === null || runId === null || promptVersion === null || questionId === null)
    problems.push("manifest needs mode, runId, promptVersion and questionId as text.");
  if (!isStringArray(arms) || !arms.includes(JEV_ARM_ID) || new Set(arms).size !== arms.length)
    problems.push("manifest.arms must be a list of distinct arm ids that includes jev.");
  const providers = new Map<string, string>();
  if (!Array.isArray(models)) problems.push("manifest.models must be a list.");
  else
    models.forEach((m, i) => {
      const id = isRecord(m) ? text(m, "id") : null;
      const provider = isRecord(m) ? text(m, "provider") : null;
      if (id === null || provider === null) problems.push(`manifest.models[${i}] needs id and provider.`);
      else providers.set(id, provider);
    });
  if (isStringArray(arms) && Array.isArray(models)) {
    const expected = arms.filter((id) => id !== "rule");
    if (models.length !== expected.length || !isDeepStrictEqual([...providers.keys()], expected))
      problems.push("manifest.models must be the selected arms other than rule, in order.");
  }
  // The run.ts constructor: one arm (Jev) is jev-only, more is compare.
  if (isStringArray(arms) && mode !== null) {
    const expectedMode = arms.length === 1 ? "jev-only" : "compare";
    if (mode !== expectedMode) problems.push(`manifest.mode must be ${JSON.stringify(expectedMode)} for ${arms.length} selected arm(s).`);
  }
  const scene = parseScene(value.scene, isStringArray(arms) ? arms : null, problems);
  if (problems.length > before || scene === null || mode === null || runId === null || promptVersion === null || questionId === null || !isStringArray(arms))
    return null;
  return { mode, arms, providers, runId, promptVersion, questionId, ...scene };
}

interface Attempt {
  readonly attemptId: string;
  readonly runId: string;
  readonly caseId: string;
  readonly armId: string;
  readonly ok: boolean;
  readonly output: string | null;
  readonly confidence: number | null;
  readonly model: string;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number;
  readonly charge: string | null;
}
function parseAttempt(a: unknown): Attempt | null {
  if (!isRecord(a)) return null;
  const attemptId = text(a, "attemptId");
  const runId = text(a, "runId");
  const caseId = text(a, "caseId");
  const armId = text(a, "armId");
  const model = text(a, "model");
  const { ok, output, confidence, tokensIn, tokensOut, costUsd, latencyMs, charge } = a;
  if (
    attemptId === null ||
    runId === null ||
    caseId === null ||
    armId === null ||
    model === null ||
    typeof ok !== "boolean" ||
    !nullOr(tokensIn, count) ||
    !nullOr(tokensOut, count) ||
    !nullOr(costUsd, nonNegative) ||
    !nonNegative(latencyMs)
  )
    return null;
  if (ok ? typeof output !== "string" || !nullOr(confidence, isFiniteNumber) : !(charge === "none" || charge === "unknown" || charge === "known"))
    return null;
  return {
    attemptId,
    runId,
    caseId,
    armId,
    ok,
    output: typeof output === "string" ? output : null,
    confidence: isFiniteNumber(confidence) ? confidence : null,
    model,
    tokensIn,
    tokensOut,
    costUsd,
    latencyMs,
    charge: typeof charge === "string" ? charge : null,
  };
}
function parseAttempts(value: unknown, field: string, problems: string[]): Attempt[] | null {
  if (!Array.isArray(value)) {
    problems.push(`${field} must be a list.`);
    return null;
  }
  const out: Attempt[] = [];
  let bad = false;
  value.forEach((item, i) => {
    const attempt = parseAttempt(item);
    if (attempt !== null) out.push(attempt);
    else {
      bad = true;
      problems.push(
        `${field}[${i}] needs attemptId, runId, caseId, armId, model, ok, latencyMs, whole non-negative token counts and a non-negative costUsd (or null), with output on success or charge on failure.`,
      );
    }
  });
  return bad ? null : out;
}

interface ExportLabel {
  readonly caseId: string;
  readonly armId: string;
  readonly provider: string;
  readonly output: string;
  readonly label: "accept" | "reject" | null;
  readonly labelSource: string | null;
  readonly labelledBy: string | null;
  readonly labelledAt: string | null;
  readonly labelBlind: boolean | null;
  readonly labelFinal: "accept" | "reject" | null;
  readonly suggestionShown: boolean | null;
}
const LABEL_SOURCES: readonly string[] = ["human", "human_reviewed", "agent"];
function isCall(value: unknown): value is "accept" | "reject" {
  return value === "accept" || value === "reject";
}
function isLabelSource(value: unknown): value is string {
  return typeof value === "string" && LABEL_SOURCES.includes(value);
}
function parseLabel(item: unknown, i: number, problems: string[]): ExportLabel | null {
  if (!isRecord(item)) {
    problems.push(`labels[${i}] must be an object.`);
    return null;
  }
  const caseId = text(item, "caseId");
  const armId = text(item, "armId");
  const provider = text(item, "provider");
  const output = text(item, "output");
  const { label, labelSource, labelledBy, labelledAt, labelBlind, labelFinal, suggestionShown } = item;
  if (caseId === null || armId === null || provider === null || output === null) {
    problems.push(`labels[${i}] needs caseId, armId, provider and output.`);
    return null;
  }
  if (!nullOr(label, isCall)) {
    problems.push(`labels[${i}]: label value must be accept, reject or null.`);
    return null;
  }
  if (
    !nullOr(labelSource, isLabelSource) ||
    !nullOr(labelFinal, isCall) ||
    !nullOr(labelledBy, isString) ||
    !nullOr(labelledAt, isString) ||
    !nullOr(labelBlind, isBoolean) ||
    !nullOr(suggestionShown, isBoolean)
  ) {
    problems.push(`labels[${i}]: label provenance has an invalid labelSource, labelledBy, labelledAt, labelBlind, labelFinal or suggestionShown.`);
    return null;
  }
  // evidence() writes provenance from the stored label: all of it with a label, none of it without one.
  const required = [labelSource, labelledBy, labelledAt, labelBlind];
  if (label === null ? [...required, labelFinal, suggestionShown].some((v) => v !== null) : required.some((v) => v === null)) {
    problems.push(`labels[${i}]: label provenance must be complete with a label and empty without one.`);
    return null;
  }
  return { caseId, armId, provider, output, label, labelSource, labelledBy, labelledAt, labelBlind, labelFinal, suggestionShown };
}
function parseLabels(value: unknown, problems: string[]): ExportLabel[] {
  if (!Array.isArray(value)) {
    problems.push("labels is missing or not a list.");
    return [];
  }
  return value.flatMap((item, i) => {
    const label = parseLabel(item, i, problems);
    return label === null ? [] : [label];
  });
}

interface ExportComparison {
  readonly armId: string;
  readonly runId: string;
  readonly filename: string;
  readonly csv: string;
  readonly attemptIds: readonly string[];
}
function parseComparisons(value: unknown, problems: string[]): ExportComparison[] {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("comparisons is missing or empty.");
    return [];
  }
  const out: ExportComparison[] = [];
  value.forEach((item, i) => {
    const armId = isRecord(item) ? text(item, "armId") : null;
    const runId = isRecord(item) ? text(item, "runId") : null;
    const filename = isRecord(item) ? text(item, "filename") : null;
    const csv = isRecord(item) ? text(item, "csv") : null;
    const attemptIds = isRecord(item) ? item.attemptIds : null;
    if (armId === null || runId === null || filename === null || csv === null || !isStringArray(attemptIds))
      problems.push(`comparisons[${i}] needs armId, runId, filename, csv and attemptIds.`);
    else out.push({ armId, runId, filename, csv, attemptIds });
  });
  return out;
}

interface ExportVerdict {
  readonly armId: string;
  readonly runId: string;
  readonly verdict: unknown;
}
function parseVerdicts(value: unknown, problems: string[]): ExportVerdict[] | null {
  if (value === null || value === undefined) {
    problems.push("verdicts is null: the export records no verdict to reproduce.");
    return null;
  }
  if (!Array.isArray(value)) {
    problems.push("verdicts is not a list.");
    return null;
  }
  const out: ExportVerdict[] = [];
  value.forEach((item, i) => {
    const armId = isRecord(item) ? text(item, "armId") : null;
    const runId = isRecord(item) ? text(item, "runId") : null;
    if (!isRecord(item) || armId === null || runId === null || !("verdict" in item)) problems.push(`verdicts[${i}] needs armId, runId and verdict.`);
    else out.push({ armId, runId, verdict: item.verdict });
  });
  return out;
}

function parseSpend(value: unknown, field: string, problems: string[]): Spend | null {
  if (!isRecord(value)) {
    problems.push(`${field} needs knownUsd and unknown numbers.`);
    return null;
  }
  const { knownUsd, unknown } = value;
  if (!nonNegative(knownUsd)) problems.push(`${field}.knownUsd must be a finite, non-negative number of dollars.`);
  if (!count(unknown)) problems.push(`${field}.unknown must be a non-negative whole number.`);
  return nonNegative(knownUsd) && count(unknown) ? { knownUsd, unknown } : null;
}

function verdictName(value: unknown): VerdictName | null {
  if (!isRecord(value)) return null;
  const name = value.verdict;
  return name === "use Jev" || name === "don't use Jev" || name === "not enough evidence" ? name : null;
}

// ---- Rebuilding the records evidence() exports. ----

/** One answer: its label entry plus the values its row carries (from its attempt, or the rule's fixed values). */
interface Answer extends RecordAnswer {
  readonly label: ExportLabel;
  readonly attemptId: string | null;
}

/**
 * The answers the labels describe, each reconciled with the manifest and attempts: one per (case, arm), the case in
 * the scene, the arm selected, the provider the arm's, the output the attempt's (or the rule's), every successful
 * attempt answered exactly once, and the rule's rows all present once the run started.
 */
function reconcileAnswers(m: Manifest, labels: readonly ExportLabel[], attempts: readonly Attempt[], problems: string[]): Answer[] {
  const successes = new Map<string, Attempt>();
  const successAt = new Map<string, number>();
  attempts.forEach((a, i) => {
    if (a.runId !== m.runId) problems.push(`attempts[${i}]: runId is not the manifest's.`);
    if (!m.cases.has(a.caseId)) problems.push(`attempts[${i}]: its case is not in the scene.`);
    if (!m.providers.has(a.armId)) problems.push(`attempts[${i}]: its arm is not a selected model.`);
    if (!a.ok) return;
    const key = JSON.stringify([a.caseId, a.armId]);
    if (successes.has(key)) problems.push(`attempts[${i}]: a second successful attempt for its case and arm.`);
    else {
      successes.set(key, a);
      successAt.set(key, i);
    }
  });
  const seen = new Set<string>();
  const answers: Answer[] = [];
  labels.forEach((l, i) => {
    const key = JSON.stringify([l.caseId, l.armId]);
    if (seen.has(key)) {
      problems.push(`labels[${i}]: duplicate label for its case and arm.`);
      return;
    }
    seen.add(key);
    const input = m.cases.get(l.caseId);
    if (input === undefined || !m.arms.includes(l.armId)) {
      problems.push(`labels[${i}]: no answer for this case and arm (not a scene case and a selected arm).`);
      return;
    }
    const provider = l.armId === "rule" ? "rule" : m.providers.get(l.armId);
    if (l.provider !== provider) problems.push(`labels[${i}]: provider is not the arm's.`);
    if (l.armId === "rule") {
      if (l.output !== ruleOutput(m, input)) problems.push(`labels[${i}]: output is not the keyword rule's answer for its case.`);
      answers.push({ label: l, attemptId: null, caseId: l.caseId, provider: l.provider, output: l.output, ...RULE_VALUES });
      return;
    }
    const attempt = successes.get(key);
    if (attempt === undefined) {
      problems.push(`labels[${i}]: no answer for its case and arm: no successful attempt.`);
      return;
    }
    if (attempt.output !== l.output) problems.push(`labels[${i}]: output differs from its successful attempt's output.`);
    const { attemptId, model, confidence, tokensIn, tokensOut, costUsd, latencyMs } = attempt;
    answers.push({ label: l, attemptId, caseId: l.caseId, provider: l.provider, output: l.output, model, confidence, tokensIn, tokensOut, costUsd, latencyMs });
  });
  for (const key of successes.keys())
    if (!seen.has(key)) problems.push(`attempts[${successAt.get(key) ?? "?"}]: a successful attempt with no labels entry.`);
  if (m.arms.includes("rule") && (attempts.length > 0 || labels.length > 0)) {
    const ruleRows = labels.filter((l) => l.armId === "rule").length;
    if (ruleRows !== m.cases.size)
      problems.push(`labels: the rule answers every case once the run starts; ${ruleRows} of ${m.cases.size} cases have a rule row.`);
  }
  return answers;
}

/** Where two CSV texts first differ, by data row and column; never their values. */
function firstDifference(actual: string, expected: string): string {
  try {
    const a = readDictRows(actual);
    const e = readDictRows(expected);
    if (!isDeepStrictEqual(a.header, e.header)) return "the header";
    if (a.rows.length !== e.rows.length) return `the row count (${a.rows.length}, rebuilt ${e.rows.length})`;
    for (let r = 0; r < e.rows.length; r++)
      for (let c = 0; c < EXPORT_COLUMNS.length; c++)
        if ((a.rows[r]?.fields[c] ?? "") !== (e.rows[r]?.fields[c] ?? "")) return `data row ${r + 1}, column ${EXPORT_COLUMNS[c] ?? c}`;
    return "the bytes (quoting or line endings)";
  } catch {
    return "the CSV, which does not parse";
  }
}

function refused(problems: string[]): ExportCheck {
  return { ok: false, calcVersion: null, cases: 0, labels: 0, totalSpend: null, verdicts: [], problems };
}

/** Check a parsed export. `ok` is true only when there are no problems at all. Never throws. */
export async function checkExport(data: unknown, options: ExportCheckOptions = {}): Promise<ExportCheck> {
  try {
    return await checkParsed(data, options);
  } catch (error) {
    // A defect in this checker, not a verdict on the export: the error class only, never a message that may quote input.
    return refused([`The export could not be checked (${error instanceof Error ? error.name : "unknown error"}); treat it as not reproduced.`]);
  }
}

async function recomputePair(m: Manifest, pair: ComparisonPair, index: number, csv: string, rows: number, problems: string[]): Promise<Verdict | null> {
  try {
    // The chain BackstageRun.report() runs for each pair; a pair with no answers is an empty cohort with no verdict.
    const outcome = await cohortVerdict(
      csv,
      {
        mode: m.mode,
        key: { runId: pair.runId, promptVersion: m.promptVersion, questionId: m.questionId },
        question: m.question,
        answerSet: m.choices.join("|"),
      },
      rows === 0,
    );
    if (outcome.ok) return outcome.verdict;
    problems.push(`comparisons[${index}]: rebuilt records fail validation (${outcome.errors.length} error(s)).`);
  } catch (error) {
    problems.push(`comparisons[${index}]: the verdict could not be recomputed (${error instanceof Error ? error.name : "unknown error"}).`);
  }
  return null;
}

async function checkParsed(data: unknown, options: ExportCheckOptions): Promise<ExportCheck> {
  if (!isRecord(data)) return refused(["The export is not a JSON object."]);

  const { hits, limit } = scan(data, options.knownKeys ?? []);
  // Refused for a credential: nothing read from the export comes back, only redacted paths and pattern names.
  if (hits.length) return refused(["Refused: the export contains something that looks like a credential.", ...hits, ...(limit ? [limit] : [])]);
  if (limit) return refused([limit]);

  const problems: string[] = [];
  if (data.version !== PROTOCOL_VERSION) problems.push(`version must be ${PROTOCOL_VERSION}, the protocol this build reads.`);
  const calcVersion = text(data, "calcVersion");
  if (calcVersion === null)
    problems.push(`No calcVersion: the export does not say which calculation made its verdicts (this build runs ${CALC_VERSION}).`);
  // Never echo the value: it is untrusted text.
  else if (calcVersion !== CALC_VERSION) problems.push(`calcVersion differs from ${CALC_VERSION}: this build cannot reproduce its verdicts.`);

  const manifest = parseManifest(data.manifest, problems);
  const attempts = parseAttempts(data.attempts, "attempts", problems);
  const suggestionAttempts = parseAttempts(data.suggestionAttempts, "suggestionAttempts", problems);
  const labels = parseLabels(data.labels, problems);
  const comparisons = parseComparisons(data.comparisons, problems);
  const exportedVerdicts = parseVerdicts(data.verdicts, problems);
  const totalSpend = parseSpend(data.totalSpend, "totalSpend", problems);
  const extraSpend = parseSpend(data.extraSpend, "extraSpend", problems);
  if (attempts !== null && suggestionAttempts !== null) {
    const all = [...attempts, ...suggestionAttempts];
    if (totalSpend !== null && !isDeepStrictEqual(totalSpend, totalSpendOf(all)))
      problems.push("totalSpend does not match the attempts (every attempt once, as BackstageRun.totalSpend counts).");
    if (extraSpend !== null && !isDeepStrictEqual(extraSpend, extraSpendOf(all)))
      problems.push("extraSpend does not match the attempts (failed attempts, as BackstageRun.extraSpend counts).");
  }

  const cases = manifest?.cases.size ?? 0;
  const verdicts: VerdictCheck[] = [];
  if (manifest === null || attempts === null) return { ok: false, calcVersion, cases, labels: labels.length, totalSpend, verdicts, problems };

  const answers = reconcileAnswers(manifest, labels, attempts, problems);
  const pairs = comparisonPairs(manifest.arms, manifest.runId);
  const sameComparisons =
    comparisons.length === pairs.length &&
    pairs.every((p, i) => comparisons[i]?.armId === p.armId && comparisons[i]?.runId === p.runId && comparisons[i]?.filename === p.filename);
  if (!sameComparisons)
    problems.push(`comparisons must be exactly one per pair the manifest selects (${pairs.length}), in order, with each pair's armId, runId and filename.`);
  if (
    exportedVerdicts !== null &&
    !(exportedVerdicts.length === pairs.length && pairs.every((p, i) => exportedVerdicts[i]?.armId === p.armId && exportedVerdicts[i]?.runId === p.runId))
  )
    problems.push(`verdicts must be exactly one per comparison (${pairs.length}), in order, with each pair's armId and runId.`);

  const rebuilt: string[][][] = [];
  for (const [index, pair] of pairs.entries()) {
    const mine = answers.filter((a) => inComparison(a.label.armId, pair.armId));
    const rows = mine.map((a) => recordRow(manifest, a, a.label, pair.runId));
    rebuilt.push(rows);
    const csv = formatRows([EXPORT_COLUMNS, ...rows]);
    const exported = comparisons[index];
    if (exported !== undefined && exported.armId === pair.armId && exported.runId === pair.runId) {
      if (exported.csv !== csv)
        problems.push(`comparisons[${index}]: records differ from what the labels, attempts and manifest rebuild to (first at ${firstDifference(exported.csv, csv)}).`);
      const attemptIds = mine.flatMap((a) => (a.attemptId ? [a.attemptId] : []));
      if (!isDeepStrictEqual(exported.attemptIds, attemptIds)) problems.push(`comparisons[${index}]: attemptIds are not its answers' attempts.`);
    }
    const recomputed = await recomputePair(manifest, pair, index, csv, rows.length, problems);
    const recorded = exportedVerdicts?.[index];
    const samePair = recorded !== undefined && recorded.armId === pair.armId && recorded.runId === pair.runId;
    const matches = samePair && isDeepStrictEqual(JSON.parse(JSON.stringify(recomputed)), recorded.verdict);
    if (samePair && !matches)
      problems.push(
        `verdict mismatch for verdicts[${index}]: exported ${JSON.stringify(verdictName(recorded.verdict))}, recomputed ${JSON.stringify(recomputed?.verdict ?? null)}.`,
      );
    verdicts.push({
      armId: pair.armId,
      runId: pair.runId,
      recomputed: recomputed?.verdict ?? null,
      exported: samePair ? verdictName(recorded.verdict) : null,
      matches,
    });
  }

  // run.ts csv(): one pair's records as they are, else every pair's rows under one header.
  const records = formatRows([EXPORT_COLUMNS, ...rebuilt.flat()]);
  const exportedRecords = text(data, "records");
  if (exportedRecords === null) problems.push("records must be the run's combined CSV text.");
  else if (exportedRecords !== records) problems.push(`records differ from the comparisons' rows combined (first at ${firstDifference(exportedRecords, records)}).`);

  return { ok: problems.length === 0, calcVersion, cases, labels: labels.length, totalSpend, verdicts, problems };
}

/** Parse export text, then check it. Never throws. */
export async function checkExportText(json: string, options: ExportCheckOptions = {}): Promise<ExportCheck> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return refused(["The export is not valid JSON."]);
  }
  return checkExport(data, options);
}
