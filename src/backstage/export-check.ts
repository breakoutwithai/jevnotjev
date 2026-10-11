/**
 * Reload and inspect a run export (BackstageRun.evidence() as JSON). Refuses an export that holds anything shaped like
 * a credential or that was made with a different verdict calculation, then recomputes every comparison verdict from
 * the exported labels with the same chain report() runs (validate -> cohortMetrics -> verdict(fileSeed)).
 */
import { isDeepStrictEqual } from "node:util";
import { CALC_VERSION } from "./contracts.ts";
import { JEV_ARM_ID } from "./catalog.ts";
import { validate } from "../format/validate.ts";
import { formatRows, readDictRows } from "../format/csv.ts";
import { cohortMetrics } from "../core/metrics.ts";
import { fileSeed } from "../core/calc.ts";
import { verdict, type VerdictName } from "../core/verdict.ts";

/** Common provider-key and auth-header shapes. A match anywhere in the export, key or value, refuses it. */
export const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "Anthropic key (sk-ant-)", pattern: /sk-ant-[A-Za-z0-9_-]{8,}/ },
  { name: "OpenAI-style key (sk-)", pattern: /(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/ },
  { name: "xAI key (xai-)", pattern: /(?:^|[^A-Za-z0-9])xai-[A-Za-z0-9_-]{16,}/ },
  { name: "Google key (AIza)", pattern: /AIza[0-9A-Za-z_-]{30,}/ },
  { name: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: "api_ key (as scripts/uc13/calls.ts KEY_PATTERN)", pattern: /(?:^|[^A-Za-z0-9])api[_-][A-Za-z0-9_-]{6,}/ },
  { name: "key assignment", pattern: /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S{8,}/i },
];

export interface VerdictCheck {
  readonly armId: string;
  readonly runId: string;
  /** Recomputed from the exported labels; null when the run is not a compare run or has no rows. */
  readonly recomputed: VerdictName | null;
  /** What the export recorded; null when it recorded none for this pair. */
  readonly exported: VerdictName | null;
  /** The whole recomputed verdict (numbers, reason, limitations) equals the exported one. */
  readonly matches: boolean;
}
export interface ExportCheck {
  readonly ok: boolean;
  readonly calcVersion: string | null;
  readonly cases: number;
  readonly labels: number;
  readonly totalSpend: { readonly knownUsd: number; readonly unknown: number } | null;
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

/** Every string in the value, object keys included, with its JSON path. */
function strings(value: unknown, path: string, out: { path: string; value: string }[]): void {
  if (typeof value === "string") out.push({ path, value });
  else if (Array.isArray(value)) value.forEach((item, i) => strings(item, `${path}[${i}]`, out));
  else if (isRecord(value))
    for (const [key, item] of Object.entries(value)) {
      out.push({ path: `${path}{key}`, value: key });
      strings(item, `${path}.${key}`, out);
    }
}

/** Paths and pattern names of credential-shaped strings; never the matched text itself. */
export function findCredentials(value: unknown, knownKeys: readonly string[] = []): string[] {
  const found: { path: string; value: string }[] = [];
  strings(value, "$", found);
  const hits: string[] = [];
  for (const { path, value: s } of found) {
    for (const { name, pattern } of CREDENTIAL_PATTERNS) if (pattern.test(s)) hits.push(`${path}: looks like a ${name}`);
    if (knownKeys.some((key) => key.length > 0 && s.includes(key))) hits.push(`${path}: contains a supplied key`);
  }
  return hits;
}

interface ExportLabel {
  readonly caseId: string;
  readonly armId: string;
  readonly label: string | null;
}
interface ExportComparison {
  readonly armId: string;
  readonly runId: string;
  readonly csv: string;
}
interface ExportVerdict {
  readonly armId: string;
  readonly runId: string;
  readonly verdict: unknown;
}

function parseLabels(value: unknown, problems: string[]): ExportLabel[] {
  if (!Array.isArray(value)) {
    problems.push("labels is missing or not a list.");
    return [];
  }
  const out: ExportLabel[] = [];
  value.forEach((item, i) => {
    const caseId = isRecord(item) ? text(item, "caseId") : null;
    const armId = isRecord(item) ? text(item, "armId") : null;
    const label = isRecord(item) ? item.label : undefined;
    if (caseId === null || armId === null || !(label === null || typeof label === "string"))
      problems.push(`labels[${i}] needs caseId, armId and a label (text or null).`);
    else out.push({ caseId, armId, label });
  });
  return out;
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
    const csv = isRecord(item) ? text(item, "csv") : null;
    if (armId === null || runId === null || csv === null)
      problems.push(`comparisons[${i}] needs armId, runId and csv.`);
    else out.push({ armId, runId, csv });
  });
  return out;
}
function parseVerdicts(value: unknown, problems: string[]): ExportVerdict[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    problems.push("verdicts is not a list.");
    return null;
  }
  const out: ExportVerdict[] = [];
  value.forEach((item, i) => {
    const armId = isRecord(item) ? text(item, "armId") : null;
    const runId = isRecord(item) ? text(item, "runId") : null;
    if (!isRecord(item) || armId === null || runId === null || !("verdict" in item))
      problems.push(`verdicts[${i}] needs armId, runId and verdict.`);
    else out.push({ armId, runId, verdict: item.verdict });
  });
  return out;
}
function parseSpend(value: unknown): ExportCheck["totalSpend"] {
  if (!isRecord(value)) return null;
  const { knownUsd, unknown } = value;
  return typeof knownUsd === "number" && typeof unknown === "number" ? { knownUsd, unknown } : null;
}
function verdictName(value: unknown): VerdictName | null {
  if (!isRecord(value)) return null;
  const name = value.verdict;
  return name === "use Jev" || name === "don't use Jev" || name === "not enough evidence" ? name : null;
}

/** The arm id of the labels[] entry a records row came from: the comparison's LLM arm, Jev, or the rule. */
function rowArm(answerer: string, comparison: ExportComparison): string {
  return answerer === "jev" ? JEV_ARM_ID : answerer === "rule" ? "rule" : comparison.armId;
}

/**
 * The comparison's records with each label replaced by the labels[] entry for the same case and arm, and one problem
 * per row where the two disagree. Returns the CSV unchanged when they all agree.
 */
function relabel(comparison: ExportComparison, labels: readonly ExportLabel[], problems: string[]): string {
  const { header, rows } = readDictRows(comparison.csv);
  const caseAt = header?.indexOf("case_id") ?? -1;
  const answererAt = header?.indexOf("answerer") ?? -1;
  const labelAt = header?.indexOf("label") ?? -1;
  if (!header || caseAt < 0 || answererAt < 0 || labelAt < 0) {
    problems.push(`comparison ${comparison.armId}: records lack case_id, answerer or label.`);
    return comparison.csv;
  }
  let changed = false;
  const fixed = rows.map((row) => {
    const caseId = row.fields[caseAt] ?? "";
    const armId = rowArm(row.fields[answererAt] ?? "", comparison);
    const inRecords = row.fields[labelAt] ?? "";
    const entry = labels.find((l) => l.caseId === caseId && l.armId === armId);
    if (!entry) {
      problems.push(`comparison ${comparison.armId}: no labels entry for case ${caseId}, arm ${armId}.`);
      return row.fields;
    }
    const exported = entry.label ?? "";
    if (exported === inRecords) return row.fields;
    problems.push(
      `label mismatch: case ${caseId}, arm ${armId}: labels says ${JSON.stringify(exported)}, records say ${JSON.stringify(inRecords)}.`,
    );
    changed = true;
    return row.fields.map((field, i) => (i === labelAt ? exported : field));
  });
  return changed ? formatRows([header, ...fixed]) : comparison.csv;
}

/** Check a parsed export. `ok` is true only when there are no problems at all. */
export async function checkExport(data: unknown, options: ExportCheckOptions = {}): Promise<ExportCheck> {
  const problems: string[] = [];
  const empty = { cases: 0, labels: 0, totalSpend: null, verdicts: [] };
  if (!isRecord(data))
    return { ok: false, calcVersion: null, ...empty, problems: ["The export is not a JSON object."] };

  const credentials = findCredentials(data, options.knownKeys);
  if (credentials.length)
    return {
      ok: false,
      calcVersion: text(data, "calcVersion"),
      ...empty,
      problems: ["Refused: the export contains something that looks like a credential.", ...credentials],
    };

  const calcVersion = text(data, "calcVersion");
  if (calcVersion === null)
    problems.push(`No calcVersion: the export does not say which calculation made its verdicts (this build runs ${CALC_VERSION}).`);
  else if (calcVersion !== CALC_VERSION)
    problems.push(
      `This export was made with a different calculation (${calcVersion}); this build runs ${CALC_VERSION}, so its verdicts cannot be reproduced here.`,
    );

  const manifest = isRecord(data.manifest) ? data.manifest : null;
  const scene = manifest && isRecord(manifest.scene) ? manifest.scene : null;
  const mode = manifest ? text(manifest, "mode") : null;
  const promptVersion = manifest ? text(manifest, "promptVersion") : null;
  const questionId = manifest ? text(manifest, "questionId") : null;
  if (!manifest || !scene || mode === null || promptVersion === null || questionId === null)
    problems.push("manifest needs mode, promptVersion, questionId and scene.");
  const cases = scene && Array.isArray(scene.cases) ? scene.cases.length : 0;
  const labels = parseLabels(data.labels, problems);
  const comparisons = parseComparisons(data.comparisons, problems);
  const exportedVerdicts = parseVerdicts(data.verdicts, problems);
  if (exportedVerdicts === null) problems.push("verdicts is null: the export records no verdict to reproduce.");
  const totalSpend = parseSpend(data.totalSpend);
  if (totalSpend === null) problems.push("totalSpend needs knownUsd and unknown numbers.");

  const verdicts: VerdictCheck[] = [];
  if (promptVersion !== null && questionId !== null)
    for (const comparison of comparisons) {
      const csv = relabel(comparison, labels, problems);
      const parsed = validate(csv);
      if (parsed.errors.length) problems.push(`comparison ${comparison.armId}: records fail validation: ${parsed.errors[0]}`);
      // The same chain BackstageRun.report() runs for each pair.
      const recomputed =
        mode === "compare" && parsed.rows.length && !parsed.errors.length
          ? verdict(cohortMetrics(parsed.rows, { runId: comparison.runId, promptVersion, questionId }), await fileSeed(csv))
          : null;
      const recorded = exportedVerdicts?.find((v) => v.armId === comparison.armId && v.runId === comparison.runId);
      const matches =
        recorded !== undefined && isDeepStrictEqual(JSON.parse(JSON.stringify(recomputed)), recorded.verdict);
      if (exportedVerdicts !== null && !matches)
        problems.push(
          recorded === undefined
            ? `verdict missing for ${comparison.armId}: the export records none for this pair.`
            : `verdict mismatch for ${comparison.armId}: exported ${JSON.stringify(verdictName(recorded.verdict))}, recomputed ${JSON.stringify(recomputed?.verdict ?? null)}.`,
        );
      verdicts.push({
        armId: comparison.armId,
        runId: comparison.runId,
        recomputed: recomputed?.verdict ?? null,
        exported: verdictName(recorded?.verdict),
        matches,
      });
    }

  return { ok: problems.length === 0, calcVersion, cases, labels: labels.length, totalSpend, verdicts, problems };
}

/** Parse export text, then check it. */
export async function checkExportText(json: string, options: ExportCheckOptions = {}): Promise<ExportCheck> {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { ok: false, calcVersion: null, cases: 0, labels: 0, totalSpend: null, verdicts: [], problems: ["The export is not valid JSON."] };
  }
  return checkExport(data, options);
}
