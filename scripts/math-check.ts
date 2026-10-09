// D15: an independent check of the verdict figures against the app, for any jnj-record CSV.
// The hand side is written from docs/decision/verdict-rules.md alone and imports only Node built-ins,
// never the product code (a test reads this file's own source and asserts that). The app side is the
// stdout of the verdict command, run as a separate process, so the two sides share no code.
//
// Run: bun scripts/math-check.ts <records.csv> [--last N] [--json] [--app-json <verdict.json>]
//   --last N      check only the last N distinct case_id values, in order of first appearance in the file
//   --json        print {source, n, selection_rule, compared, mismatches, excluded, figures[]}
//   --app-json F  read the app's verdict JSON from F instead of running the verdict command (planted-fault tests)
// Exit: 0 compared >= 1 and no mismatch; 1 any mismatch; 2 bad input; 3 zero figures compared.
// Spends 0: the verdict command reads recorded rows only.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimum paired labelled cases, verdict-rules.md rule 1. */
const MIN_PAIRED = 30;
/** Accept-rate margin, verdict-rules.md rules 2 and 3. */
const MARGIN = 0.1;
/** Cost ratio that counts as cheaper, verdict-rules.md rule 3. */
const CHEAPER = 0.8;
/** verdict-rules.md "Cost guards and tolerance": every comparison with 0.8 or 1 allows 1e-9. */
const COST_TOLERANCE = 1e-9;
/** verdict-rules.md "Cost ratio interval": 2,000 resamples. */
const RESAMPLES = 2000;
/** Two-sided 95%: the 0.975 quantile of the standard normal distribution. */
const Z = 1.959963984540054;
/** Tolerances (coverage.md): absolute for counts and rates, relative for money and ratios. */
export const ABS_TOLERANCE = 1e-9;
export const REL_TOLERANCE = 1e-9;

export const EXIT_CODES = { ok: 0, mismatch: 1, badInput: 2, nothingCompared: 3 } satisfies Record<string, number>;

export class BadInput extends Error {}

// ---------------------------------------------------------------------------------------------
// CSV

/** RFC 4180 CSV: a quote opens a field only at its start, `""` is a quote inside a quoted field. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else field += ch;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      closed = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      closed = false;
    } else if (closed) throw new BadInput(`CSV: text after a closing quote at offset ${i}`);
    else if (ch === '"') {
      if (field !== "") throw new BadInput(`CSV: quote inside an unquoted field at offset ${i}`);
      quoted = true;
    } else field += ch;
  }
  if (quoted) throw new BadInput("CSV: unterminated quote");
  if (field !== "" || closed || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + "\n";
}

/** One row reduced to what the calculation reads. */
export type HandRow = {
  readonly runId: string;
  readonly promptVersion: string;
  readonly caseId: string;
  readonly questionId: string;
  readonly answerer: string;
  /** "accept", "reject", or "" when unlabelled or labelled by an unreviewed agent. */
  readonly label: string;
  /** null when cost_usd is blank. */
  readonly cost: number | null;
};

function columnsOf(header: readonly string[]): (name: string) => number {
  return (name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new BadInput(`records file has no ${name} column`);
    return index;
  };
}

export function loadRows(text: string): HandRow[] {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  if (header === undefined || body.length === 0) throw new BadInput("records file has no data rows");
  const col = columnsOf(header);
  const at = { run: col("run_id"), pv: col("prompt_version"), id: col("case_id"), q: col("question_id"), who: col("answerer"), label: col("label"), source: col("label_source"), cost: col("cost_usd") };
  return body.map((cells, i) => {
    const cell = (index: number): string => {
      const value = cells[index];
      if (value === undefined) throw new BadInput(`records line ${i + 2} is short`);
      return value;
    };
    const costText = cell(at.cost).trim();
    const cost = costText === "" ? null : Number(costText);
    if (cost !== null && !Number.isFinite(cost)) throw new BadInput(`records line ${i + 2}: cost_usd ${costText} is not a number`);
    // format/README.md "Missing cost or labels": an agent label was never reviewed, so it counts as unlabelled.
    const label = cell(at.source) === "agent" ? "" : cell(at.label);
    return { runId: cell(at.run), promptVersion: cell(at.pv), caseId: cell(at.id), questionId: cell(at.q), answerer: cell(at.who), label, cost };
  });
}

// ---------------------------------------------------------------------------------------------
// Selection: the last N cases

export type Selection = { readonly text: string; readonly n: number; readonly rule: string; readonly cases: readonly string[] };

/** Distinct case_id values in order of first appearance. */
export function caseOrder(text: string): string[] {
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  if (header === undefined) throw new BadInput("records file is empty");
  const id = columnsOf(header)("case_id");
  return [...new Set(body.map((cells) => cells[id] ?? ""))];
}

/** The whole file, or the rows of the last N distinct case_id values (fewer than N cases is bad input, never a shorter slice). */
export function selectLast(text: string, last: number | null): Selection {
  const order = caseOrder(text);
  if (last === null) return { text, n: order.length, rule: `whole file: all ${order.length} distinct case_id values`, cases: order };
  if (order.length < last) throw new BadInput(`fewer than ${last} cases: the file has ${order.length} distinct case_id values`);
  const keep = new Set(order.slice(order.length - last));
  const [header, ...body] = parseCsv(text.replace(/^﻿/, ""));
  if (header === undefined) throw new BadInput("records file is empty");
  const id = columnsOf(header)("case_id");
  const rows = body.filter((cells) => keep.has(cells[id] ?? ""));
  return {
    text: toCsv([header, ...rows]),
    n: last,
    rule: `last ${last} distinct case_id values in order of first appearance (of ${order.length}); every row of those cases kept`,
    cases: order.slice(order.length - last),
  };
}

// ---------------------------------------------------------------------------------------------
// The hand calculation, from verdict-rules.md

/** How a figure is compared: absolute for counts and rates, relative for money and ratios, exact for states. */
export type Tolerance = "abs" | "rel" | "exact" | "within-bounds";

export type HandFigure = {
  /** `<question>:<path in that question's verdict object>`, e.g. `q1:numbers.jevVsLlm.a`. */
  readonly key: string;
  readonly value: number | string;
  readonly tolerance: Tolerance;
  /** "figure" counts toward `compared`; "state" (verdict, rule, condition, kinds) is checked but not counted. */
  readonly group: "figure" | "state";
};

export type Excluded = { readonly key: string; readonly reason: string; readonly hand: number | null };

export type Cohort = { readonly prefix: string; readonly runId: string; readonly promptVersion: string; readonly questionId: string; readonly rows: readonly HandRow[] };

type Side = { readonly accepted: number; readonly spend: number; readonly missing: number; readonly n: number };
type Paired = {
  readonly ids: readonly string[];
  readonly excluded: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly jev: Side;
  readonly other: Side;
  readonly costs: ReadonlyMap<string, readonly [number | null, number | null]>;
};

export type Wilson = { readonly lower: number; readonly upper: number };

/** Wilson 95% score interval for x of n. */
export function wilson(x: number, n: number): Wilson {
  const p = x / n;
  const z2 = Z * Z;
  const centre = p + z2 / (2 * n);
  const half = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const den = 1 + z2 / n;
  return { lower: x === 0 ? 0 : (centre - half) / den, upper: x === n ? 1 : (centre + half) / den };
}

/** phi of the 2x2 table with a*d - b*c reduced by n/2 (not below 0) when positive; 0 when the root is 0. */
export function phi(a: number, b: number, c: number, d: number): number {
  const n = a + b + c + d;
  const root = Math.sqrt((a + b) * (c + d) * (a + c) * (b + d));
  if (root === 0) return 0;
  const raw = a * d - b * c;
  return (raw > 0 ? Math.max(raw - n / 2, 0) : raw) / root;
}

export type Newcombe = { readonly p1: number; readonly p2: number; readonly diff: number; readonly lower: number; readonly upper: number; readonly w1: Wilson; readonly w2: Wilson; readonly phi: number };

/** Newcombe 1998 method 10 for p1 - p2 on paired cases. */
export function newcombe(a: number, b: number, c: number, d: number): Newcombe {
  const n = a + b + c + d;
  const p1 = (a + b) / n;
  const p2 = (a + c) / n;
  const w1 = wilson(a + b, n);
  const w2 = wilson(a + c, n);
  const r = phi(a, b, c, d);
  const dl1 = p1 - w1.lower;
  const du1 = w1.upper - p1;
  const dl2 = p2 - w2.lower;
  const du2 = w2.upper - p2;
  const diff = p1 - p2;
  return {
    p1, p2, diff, w1, w2, phi: r,
    lower: diff - Math.sqrt(Math.max(dl1 * dl1 - 2 * r * dl1 * du2 + du2 * du2, 0)),
    upper: diff + Math.sqrt(Math.max(du1 * du1 - 2 * r * du1 * dl2 + dl2 * dl2, 0)),
  };
}

function sideOf(rows: readonly HandRow[]): Side {
  let accepted = 0;
  let spend = 0;
  let missing = 0;
  for (const row of rows) {
    if (row.label === "accept") accepted += 1;
    if (row.cost === null) missing += 1;
    else spend += row.cost;
  }
  return { accepted, spend, missing, n: rows.length };
}

function byCase(rows: readonly HandRow[], answerer: string): Map<string, HandRow> {
  const out = new Map<string, HandRow>();
  for (const row of rows) {
    if (row.answerer !== answerer) continue;
    if (out.has(row.caseId)) throw new BadInput(`two ${answerer} rows for case ${row.caseId} question ${row.questionId}`);
    out.set(row.caseId, row);
  }
  return out;
}

/** Jev against another answerer: a case is paired when both have a labelled row for it. */
function pairUp(rows: readonly HandRow[], other: string): Paired {
  const jev = byCase(rows, "jev");
  const oth = byCase(rows, other);
  const ids = [...new Set([...jev.keys(), ...oth.keys()])].sort();
  const pairedIds: string[] = [];
  const jevRows: HandRow[] = [];
  const otherRows: HandRow[] = [];
  const costs = new Map<string, readonly [number | null, number | null]>();
  let excluded = 0;
  const cells = { a: 0, b: 0, c: 0, d: 0 };
  for (const id of ids) {
    const j = jev.get(id);
    const o = oth.get(id);
    if (j === undefined || o === undefined || j.label === "" || o.label === "") {
      excluded += 1;
      continue;
    }
    pairedIds.push(id);
    jevRows.push(j);
    otherRows.push(o);
    costs.set(id, [j.cost, o.cost]);
    const ja = j.label === "accept";
    const oa = o.label === "accept";
    if (ja && oa) cells.a += 1;
    else if (ja) cells.b += 1;
    else if (oa) cells.c += 1;
    else cells.d += 1;
  }
  return { ids: pairedIds, excluded, ...cells, jev: sideOf(jevRows), other: sideOf(otherRows), costs };
}

export function cohortsOf(rows: readonly HandRow[]): Cohort[] {
  const groups = new Map<string, { runId: string; promptVersion: string; questionId: string; rows: HandRow[] }>();
  for (const row of rows) {
    const id = JSON.stringify([row.runId, row.promptVersion, row.questionId]);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, { runId: row.runId, promptVersion: row.promptVersion, questionId: row.questionId, rows: [row] });
    else group.rows.push(row);
  }
  const list = [...groups.values()];
  const single = new Set(list.map((g) => `${g.runId}\u0000${g.promptVersion}`)).size === 1;
  return list.map((g) => ({ ...g, prefix: single ? g.questionId : `${g.runId}/${g.promptVersion}/${g.questionId}` }));
}

/** The app's bootstrap bounds for a cohort, which this check cannot recompute (seed not in stdout, #168). */
export type BootstrapBounds = { readonly lower: number; readonly upper: number } | null;

export type HandCohort = { readonly figures: HandFigure[]; readonly excluded: Excluded[]; readonly verdict: string };

/**
 * Every figure of one cohort that verdict-rules.md defines, keyed by the verdict JSON path.
 * `bootstrap` is the app's cost-ratio interval, read only to decide rules 2 (clearly dearer) to 4.
 */
export function handCohort(cohort: Cohort, bootstrap: (prefix: string) => BootstrapBounds): HandCohort {
  const figures: HandFigure[] = [];
  const excluded: Excluded[] = [];
  const p = cohort.prefix;
  const fig = (path: string, value: number | string, tolerance: Tolerance): void => {
    figures.push({ key: `${p}:${path}`, value, tolerance, group: typeof value === "string" ? "state" : "figure" });
  };
  const exclude = (path: string, reason: string, hand: number | null): void => {
    excluded.push({ key: `${p}:${path}`, reason, hand });
  };
  const rows = cohort.rows;
  const has = (who: string): boolean => rows.some((r) => r.answerer === who);
  const hasJev = has("jev");
  const hasLlm = has("llm");
  const hasRule = has("rule");

  // Jev against the LLM.
  const pair = hasJev && hasLlm ? pairUp(rows, "llm") : null;
  const n = pair?.ids.length ?? 0;
  let nc: Newcombe | null = null;
  if (pair !== null && n > 0) {
    const base = "numbers.jevVsLlm";
    nc = newcombe(pair.a, pair.b, pair.c, pair.d);
    fig(`${base}.n`, n, "abs");
    fig(`${base}.excluded`, pair.excluded, "abs");
    const sides: ReadonlyArray<readonly [string, Side]> = [["jev", pair.jev], ["otherArm", pair.other]];
    for (const [side, s] of sides) {
      fig(`${base}.${side}.accepted`, s.accepted, "abs");
      fig(`${base}.${side}.acceptRate`, s.accepted / n, "abs");
      if (s.missing > 0) {
        fig(`${base}.${side}.spend.kind`, "incomplete", "exact");
        fig(`${base}.${side}.spend.knownUsd`, s.spend, "rel");
        fig(`${base}.${side}.spend.missing`, s.missing, "abs");
        fig(`${base}.${side}.costPerAccepted.kind`, "incomplete", "exact");
      } else {
        fig(`${base}.${side}.spend.kind`, "complete", "exact");
        fig(`${base}.${side}.spend.usd`, s.spend, "rel");
        if (s.accepted === 0) fig(`${base}.${side}.costPerAccepted.kind`, "undefined", "exact");
        else {
          fig(`${base}.${side}.costPerAccepted.kind`, "value", "exact");
          fig(`${base}.${side}.costPerAccepted.usd`, s.spend / s.accepted, "rel");
        }
      }
    }
    fig(`${base}.a`, pair.a, "abs");
    fig(`${base}.b`, pair.b, "abs");
    fig(`${base}.c`, pair.c, "abs");
    fig(`${base}.d`, pair.d, "abs");
    fig(`${base}.wins`, pair.b, "abs");
    fig(`${base}.losses`, pair.c, "abs");
    fig(`${base}.ties`, pair.a + pair.d, "abs");
    for (const [id, [jc, oc]] of pair.costs) {
      if (jc !== null) fig(`${base}.cases[${id}].jevCostUsd`, jc, "rel");
      if (oc !== null) fig(`${base}.cases[${id}].otherCostUsd`, oc, "rel");
    }
    fig(`${base}.p1`, nc.p1, "abs");
    fig(`${base}.p2`, nc.p2, "abs");
    fig(`${base}.diff`, nc.diff, "abs");
    fig(`${base}.lower`, nc.lower, "abs");
    fig(`${base}.upper`, nc.upper, "abs");
    fig("numbers.jevAccepted", pair.jev.accepted, "abs");
    fig("numbers.llmAccepted", pair.other.accepted, "abs");
    const why = "app does not expose it (#168); lower and upper, which are built from it, are compared";
    exclude(`${base}.wilson1.lower`, why, nc.w1.lower);
    exclude(`${base}.wilson1.upper`, why, nc.w1.upper);
    exclude(`${base}.wilson2.lower`, why, nc.w2.lower);
    exclude(`${base}.wilson2.upper`, why, nc.w2.upper);
    exclude(`${base}.phi`, why, nc.phi);
  }

  // The rule against Jev, rule minus Jev, compared on 30 or more paired cases.
  let ruleLower: number | null = null;
  if (hasRule && hasJev) {
    const rp = pairUp(rows, "rule");
    const rn = rp.ids.length;
    if (rn < MIN_PAIRED) {
      fig("ruleComparison.kind", "skipped", "exact");
      fig("ruleComparison.paired", rn, "abs");
    } else {
      // Rule first: rule-only is b, Jev-only is c.
      const r = newcombe(rp.a, rp.c, rp.b, rp.d);
      ruleLower = r.lower;
      fig("ruleComparison.kind", "compared", "exact");
      fig("ruleComparison.n", rn, "abs");
      fig("ruleComparison.a", rp.a, "abs");
      fig("ruleComparison.b", rp.c, "abs");
      fig("ruleComparison.c", rp.b, "abs");
      fig("ruleComparison.d", rp.d, "abs");
      fig("ruleComparison.p1", r.p1, "abs");
      fig("ruleComparison.p2", r.p2, "abs");
      fig("ruleComparison.diff", r.diff, "abs");
      fig("ruleComparison.lower", r.lower, "abs");
      fig("ruleComparison.upper", r.upper, "abs");
      const why = "app does not expose it (#168); lower and upper are compared";
      exclude("ruleComparison.wilson1.lower", why, r.w1.lower);
      exclude("ruleComparison.wilson1.upper", why, r.w1.upper);
      exclude("ruleComparison.wilson2.lower", why, r.w2.lower);
      exclude("ruleComparison.wilson2.upper", why, r.w2.upper);
      exclude("ruleComparison.phi", why, r.phi);
    }
  } else fig("ruleComparison.kind", "skipped", "exact");

  // The verdict, first match wins.
  const decide = (verdict: string, rule: number, condition: string, unmet: readonly string[] = []): string => {
    fig("verdict", verdict, "exact");
    fig("rule", String(rule), "exact");
    fig("condition", condition, "exact");
    fig("unmet", unmet.join(","), "exact");
    return verdict;
  };
  const nee = "not enough evidence";
  const dont = "don't use Jev";
  if (!hasJev) return { figures, excluded, verdict: decide(nee, 1, "no-jev-rows") };
  if (!hasLlm) return { figures, excluded, verdict: decide(nee, 1, "no-llm-rows") };
  if (pair === null || nc === null || n < MIN_PAIRED) {
    fig("addN", MIN_PAIRED - n, "abs");
    return { figures, excluded, verdict: decide(nee, 1, "too-few-paired") };
  }
  if (pair.jev.accepted === 0 && pair.other.accepted === 0) return { figures, excluded, verdict: decide(nee, 1, "both-zero-accepted") };
  if (pair.jev.missing > 0 || pair.other.missing > 0) return { figures, excluded, verdict: decide(nee, 1, "cost-missing") };
  if (ruleLower !== null && ruleLower > -MARGIN) return { figures, excluded, verdict: decide(dont, 2, "rule-within-margin") };
  if (nc.upper < -MARGIN) return { figures, excluded, verdict: decide(dont, 2, "jev-clearly-worse") };
  if (pair.jev.accepted === 0) return { figures, excluded, verdict: decide(dont, 2, "jev-zero-accepted") };
  const jevSpend = pair.jev.spend;
  const llmSpend = pair.other.spend;
  let largest = 0;
  for (const [jc, oc] of pair.costs.values()) largest = Math.max(largest, jc ?? 0, oc ?? 0);
  if (!Number.isFinite(jevSpend) || !Number.isFinite(llmSpend) || !Number.isFinite(largest * n)) {
    return { figures, excluded, verdict: decide(nee, 1, "cost-not-finite") };
  }
  // cost_ratio: 0 when the LLM has 0 accepted, else cost per accepted of Jev over the LLM's.
  const jevPer = jevSpend / pair.jev.accepted;
  const llmPer = pair.other.accepted === 0 ? Number.NaN : llmSpend / pair.other.accepted;
  let ratio: number | null;
  if (pair.other.accepted === 0) ratio = 0;
  else if (jevPer === 0 && llmPer === 0) ratio = null;
  else if (llmPer === 0) ratio = Number.POSITIVE_INFINITY;
  else ratio = Number.isFinite(jevPer / llmPer) ? jevPer / llmPer : null;
  if (ratio === null) {
    return { figures, excluded, verdict: decide(nee, 1, jevSpend === 0 && llmSpend === 0 ? "no-cost-ratio" : "cost-not-finite") };
  }
  fig("numbers.costRatio.ratio", ratio, "rel");
  fig("numbers.costRatio.resamples", RESAMPLES, "abs");
  exclude("numbers.costRatio.redrawn", "seeded resampling; the seed is not in verdict output until #168", null);
  const ci = bootstrap(p);
  if (ci === null) {
    // No interval from the app: the bounds are reported missing below, and rules 2 to 4 cannot be decided.
    fig("numbers.costRatio.lower", ratio, "within-bounds");
    fig("numbers.costRatio.upper", ratio, "within-bounds");
    return { figures, excluded, verdict: decide("(needs the app's cost-ratio interval)", 0, "(unknown)") };
  }
  // Partial: the point ratio must lie inside the app's interval; the bounds themselves are not recomputed.
  fig("numbers.costRatio.lower", ratio, "within-bounds");
  fig("numbers.costRatio.upper", ratio, "within-bounds");
  if (ci.lower > 1 + COST_TOLERANCE) return { figures, excluded, verdict: decide(dont, 2, "jev-clearly-dearer") };
  const unmet: string[] = [];
  if (!(nc.lower > -MARGIN)) unmet.push("accept-rate-not-shown");
  if (ratio > CHEAPER + COST_TOLERANCE) unmet.push(ratio < 1 - COST_TOLERANCE ? "cheaper-by-less-than-20" : "not-cheaper");
  if (!(ci.upper < 1 - COST_TOLERANCE)) unmet.push("cost-upper-bound-not-below-1");
  const [first] = unmet;
  if (first === undefined) return { figures, excluded, verdict: decide("use Jev", 3, "use-jev") };
  return { figures, excluded, verdict: decide(nee, 4, first, unmet) };
}

// ---------------------------------------------------------------------------------------------
// The app side: verdict JSON

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The verdict objects of the app's JSON, keyed the same way as the hand cohorts. */
export function appVerdicts(json: unknown): Map<string, Record<string, unknown>> {
  if (!isRecord(json) || !Array.isArray(json.verdicts)) throw new BadInput("app output has no verdicts array");
  const list = json.verdicts.filter(isRecord);
  const single = new Set(list.map((v) => `${String(v.run_id)}\u0000${String(v.prompt_version)}`)).size === 1;
  const out = new Map<string, Record<string, unknown>>();
  for (const v of list) {
    const key = single ? String(v.question_id) : `${String(v.run_id)}/${String(v.prompt_version)}/${String(v.question_id)}`;
    out.set(key, v);
  }
  return out;
}

/** Walk `a.b.cases[c07].x` through a verdict object; an array segment `[id]` picks the element whose caseId is id. */
export function resolvePath(root: unknown, path: string): unknown {
  let here: unknown = root;
  for (const segment of path.split(".")) {
    const m = /^([^[\]]+)(?:\[([^\]]+)\])?$/.exec(segment);
    if (m === null || !isRecord(here)) return undefined;
    here = here[m[1] ?? ""];
    const id = m[2];
    if (id !== undefined) {
      if (!Array.isArray(here)) return undefined;
      here = here.find((item) => isRecord(item) && item.caseId === id);
    }
  }
  return here;
}

function bootstrapOf(verdict: Record<string, unknown> | undefined): BootstrapBounds {
  if (verdict === undefined) return null;
  const lower = resolvePath(verdict, "numbers.costRatio.lower");
  const upper = resolvePath(verdict, "numbers.costRatio.upper");
  return typeof lower === "number" && typeof upper === "number" ? { lower, upper } : null;
}

/** Every numeric leaf of a JSON value, arrays written `[]`: the coverage table's row keys. */
export function numericLeaves(value: unknown, path = ""): string[] {
  if (typeof value === "number") return [path];
  if (Array.isArray(value)) return [...new Set(value.flatMap((item) => numericLeaves(item, `${path}[]`)))];
  if (!isRecord(value)) return [];
  return [...new Set(Object.entries(value).flatMap(([k, v]) => numericLeaves(v, path === "" ? k : `${path}.${k}`)))];
}

// ---------------------------------------------------------------------------------------------
// Comparison

export type FigureResult = {
  readonly key: string;
  readonly group: "figure" | "state";
  readonly hand: number | string;
  readonly app: unknown;
  readonly tolerance: string;
  readonly ok: boolean;
  readonly note: string;
};

export type Report = {
  readonly source: string;
  readonly n: number;
  readonly selection_rule: string;
  readonly compared: number;
  readonly states_compared: number;
  readonly mismatches: number;
  readonly excluded: readonly Excluded[];
  readonly figures: readonly FigureResult[];
};

function toleranceText(t: Tolerance): string {
  if (t === "abs") return `abs ${ABS_TOLERANCE}`;
  if (t === "rel") return `rel ${REL_TOLERANCE}`;
  if (t === "within-bounds") return `hand ratio inside app interval, rel ${REL_TOLERANCE}`;
  return "exact";
}

function compareOne(f: HandFigure, verdict: Record<string, unknown> | undefined): FigureResult {
  const colon = f.key.indexOf(":");
  const path = f.key.slice(colon + 1);
  const app = verdict === undefined ? undefined : resolvePath(verdict, path);
  const base = { key: f.key, group: f.group, hand: f.value, app: app === undefined ? null : app, tolerance: toleranceText(f.tolerance) };
  if (verdict === undefined) return { ...base, ok: false, note: "the app has no verdict for this question" };
  if (typeof f.value === "string") {
    const appText = typeof app === "number" ? String(app) : Array.isArray(app) ? app.join(",") : app;
    return { ...base, ok: appText === f.value, note: appText === f.value ? "" : "differs" };
  }
  if (typeof app !== "number" || !Number.isFinite(app)) return { ...base, ok: false, note: app === undefined || app === null || app === "" ? "app value blank or missing" : "app value is not a finite number" };
  const hand = f.value;
  if (f.tolerance === "within-bounds") {
    const slack = REL_TOLERANCE * Math.abs(hand);
    const ok = path.endsWith(".lower") ? app <= hand + slack : app >= hand - slack;
    return { ...base, ok, note: ok ? "" : `hand ratio ${hand} outside the app's interval` };
  }
  const gap = Math.abs(hand - app);
  const ok = f.tolerance === "abs" ? gap <= ABS_TOLERANCE : gap <= REL_TOLERANCE * Math.max(Math.abs(hand), Math.abs(app));
  return { ...base, ok, note: ok ? "" : `differs by ${gap}` };
}

/** The hand figures of every cohort in `text`, compared with the app's verdict JSON. */
export function compareWithApp(text: string, appJson: unknown, source: string, selection: Selection): Report {
  const verdicts = appVerdicts(appJson);
  const figures: FigureResult[] = [];
  const excluded: Excluded[] = [];
  const cohorts = cohortsOf(loadRows(text));
  const hands = cohorts.map((cohort) => {
    const hand = handCohort(cohort, (prefix) => bootstrapOf(verdicts.get(prefix)));
    excluded.push(...hand.excluded);
    for (const f of hand.figures) figures.push(compareOne(f, verdicts.get(cohort.prefix)));
    return hand.verdict;
  });
  // Top-level exit code, docs/api.md "Exit codes": 3 when any is don't use Jev, else 4 when any is not enough evidence, else 0.
  const exit = hands.includes("don't use Jev") ? 3 : hands.includes("not enough evidence") ? 4 : 0;
  const appExit = isRecord(appJson) ? appJson.exit_code : undefined;
  figures.push({ key: "exit_code", group: "state", hand: String(exit), app: appExit ?? null, tolerance: "exact", ok: appExit === exit, note: appExit === exit ? "" : "differs" });
  for (const key of verdicts.keys()) {
    if (!cohorts.some((c) => c.prefix === key)) {
      figures.push({ key: `${key}:verdict`, group: "state", hand: "(no such question in the records)", app: key, tolerance: "exact", ok: false, note: "the app has a question the records do not" });
    }
  }
  return {
    source,
    n: selection.n,
    selection_rule: selection.rule,
    compared: figures.filter((f) => f.group === "figure").length,
    states_compared: figures.filter((f) => f.group === "state").length,
    mismatches: figures.filter((f) => !f.ok).length,
    excluded,
    figures,
  };
}

export function exitCodeOf(report: Report): number {
  if (report.mismatches > 0) return EXIT_CODES.mismatch;
  if (report.compared === 0) return EXIT_CODES.nothingCompared;
  return EXIT_CODES.ok;
}

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The app's verdict JSON for a records file, from the verdict command's stdout (exit 0, 3 or 4). */
export function runApp(file: string): unknown {
  const cli = join(ROOT, "src", "decide", "cli.ts");
  // Only PATH and HOME are passed on: the verdict command needs no key and must not see one.
  const res = spawnSync(process.execPath, [cli, "verdict", file], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
  if (res.status === null || ![0, 3, 4].includes(res.status)) {
    throw new BadInput(`verdict command exited ${String(res.status)}: ${(res.stderr || res.stdout).trim().split("\n").slice(0, 5).join(" | ")}`);
  }
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    return parsed;
  } catch {
    throw new BadInput("verdict command printed no JSON");
  }
}

// ---------------------------------------------------------------------------------------------
// Command line

export type Args = { readonly file: string; readonly last: number | null; readonly json: boolean; readonly appJson: string | null };

export function parseArgs(argv: readonly string[]): Args {
  let file: string | null = null;
  let last: number | null = null;
  let json = false;
  let appJson: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";
    if (a === "--json") json = true;
    else if (a === "--last") {
      const v = argv[i + 1] ?? "";
      if (!/^[1-9]\d*$/.test(v)) throw new BadInput(`--last needs a whole number of cases above 0, got "${v}"`);
      last = Number(v);
      i += 1;
    } else if (a === "--app-json") {
      const v = argv[i + 1];
      if (v === undefined) throw new BadInput("--app-json needs a file");
      appJson = v;
      i += 1;
    } else if (a.startsWith("--")) throw new BadInput(`unknown option ${a}`);
    else if (file === null) file = a;
    else throw new BadInput(`one records file only, got ${file} and ${a}`);
  }
  if (file === null) throw new BadInput("usage: bun scripts/math-check.ts <records.csv> [--last N] [--json] [--app-json <verdict.json>]");
  return { file, last, json, appJson };
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "(missing)";
}

export function render(report: Report): string {
  const lines = [`source: ${report.source}`, `n: ${report.n}`, `selection: ${report.selection_rule}`, "", "status    key | hand | app | tolerance"];
  for (const f of report.figures) lines.push(`${f.ok ? "OK      " : "MISMATCH"}  ${f.key} | ${show(f.hand)} | ${show(f.app)} | ${f.tolerance}${f.note === "" ? "" : ` | ${f.note}`}`);
  for (const e of report.excluded) lines.push(`EXCLUDED  ${e.key} | ${e.hand === null ? "-" : String(e.hand)} | - | ${e.reason}`);
  lines.push("", `compared=${report.compared} states=${report.states_compared} mismatches=${report.mismatches} excluded=${report.excluded.length}`);
  return lines.join("\n") + "\n";
}

/** The whole command: returns the exit code and what to print. */
export function main(argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  let tmp: string | null = null;
  try {
    const args = parseArgs(argv);
    let text: string;
    try {
      text = readFileSync(args.file, "utf8");
    } catch {
      throw new BadInput(`cannot read ${args.file}`);
    }
    const selection = selectLast(text, args.last);
    let appJson: unknown;
    if (args.appJson !== null) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(args.appJson, "utf8"));
        appJson = parsed;
      } catch {
        throw new BadInput(`cannot read ${args.appJson} as JSON`);
      }
    } else if (args.last === null) appJson = runApp(args.file);
    else {
      tmp = mkdtempSync(join(tmpdir(), "math-check-"));
      const sliced = join(tmp, "records.csv");
      writeFileSync(sliced, selection.text);
      appJson = runApp(sliced);
    }
    const report = compareWithApp(selection.text, appJson, args.file, selection);
    const code = exitCodeOf(report);
    const head = `source=${report.source} n=${report.n} selection="${report.selection_rule}"\n`;
    if (args.json) return { code, out: JSON.stringify(report, null, 2) + "\n", err: head };
    return { code, out: render(report), err: "" };
  } catch (error) {
    if (error instanceof BadInput) return { code: EXIT_CODES.badInput, out: "", err: `ERROR ${error.message}\n` };
    throw error;
  } finally {
    if (tmp !== null) rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
