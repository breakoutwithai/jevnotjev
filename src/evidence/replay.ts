// D14 replay view: one recorded run as cases you can step through, the tally after each case, each method's
// recorded totals, and a flag for every method whose evidence is incomplete (a missing row, a missing cost,
// unlabelled answers, or fewer paired labelled cases than a verdict needs). Pure functions over a records CSV;
// scripts/replay-data.ts writes their output for site/replay/.

import { readDictRows, type CsvRecord } from "../format/csv.ts";
import { MIN_PAIRED } from "../core/verdict.ts";

/** The methods the site compares, in the order the site shows them (site/little-shop, site/index.html). */
export const COMPARED: readonly string[] = ["llm", "rule", "jev"];
/** The site's names for the three methods (site/uc13-demo.js, site/index.html). */
export const METHOD_NAMES: Readonly<Record<string, string>> = { llm: "What you do now", rule: "A simple rule", jev: "Jev decides" };

export interface RunSource {
  readonly key: string;
  /** Repo-relative path of the records file. */
  readonly file: string;
  readonly title: string;
  readonly synthetic: boolean;
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
  readonly outcome: string;
  readonly answered: boolean;
  readonly costUsd: number | null;
  readonly costText: string;
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
  /** steps[i] is the tally after cases 0..i. */
  readonly steps: readonly (readonly StepTally[])[];
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
    return { method, accepted: rows.filter((r) => r.label === "accept").length, played: rows.length, missing: seen.size - covered };
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
  const rows: Parsed[] = records.map((record) => {
    const outcome = col(record, "outcome");
    const caseId = col(record, "case_id");
    const questionId = col(record, "question_id");
    const costUsd = num(col(record, "cost_usd"));
    return {
      line: record.line,
      caseId,
      questionId,
      caseKey: multiQuestion ? `${caseId}-${questionId}` : caseId,
      input: col(record, "case_input"),
      question: col(record, "question"),
      answerer: col(record, "answerer"),
      model: col(record, "answerer_model"),
      output: col(record, "output"),
      label: col(record, "label"),
      labelSource: col(record, "label_source"),
      labelledBy: col(record, "labelled_by"),
      outcome: outcome === "" ? "answered" : outcome,
      answered: outcome === "" || outcome === "answered",
      costUsd,
      costText: usd(costUsd),
    };
  });

  const present = [...new Set(rows.map((r) => r.answerer))];
  const methods = [...COMPARED.filter((m) => present.includes(m)), ...present.filter((m) => !COMPARED.includes(m)).sort()];

  const cases: ReplayCase[] = [];
  for (const row of rows) {
    if (!cases.some((c) => c.key === row.caseKey)) cases.push({ key: row.caseKey, question: row.question, input: row.input });
  }

  const stats: MethodStats[] = methods.map((method) => {
    const mine = rows.filter((r) => r.answerer === method);
    const costed = mine.filter((r) => r.costUsd !== null);
    const cost = costed.length === mine.length ? costed.reduce((sum, r) => sum + (r.costUsd ?? 0), 0) : null;
    return {
      method,
      name: methodName(method),
      model: [...new Set(mine.map((r) => r.model))].join(" + "),
      rows: mine.length,
      answered: mine.filter((r) => r.answered).length,
      labelled: mine.filter((r) => r.label !== "").length,
      accept: mine.filter((r) => r.label === "accept").length,
      reject: mine.filter((r) => r.label === "reject").length,
      unlabelled: mine.filter((r) => r.answered && r.label === "").length,
      costed: costed.length,
      cost,
      costText: usd(cost),
      lines: mine.map((r) => r.line),
    };
  });

  const flags: Flag[] = [];
  for (const c of cases) {
    for (const method of COMPARED.filter((m) => methods.includes(m))) {
      if (rows.some((r) => r.caseKey === c.key && r.answerer === method)) continue;
      flags.push({
        id: `${source.key}-${method}-missing-${c.key}`,
        method,
        kind: "missing",
        caseKey: c.key,
        text: `${methodName(method)} has no row for case ${c.key}, so its count covers ${cases.length - 1} of ${cases.length} cases`,
        lines: rows.filter((r) => r.caseKey === c.key).map((r) => r.line),
      });
    }
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
  const unlabelled = rows.filter((r) => r.answered && r.label === "");
  if (unlabelled.length > 0) {
    const answered = rows.filter((r) => r.answered).length;
    flags.push({
      id: `${source.key}-unlabelled`,
      method: "all",
      kind: "unlabelled",
      caseKey: "",
      text: `${answered - unlabelled.length} of ${answered} answered rows labelled, so no method has an accept rate`,
      lines: unlabelled.map((r) => r.line),
    });
  }

  // Paired labelled cases per question, counted as src/core/metrics.ts paired() does: Jev against the other method on
  // the same case, both rows labelled, and an `agent` label (never reviewed) is not truth.
  const truth = (r: Parsed | undefined): boolean => r !== undefined && r.label !== "" && r.labelSource !== "agent";
  for (const q of [...new Set(rows.map((r) => r.questionId))]) {
    const mine = rows.filter((r) => r.questionId === q);
    const jevRows = mine.filter((r) => r.answerer === "jev");
    const pairs: { other: string; n: number }[] = [];
    for (const other of ["llm", "rule"]) {
      const otherRows = mine.filter((r) => r.answerer === other);
      if (jevRows.length === 0 || otherRows.length === 0) continue;
      pairs.push({ other, n: jevRows.filter((j) => truth(j) && truth(otherRows.find((o) => o.caseId === j.caseId))).length });
    }
    if (!pairs.some((p) => p.n < MIN_PAIRED)) continue;
    const fewest = Math.min(...pairs.map((p) => p.n));
    const detail = pairs.map((p) => `Jev against ${p.other === "llm" ? "the LLM" : "the rule"} ${p.n}`).join(", ");
    flags.push({
      id: `${source.key}-below-minimum${multiQuestion ? `-${q}` : ""}`,
      method: "all",
      kind: "below-minimum",
      caseKey: "",
      text: `${multiQuestion ? `Question ${q}: ` : ""}${fewest} paired labelled cases (${detail}); a verdict needs ${MIN_PAIRED}`,
      lines: mine.map((r) => r.line),
    });
  }

  const sources = [...new Set(rows.filter((r) => r.label !== "").map((r) => [r.labelSource, r.labelledBy].filter((s) => s !== "").join(" by ")))];
  const out: ReplayRow[] = rows.map((r) => ({
    line: r.line, caseKey: r.caseKey, answerer: r.answerer, model: r.model, input: r.input, output: r.output,
    label: r.label, outcome: r.outcome, answered: r.answered, costUsd: r.costUsd, costText: r.costText,
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
    steps: cases.map((_, i) => tallyThrough(base, i)),
  };
}
