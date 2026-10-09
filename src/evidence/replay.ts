// D14 replay view: one recorded run as cases you can step through, the tally after each case, each method's
// recorded totals, and a flag for every method whose evidence is incomplete (a missing row, a missing cost,
// unlabelled answers, or fewer paired labelled cases than a verdict needs). Pure functions over a records CSV;
// scripts/replay-data.ts writes their output for site/replay/.

import { readDictRows, type CsvRecord } from "../format/csv.ts";
import { parseCell, truthLabel, type ParsedRow } from "../format/validate.ts";
import { armsInFile, groupCohorts, metricsOfCohortRows, provenanceByMethod } from "../core/metrics.ts";
import { MIN_PAIRED, verdictLimitations } from "../core/verdict.ts";

/** What the page shows for a label src/core/metrics.ts does not count (format/validate.ts truthLabel). */
export const NOT_COUNTED = "not counted (AI label, not reviewed)";

/** The methods the site compares, in the order the site shows them (site/little-shop, site/index.html). */
export const COMPARED: readonly string[] = ["llm", "rule", "jev"];
/** The site's names for the three methods (site/uc13-demo.js, site/index.html). */
export const METHOD_NAMES: Readonly<Record<string, string>> = { llm: "What you do now", rule: "A simple rule", jev: "Jev decides", decisions: "OpenAI Decisions API" };

/** The handle on a synthetic generator's labels: the case was written to be a yes or a no, so the label is known by construction. */
export const GENERATOR_HANDLE = "synthetic-generator";

export interface Spotlight { readonly caseKey: string; readonly heading: string }

export interface RunSource {
  readonly key: string;
  /** Repo-relative path of the records file. */
  readonly file: string;
  readonly title: string;
  readonly synthetic: boolean;
  /** Replay a long run in pages: the first `pageBy` cases one at a time, then `pageBy` cases per step. */
  readonly pageBy?: number;
  /** Methods the run was meant to include; one with no rows is listed and flagged once. */
  readonly extraMethods?: readonly string[];
  /** A case the page offers a popup for: its key and the heading over it. */
  readonly spotlight?: Spotlight;
}

export const RUN_SOURCES: readonly RunSource[] = [
  { key: "uc13", file: "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv", title: "Ski shop bot", synthetic: false },
  { key: "tokenmax", file: "docs/product/runs/2026-10-03-tokenmax/records.csv", title: "TokenMax CV screen", synthetic: false },
  { key: "d12", file: "examples/d12-three-methods/records.csv", title: "Delivery messages", synthetic: true },
];

export interface ReplayRow {
  readonly line: number;
  readonly caseKey: string;
  readonly answerer: string;
  readonly model: string;
  readonly input: string;
  readonly output: string;
  readonly label: string;
  /** The label every count reads (truthLabel): empty when the cell is empty or an unreviewed `agent` label. */
  readonly truth: string;
  /** NOT_COUNTED when the row has a label that truth drops, else empty. */
  readonly labelNote: string;
  /** Present (true) only when `truth` is a synthetic generator's label, counted in this replay's tally but never in a verdict. */
  readonly generated?: true;
  readonly outcome: string;
  readonly answered: boolean;
  readonly costUsd: number | null;
  readonly costText: string;
}

/** Paired labelled cases for Jev against one other method in one cohort, as src/core/metrics.ts counts them. */
export interface ReplayPair {
  readonly runId: string;
  readonly promptVersion: string;
  readonly questionId: string;
  readonly other: "llm" | "rule";
  readonly n: number;
}

/** One question (cohort) of a run and what limits a verdict on it: the same lines the CSV loader shows. */
export interface ReplayQuestion {
  readonly runId: string;
  readonly promptVersion: string;
  readonly questionId: string;
  readonly question: string;
  readonly limitations: readonly string[];
}

export interface MethodStats {
  readonly method: string;
  readonly name: string;
  readonly model: string;
  readonly rows: number;
  readonly answered: number;
  readonly labelled: number;
  readonly accept: number;
  readonly reject: number;
  readonly unlabelled: number;
  readonly costed: number;
  /** Sum of cost_usd, or null when any of the method's rows has no cost. */
  readonly cost: number | null;
  readonly costText: string;
  /** Sum of the cost_usd cells that are recorded, so an incomplete total still shows what is known. */
  readonly knownCost: number;
  readonly knownCostText: string;
  /** Cases of the run this method has at least one row for. */
  readonly casesCovered: number;
  readonly lines: readonly number[];
}

export type FlagKind = "missing" | "cost" | "unlabelled" | "below-minimum";

export interface Flag {
  readonly id: string;
  readonly method: string;
  readonly kind: FlagKind;
  readonly caseKey: string;
  /** Plain text without the run's name: the page shows each flag under its run. */
  readonly text: string;
  readonly lines: readonly number[];
}

export interface StepTally {
  readonly method: string;
  readonly accepted: number;
  readonly played: number;
  readonly missing: number;
}

export interface ReplayCase {
  readonly key: string;
  readonly question: string;
  readonly input: string;
}

export interface ReplayRun {
  readonly key: string;
  readonly runId: string;
  readonly title: string;
  readonly file: string;
  readonly synthetic: boolean;
  readonly labelSource: string;
  readonly cases: readonly ReplayCase[];
  readonly methods: readonly string[];
  readonly rows: readonly ReplayRow[];
  readonly stats: readonly MethodStats[];
  readonly flags: readonly Flag[];
  readonly pairs: readonly ReplayPair[];
  /** Per question (cohort): the verdict's limitation lines, from src/core/verdict.ts verdictLimitations. */
  readonly questions: readonly ReplayQuestion[];
  /** Per method: where its labels came from and whether they were blind (src/core/metrics.ts provenanceByMethod). */
  readonly provenance: readonly string[];
  /** steps[i] is the tally after cases 0..i. */
  readonly steps: readonly (readonly StepTally[])[];
  /** Present for a long run: the first `pageBy` cases play one at a time, then `pageBy` cases per step. */
  readonly pageBy?: number;
  readonly spotlight?: Spotlight;
}

/** The site's cost format (site/little-shop/seating.js usd): $0 for zero, 6 decimals under $1, else 4. A cost that
 * was not recorded reads "incomplete", never $0. */
export function usd(v: number | null): string {
  if (v === null) return "incomplete";
  if (!Number.isFinite(v) || v < 0) return "n/a";
  if (v === 0) return "$0";
  return `$${v.toFixed(v < 1 ? 6 : 4)}`;
}

function num(value: string): number | null {
  if (value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface Parsed extends ReplayRow {
  readonly caseId: string;
  readonly questionId: string;
  readonly question: string;
  readonly labelSource: string;
  readonly labelledBy: string;
}

function methodName(m: string): string {
  return METHOD_NAMES[m] ?? m;
}

/** The tally after cases 0..pos: accepted and played rows per method, and cases with no row for it. */
export function tallyThrough(run: Pick<ReplayRun, "cases" | "methods" | "rows">, pos: number): StepTally[] {
  const seen = new Set(run.cases.slice(0, Math.max(0, pos) + 1).map((c) => c.key));
  return run.methods.map((method) => {
    const rows = run.rows.filter((r) => r.answerer === method && seen.has(r.caseKey));
    const covered = new Set(rows.map((r) => r.caseKey)).size;
    return { method, accepted: rows.filter((r) => r.truth === "accept").length, played: rows.length, missing: seen.size - covered };
  });
}

export function parseRun(text: string, source: RunSource): ReplayRun {
  const { header, rows: records } = readDictRows(text);
  if (header === null) throw new Error(`${source.file}: empty file`);
  const col = (record: CsvRecord, name: string): string => {
    const i = header.indexOf(name);
    return i < 0 ? "" : (record.fields[i] ?? "");
  };
  const multiQuestion = new Set(records.map((r) => col(r, "question_id"))).size > 1;
  // The same cells src/format/validate.ts parses, so truthLabel and the metrics read exactly what they read there.
  const parsed: ParsedRow[] = records.map((record) => ({
    line: record.line,
    values: new Map(header.map((name, i) => [name, parseCell(name, record.fields[i] ?? "")])),
    raw: new Map(header.map((name, i) => [name, record.fields[i] ?? ""])),
  }));
  const rows: Parsed[] = records.map((record, i) => {
    const outcome = col(record, "outcome");
    const caseId = col(record, "case_id");
    const questionId = col(record, "question_id");
    const costUsd = num(col(record, "cost_usd"));
    const label = col(record, "label");
    const values = parsed[i]?.values;
    const truthValue = values === undefined ? null : truthLabel(values);
    const counted = typeof truthValue === "string" ? truthValue : "";
    const generated = counted === "" && col(record, "label_source") === "agent" && col(record, "labelled_by") === GENERATOR_HANDLE &&
      (label === "accept" || label === "reject");
    const truth = generated ? label : counted;
    return {
      truth,
      ...(generated ? { generated: true as const } : {}),
      labelNote: label !== "" && truth === "" ? NOT_COUNTED : "",
      line: record.line,
      caseId,
      questionId,
      caseKey: multiQuestion ? `${caseId}-${questionId}` : caseId,
      input: col(record, "case_input"),
      question: col(record, "question"),
      answerer: col(record, "answerer"),
      model: col(record, "answerer_model"),
      output: col(record, "output"),
      label,
      labelSource: col(record, "label_source"),
      labelledBy: col(record, "labelled_by"),
      outcome: outcome === "" ? "answered" : outcome,
      answered: outcome === "" || outcome === "answered",
      costUsd,
      costText: usd(costUsd),
    };
  });

  const present = [...new Set([...rows.map((r) => r.answerer), ...(source.extraMethods ?? [])])];
  const methods = [...COMPARED.filter((m) => present.includes(m)), ...present.filter((m) => !COMPARED.includes(m)).sort()];

  const cases: ReplayCase[] = [];
  for (const row of rows) {
    if (!cases.some((c) => c.key === row.caseKey)) cases.push({ key: row.caseKey, question: row.question, input: row.input });
  }

  const stats: MethodStats[] = methods.map((method) => {
    const mine = rows.filter((r) => r.answerer === method);
    const costed = mine.filter((r) => r.costUsd !== null);
    const knownCost = costed.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
    const cost = costed.length === mine.length ? knownCost : null;
    return {
      method,
      name: methodName(method),
      model: [...new Set(mine.map((r) => r.model))].join(" + "),
      rows: mine.length,
      answered: mine.filter((r) => r.answered).length,
      labelled: mine.filter((r) => r.truth !== "").length,
      accept: mine.filter((r) => r.truth === "accept").length,
      reject: mine.filter((r) => r.truth === "reject").length,
      unlabelled: mine.filter((r) => r.answered && (r.truth === "" || r.generated === true)).length,
      costed: costed.length,
      cost,
      costText: usd(cost),
      knownCost,
      knownCostText: usd(knownCost),
      casesCovered: new Set(mine.map((r) => r.caseKey)).size,
      lines: mine.map((r) => r.line),
    };
  });

  const flags: Flag[] = [];
  for (const c of cases) {
    for (const method of methods.filter((m) => COMPARED.includes(m) || rows.some((r) => r.answerer === m))) {
      if (rows.some((r) => r.caseKey === c.key && r.answerer === method)) continue;
      const covered = new Set(rows.filter((r) => r.answerer === method).map((r) => r.caseKey)).size;
      flags.push({
        id: `${source.key}-${method}-missing-${c.key}`,
        method,
        kind: "missing",
        caseKey: c.key,
        text: `${methodName(method)} has no row for case ${c.key}, so its count covers ${covered} of ${cases.length} cases`,
        lines: rows.filter((r) => r.caseKey === c.key).map((r) => r.line),
      });
    }
  }
  for (const method of source.extraMethods ?? []) {
    if (rows.some((r) => r.answerer === method)) continue;
    flags.push({
      id: `${source.key}-${method}-no-rows`,
      method,
      kind: "missing",
      caseKey: "",
      text: `${methodName(method)} has no rows for any of the ${cases.length} cases, so it is not compared in this run`,
      lines: [],
    });
  }
  for (const row of rows) {
    if (row.costUsd !== null) continue;
    flags.push({
      id: `${source.key}-${row.answerer}-cost-${row.caseKey}`,
      method: row.answerer,
      kind: "cost",
      caseKey: row.caseKey,
      text: `${methodName(row.answerer)} has no cost on case ${row.caseKey} (line ${row.line}), so its total cost is incomplete`,
      lines: [row.line],
    });
  }
  for (const method of methods) {
    const answered = rows.filter((r) => r.answerer === method && r.answered);
    // A generator label is counted in the tally but is not a reviewed label, so it still raises this flag.
    const missing = answered.filter((r) => r.truth === "" || r.generated === true);
    if (missing.length === 0) continue;
    const counted = answered.length - missing.length;
    const has = missing.length === 1 ? "has" : "have";
    const rate = counted === 0 ? "so it has no accept rate" : `so its accept rate counts ${counted === 1 ? "1 row" : `${counted} rows`}`;
    flags.push({
      id: `${source.key}-${method}-unlabelled`,
      method,
      kind: "unlabelled",
      caseKey: "",
      text: `${methodName(method)}: ${missing.length} of ${answered.length} answered rows ${has} no reviewed label, ${rate}`,
      lines: missing.map((r) => r.line),
    });
  }

  // Paired labelled cases per cohort (run, prompt version, question), from src/core/metrics.ts itself: it applies
  // truthLabel and refuses a repeated (case, method) row by name.
  const groups = groupCohorts(parsed);
  const pairs: ReplayPair[] = [];
  const questions: ReplayQuestion[] = [];
  const fileArms = armsInFile(parsed);
  const multiCohort = groups.length > 1;
  const questionsUnique = new Set(groups.map((g) => g.key.questionId)).size === groups.length;
  for (const group of groups) {
    const { runId, promptVersion, questionId } = group.key;
    const metrics = metricsOfCohortRows(group.rows, group.key);
    const mine: ReplayPair[] = [];
    if (metrics.jevVsLlm !== null) mine.push({ runId, promptVersion, questionId, other: "llm", n: metrics.jevVsLlm.n });
    if (metrics.jevVsRule !== null) mine.push({ runId, promptVersion, questionId, other: "rule", n: metrics.jevVsRule.n });
    pairs.push(...mine);
    questions.push({ runId, promptVersion, questionId, question: metrics.question, limitations: verdictLimitations(metrics, fileArms) });
    if (!mine.some((p) => p.n < MIN_PAIRED)) continue;
    const fewest = Math.min(...mine.map((p) => p.n));
    const detail = mine.map((p) => `Jev against ${p.other === "llm" ? "the LLM" : "the rule"} ${p.n}`).join(", ");
    const name = questionsUnique ? questionId : `${runId} ${promptVersion} ${questionId}`;
    const lines = new Set(group.rows);
    flags.push({
      id: `${source.key}-below-minimum${multiCohort ? `-${name.replaceAll(" ", "-")}` : ""}`,
      method: "all",
      kind: "below-minimum",
      caseKey: "",
      text: `${multiCohort ? `Question ${name}: ` : ""}${fewest} paired labelled cases (${detail}); a verdict needs ${MIN_PAIRED}, so do not pick a method from this run yet`,
      lines: parsed.filter((p) => lines.has(p.values)).map((p) => p.line),
    });
  }

  const sources = [...new Set(rows.filter((r) => r.label !== "").map((r) => [r.labelSource, r.labelledBy].filter((s) => s !== "").join(" by ")))];
  const out: ReplayRow[] = rows.map((r) => ({
    line: r.line, caseKey: r.caseKey, answerer: r.answerer, model: r.model, input: r.input, output: r.output,
    label: r.label, truth: r.truth, labelNote: r.labelNote, outcome: r.outcome, answered: r.answered, costUsd: r.costUsd, costText: r.costText,
    ...(r.generated === true ? { generated: true as const } : {}),
  }));
  const base = { cases, methods, rows: out };
  const { key, title, file, synthetic } = source;
  return {
    key,
    runId: [...new Set(records.map((r) => col(r, "run_id")))].join(", "),
    title,
    file,
    synthetic,
    labelSource: sources.length === 0 ? "no labels recorded" : sources.join(", "),
    ...base,
    stats,
    flags,
    pairs,
    questions,
    provenance: provenanceByMethod(parsed),
    steps: cases.map((_, i) => tallyThrough(base, i)),
    ...(source.pageBy === undefined ? {} : { pageBy: source.pageBy }),
    ...(source.spotlight === undefined ? {} : { spotlight: source.spotlight }),
  };
}
