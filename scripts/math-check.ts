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
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/** The verdict command's stdout is read in full: a 6,000-case file prints megabytes. */
const MAX_APP_OUTPUT = 1024 * 1024 * 1024;

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

/** The 18 columns format/README.md requires in every header. */
const REQUIRED_COLUMNS = [
  "format_version", "run_id", "prompt_version", "case_id", "case_input", "question_id", "question", "answer_set", "answerer",
  "answerer_model", "output", "confidence", "label", "label_source", "tokens_in", "tokens_out", "cost_usd", "latency_ms",
];
const OPTIONAL_COLUMNS = ["price_table_date", "labelled_by", "labelled_at", "label_blind", "label_final", "suggestion_shown", "outcome"];
const VERSIONS = ["jnj-record/1", "jnj-record/1.1", "jnj-record/1.2"];
const ANSWERERS = ["jev", "rule", "llm", "human", "decisions"];
const LABELS = ["", "accept", "reject"];
const SOURCES = ["", "human", "human_reviewed", "agent"];
const OUTCOMES = ["", "answered", "refused", "unsupported", "error"];
const COST_PATTERN = /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function columnsOf(header: readonly string[]): (name: string) => number {
  return (name) => {
    const index = header.indexOf(name);
    if (index < 0) throw new BadInput(`records file has no ${name} column`);
    return index;
  };
}

/**
 * The rows the calculation reads, after checking the record contract of format/README.md that the calculation depends
 * on: header columns, row width, version, identities, answerer, label and label source, output in the answer set,
 * outcome, cost, one row per (run, case, question, answerer) and one case_input per case. Any break is bad input,
 * so a doctored records file cannot pass against a saved app verdict.
 */
export function loadRows(text: string): HandRow[] {
  const [header, ...body] = parseCsv(stripBom(text));
  if (header === undefined || body.length === 0) throw new BadInput("records file has no data rows");
  if (new Set(header).size !== header.length) throw new BadInput("records header has a duplicate column");
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new BadInput(`records header is missing ${missing.join(", ")}`);
  const unknown = header.filter((c) => !REQUIRED_COLUMNS.includes(c) && !OPTIONAL_COLUMNS.includes(c));
  if (unknown.length > 0) throw new BadInput(`records header has unknown columns ${unknown.join(", ")}`);
  const col = columnsOf(header);
  const outcomeAt = header.indexOf("outcome");
  const seen = new Set<string>();
  const inputs = new Map<string, string>();
  return body.map((cells, i) => {
    const line = i + 2;
    if (cells.length !== header.length) throw new BadInput(`records line ${line}: ${cells.length} cells, header has ${header.length}`);
    const cell = (name: string): string => cells[col(name)] ?? "";
    const bad = (why: string): never => {
      throw new BadInput(`records line ${line}: ${why}`);
    };
    if (!VERSIONS.includes(cell("format_version"))) bad(`format_version ${cell("format_version")} is not a jnj-record version`);
    for (const name of ["run_id", "prompt_version", "case_id", "question_id", "question", "answerer_model"]) if (cell(name) === "") bad(`${name} is empty`);
    const answerer = cell("answerer");
    if (!ANSWERERS.includes(answerer)) bad(`answerer ${answerer} is not one of ${ANSWERERS.join(", ")}`);
    const label = cell("label");
    const source = cell("label_source");
    if (!LABELS.includes(label)) bad(`label ${label} is not accept, reject or empty`);
    if (!SOURCES.includes(source)) bad(`label_source ${source} is not human, human_reviewed, agent or empty`);
    if ((label === "") !== (source === "")) bad("label and label_source must both be filled or both be empty");
    const options = cell("answer_set").split("|");
    if (options.length < 2 || options.some((o) => o === "")) bad(`answer_set ${cell("answer_set")} needs two or more answers`);
    const outcome = outcomeAt < 0 ? "" : (cells[outcomeAt] ?? "");
    if (!OUTCOMES.includes(outcome)) bad(`outcome ${outcome} is not a known outcome`);
    const answered = outcome === "" || outcome === "answered";
    if (answered && !options.includes(cell("output"))) bad(`output ${cell("output")} is not in answer_set ${cell("answer_set")}`);
    if (!answered && (cell("output") !== "" || label !== "")) bad(`a ${outcome} row has no output and no label`);
    const costText = cell("cost_usd").trim();
    if (costText !== "" && !COST_PATTERN.test(costText)) bad(`cost_usd ${costText} is not a non-negative number`);
    const cost = costText === "" ? null : Number(costText);
    if (cost !== null && !Number.isFinite(cost)) bad(`cost_usd ${costText} is not finite`);
    const key = JSON.stringify([cell("run_id"), cell("case_id"), cell("question_id"), answerer]);
    if (seen.has(key)) bad(`duplicate row for run ${cell("run_id")} (${cell("case_id")}, ${cell("question_id")}, ${answerer})`);
    seen.add(key);
    const caseKey = JSON.stringify([cell("run_id"), cell("case_id")]);
    const firstInput = inputs.get(caseKey);
    if (firstInput === undefined) inputs.set(caseKey, cell("case_input"));
    else if (firstInput !== cell("case_input")) bad(`case_input differs from the first row for case_id ${cell("case_id")}`);
    return {
      runId: cell("run_id"),
      promptVersion: cell("prompt_version"),
      caseId: cell("case_id"),
      questionId: cell("question_id"),
      answerer,
      // format/README.md "Missing cost or labels": an agent label was never reviewed, so it counts as unlabelled.
      label: source === "agent" ? "" : label,
      cost,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Selection: the last N cases

export type Selection = { readonly text: string; readonly n: number; readonly rule: string; readonly cases: readonly string[] };

/** Distinct case_id values in order of first appearance. */
export function caseOrder(text: string): string[] {
  const [header, ...body] = parseCsv(stripBom(text));
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
  const [header, ...body] = parseCsv(stripBom(text));
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

/**
 * How a figure is compared. abs and rel: a finite app number within tolerance, or JSON null when the hand value is
 * infinite (JSON prints a non-finite number as null). exact: the same string. list: the same strings in order.
 * set: distinct strings, the same set. null: the app prints null. bound-lower and bound-upper: the app's cost-ratio
 * interval holds the hand ratio, with 0 <= lower <= upper.
 */
export type Tolerance = "abs" | "rel" | "exact" | "list" | "set" | "null" | "bound-lower" | "bound-upper";

export type HandValue = number | string | readonly string[] | null;

export type HandFigure = {
  /** `<question>:<path in that question's verdict object>`, e.g. `q1:numbers.jevVsLlm.a`. */
  readonly key: string;
  /** The cohort's (run_id, prompt_version, question_id) as JSON: the app verdict is matched on all three. */
  readonly cohort: string;
  readonly path: string;
  readonly value: HandValue;
  readonly tolerance: Tolerance;
  /** "figure" counts toward `compared`; "state" (verdict, rule, condition, kinds, case ids) is checked but not counted. */
  readonly group: "figure" | "state";
};

export type Excluded = { readonly key: string; readonly reason: string; readonly hand: number | null };

export type Cohort = {
  /** JSON of (run_id, prompt_version, question_id). */
  readonly id: string;
  /** Display name: the question id when the file has one run and prompt version. */
  readonly prefix: string;
  readonly runId: string;
  readonly promptVersion: string;
  readonly questionId: string;
  readonly rows: readonly HandRow[];
};

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

export function cohortId(runId: string, promptVersion: string, questionId: string): string {
  return JSON.stringify([runId, promptVersion, questionId]);
}

export function cohortsOf(rows: readonly HandRow[]): Cohort[] {
  const groups = new Map<string, { runId: string; promptVersion: string; questionId: string; rows: HandRow[] }>();
  for (const row of rows) {
    const id = cohortId(row.runId, row.promptVersion, row.questionId);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, { runId: row.runId, promptVersion: row.promptVersion, questionId: row.questionId, rows: [row] });
    else group.rows.push(row);
  }
  const list = [...groups.entries()];
  const single = new Set(list.map(([, g]) => cohortId(g.runId, g.promptVersion, ""))).size === 1;
  return list.map(([id, g]) => ({ ...g, id, prefix: single ? g.questionId : `${g.runId}/${g.promptVersion}/${g.questionId}` }));
}

/** The app's cost-ratio interval for a cohort (null in JSON read as infinity), which this check cannot recompute (#168). */
export type BootstrapBounds = { readonly lower: number; readonly upper: number } | null;

export type HandCohort = { readonly figures: HandFigure[]; readonly excluded: Excluded[]; readonly verdict: string };

/**
 * Every figure of one cohort that verdict-rules.md defines, keyed by the verdict JSON path.
 * `bootstrap` gives the app's cost-ratio interval, read only to decide rules 2 (clearly dearer) to 4.
 */
export function handCohort(cohort: Cohort, bootstrap: (cohort: Cohort) => BootstrapBounds): HandCohort {
  const figures: HandFigure[] = [];
  const excluded: Excluded[] = [];
  const p = cohort.prefix;
  const put = (path: string, value: HandValue, tolerance: Tolerance, group: "figure" | "state"): void => {
    figures.push({ key: `${p}:${path}`, cohort: cohort.id, path, value, tolerance, group });
  };
  const fig = (path: string, value: number, tolerance: "abs" | "rel"): void => put(path, value, tolerance, "figure");
  const state = (path: string, value: string): void => put(path, value, "exact", "state");
  const exclude = (path: string, reason: string, hand: number | null): void => {
    excluded.push({ key: `${p}:${path}`, reason, hand });
  };
  const rows = cohort.rows;
  const has = (who: string): boolean => rows.some((r) => r.answerer === who);
  const hasJev = has("jev");
  const hasLlm = has("llm");
  const hasRule = has("rule");

  // Jev against the LLM. The pair exists whenever both have rows; its numbers only when a case pairs.
  const pair = hasJev && hasLlm ? pairUp(rows, "llm") : null;
  const n = pair?.ids.length ?? 0;
  let nc: Newcombe | null = null;
  if (pair !== null) {
    fig("numbers.jevAccepted", pair.jev.accepted, "abs");
    fig("numbers.llmAccepted", pair.other.accepted, "abs");
    if (n === 0) put("numbers.jevVsLlm", null, "null", "state");
  }
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
        state(`${base}.${side}.spend.kind`, "incomplete");
        fig(`${base}.${side}.spend.knownUsd`, s.spend, "rel");
        fig(`${base}.${side}.spend.missing`, s.missing, "abs");
        state(`${base}.${side}.costPerAccepted.kind`, "incomplete");
      } else {
        state(`${base}.${side}.spend.kind`, "complete");
        fig(`${base}.${side}.spend.usd`, s.spend, "rel");
        if (s.accepted === 0) state(`${base}.${side}.costPerAccepted.kind`, "undefined");
        else {
          state(`${base}.${side}.costPerAccepted.kind`, "value");
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
    // Exactly the paired cases, each once, before any per-case cost is read.
    put(`${base}.cases[*].caseId`, [...pair.ids], "set", "state");
    for (const [id, [jc, oc]] of pair.costs) {
      if (jc !== null) fig(`${base}.cases[${id}].jevCostUsd`, jc, "rel");
      if (oc !== null) fig(`${base}.cases[${id}].otherCostUsd`, oc, "rel");
    }
    fig(`${base}.p1`, nc.p1, "abs");
    fig(`${base}.p2`, nc.p2, "abs");
    fig(`${base}.diff`, nc.diff, "abs");
    fig(`${base}.lower`, nc.lower, "abs");
    fig(`${base}.upper`, nc.upper, "abs");
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
      state("ruleComparison.kind", "skipped");
      fig("ruleComparison.paired", rn, "abs");
    } else {
      // Rule first: rule-only is b, Jev-only is c.
      const r = newcombe(rp.a, rp.c, rp.b, rp.d);
      ruleLower = r.lower;
      state("ruleComparison.kind", "compared");
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
  } else state("ruleComparison.kind", "skipped");

  // The verdict, first match wins. rule is compared as a number, unmet as a list of strings.
  const decide = (verdict: string, rule: number, condition: string, unmet: readonly string[] = []): HandCohort => {
    state("verdict", verdict);
    put("rule", rule, "abs", "state");
    state("condition", condition);
    put("unmet", unmet, "list", "state");
    return { figures, excluded, verdict };
  };
  // A verdict that stops before the cost ratio: the app prints numbers.costRatio as null (verdict.ts `base`).
  const early = (verdict: string, rule: number, condition: string): HandCohort => {
    put("numbers.costRatio", null, "null", "state");
    return decide(verdict, rule, condition);
  };
  const nee = "not enough evidence";
  const dont = "don't use Jev";
  if (!hasJev) return early(nee, 1, "no-jev-rows");
  if (!hasLlm) return early(nee, 1, "no-llm-rows");
  if (pair === null || nc === null || n < MIN_PAIRED) {
    fig("addN", MIN_PAIRED - n, "abs");
    return early(nee, 1, "too-few-paired");
  }
  if (pair.jev.missing > 0 || pair.other.missing > 0) return early(nee, 1, "cost-missing");
  if (ruleLower !== null && ruleLower > -MARGIN) return early(dont, 2, "rule-within-margin");
  if (nc.upper < -MARGIN) return early(dont, 2, "jev-clearly-worse");
  // Either side at 0 accepted has no cost per accepted answer: rule 1, after the two accept-rate conditions.
  if (pair.jev.accepted === 0 || pair.other.accepted === 0) return early(nee, 1, "zero-accepted");
  const jevSpend = pair.jev.spend;
  const llmSpend = pair.other.spend;
  let largest = 0;
  for (const [jc, oc] of pair.costs.values()) largest = Math.max(largest, jc ?? 0, oc ?? 0);
  if (!Number.isFinite(jevSpend) || !Number.isFinite(llmSpend) || !Number.isFinite(largest * n)) return early(nee, 1, "cost-not-finite");
  // cost_ratio (both sides have 1 or more accepted here): infinity when the LLM costs $0 per accepted and Jev more.
  const jevPer = jevSpend / pair.jev.accepted;
  const llmPer = llmSpend / pair.other.accepted;
  let ratio: number | null;
  if (jevPer === 0 && llmPer === 0) ratio = null;
  else if (llmPer === 0) ratio = Number.POSITIVE_INFINITY;
  else ratio = Number.isFinite(jevPer / llmPer) ? jevPer / llmPer : null;
  if (ratio === null) return early(nee, 1, jevSpend === 0 && llmSpend === 0 ? "no-cost-ratio" : "cost-not-finite");
  fig("numbers.costRatio.ratio", ratio, "rel");
  fig("numbers.costRatio.resamples", RESAMPLES, "abs");
  exclude("numbers.costRatio.redrawn", "seeded resampling; the seed is not in verdict output until #168", null);
  // Partial: the app's interval must hold the hand ratio, with 0 <= lower <= upper; the bounds are not recomputed.
  put("numbers.costRatio.lower", ratio, "bound-lower", "figure");
  put("numbers.costRatio.upper", ratio, "bound-upper", "figure");
  const ci = bootstrap(cohort);
  if (ci === null) return decide("(needs the app's cost-ratio interval)", 0, "(unknown)");
  if (ci.lower > 1 + COST_TOLERANCE) return decide(dont, 2, "jev-clearly-dearer");
  const unmet: string[] = [];
  if (!(nc.lower > -MARGIN)) unmet.push("accept-rate-not-shown");
  if (ratio > CHEAPER + COST_TOLERANCE) unmet.push(ratio < 1 - COST_TOLERANCE ? "cheaper-by-less-than-20" : "not-cheaper");
  if (!(ci.upper < 1 - COST_TOLERANCE)) unmet.push("cost-upper-bound-not-below-1");
  const [first] = unmet;
  if (first === undefined) return decide("use Jev", 3, "use-jev");
  return decide(nee, 4, first, unmet);
}

// ---------------------------------------------------------------------------------------------
// The app side: verdict JSON

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every verdict object of the app's JSON keyed by (run_id, prompt_version, question_id); a malformed or repeated entry is refused. */
export function appVerdicts(json: unknown): Map<string, Record<string, unknown>> {
  if (!isRecord(json) || !Array.isArray(json.verdicts)) throw new BadInput("app output has no verdicts array");
  const out = new Map<string, Record<string, unknown>>();
  json.verdicts.forEach((v: unknown, i: number) => {
    if (!isRecord(v)) throw new BadInput(`app output: verdicts[${i}] is not an object`);
    const { run_id: run, prompt_version: pv, question_id: q } = v;
    if (typeof run !== "string" || typeof pv !== "string" || typeof q !== "string") {
      throw new BadInput(`app output: verdicts[${i}] lacks a text run_id, prompt_version or question_id`);
    }
    const id = cohortId(run, pv, q);
    if (out.has(id)) throw new BadInput(`app output: verdict for run ${run}, prompt ${pv}, question ${q} appears twice`);
    out.set(id, v);
  });
  return out;
}

/**
 * Walk `a.b.cases[c07].x` through a verdict object. `[id]` picks the element whose caseId is id (undefined unless
 * exactly one matches); `[*]` keeps the array, and the next segment then maps over its elements.
 */
export function resolvePath(root: unknown, path: string): unknown {
  let here: unknown = root;
  let mapping = false;
  for (const segment of path.split(".")) {
    const m = /^([^[\]]+)(?:\[([^\]]+)\])?$/.exec(segment);
    if (m === null) return undefined;
    const name = m[1] ?? "";
    if (mapping) {
      if (!Array.isArray(here)) return undefined;
      here = here.map((item: unknown) => (isRecord(item) ? item[name] : undefined));
      mapping = false;
    } else {
      if (!isRecord(here)) return undefined;
      here = here[name];
    }
    const id = m[2];
    if (id === "*") {
      if (!Array.isArray(here)) return undefined;
      mapping = true;
    } else if (id !== undefined) {
      if (!Array.isArray(here)) return undefined;
      const matches = here.filter((item: unknown) => isRecord(item) && item.caseId === id);
      here = matches.length === 1 ? matches[0] : undefined;
    }
  }
  return here;
}

/** A cost-ratio bound as printed: a number, or null for infinity (JSON prints a non-finite number as null). */
function boundValue(value: unknown): number | null {
  if (value === null) return Number.POSITIVE_INFINITY;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bootstrapOf(verdict: Record<string, unknown> | undefined): BootstrapBounds {
  if (verdict === undefined) return null;
  const lower = boundValue(resolvePath(verdict, "numbers.costRatio.lower"));
  const upper = boundValue(resolvePath(verdict, "numbers.costRatio.upper"));
  return lower === null || upper === null ? null : { lower, upper };
}

/** Every numeric leaf of a JSON value, arrays written `[]`: the coverage table's row keys. */
export function numericLeaves(value: unknown, path = ""): string[] {
  if (typeof value === "number") return [path];
  if (Array.isArray(value)) return [...new Set(value.flatMap((item: unknown) => numericLeaves(item, `${path}[]`)))];
  if (!isRecord(value)) return [];
  return [...new Set(Object.entries(value).flatMap(([k, v]) => numericLeaves(v, path === "" ? k : `${path}.${k}`)))];
}

// ---------------------------------------------------------------------------------------------
// Comparison

export type FigureResult = {
  readonly key: string;
  readonly group: "figure" | "state";
  readonly hand: HandValue;
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
  if (t === "bound-lower" || t === "bound-upper") return `0 <= lower <= hand ratio <= upper, rel ${REL_TOLERANCE}`;
  return t;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

type Outcome = { readonly ok: boolean; readonly note: string };

function pass(ok: boolean, note: string): Outcome {
  return { ok, note: ok ? "" : note };
}

function numberCheck(hand: number, app: unknown, t: "abs" | "rel"): Outcome {
  // JSON prints a non-finite number as null: an infinite hand value expects null, and is never compared by arithmetic.
  if (!Number.isFinite(hand)) return pass(app === null, `hand value is ${hand}, which the app prints as null`);
  if (typeof app !== "number" || !Number.isFinite(app)) {
    return { ok: false, note: app === undefined || app === null || app === "" ? "app value blank or missing" : "app value is not a finite number" };
  }
  const gap = Math.abs(hand - app);
  const ok = t === "abs" ? gap <= ABS_TOLERANCE : gap <= REL_TOLERANCE * Math.max(Math.abs(hand), Math.abs(app));
  return pass(ok, `differs by ${gap}`);
}

function boundCheck(ratio: number, verdict: Record<string, unknown>, which: "lower" | "upper"): Outcome {
  // A null bound is infinity (JSON prints it so): a resample with Jev at 0 accepted keeps an infinite ratio
  // (verdict-rules.md "Cost ratio interval"), so an infinite upper bound is legitimate beside a finite point ratio.
  // An infinite lower bound with a finite ratio still fails below, because the ratio must lie inside the interval.
  const lower = boundValue(resolvePath(verdict, "numbers.costRatio.lower"));
  const upper = boundValue(resolvePath(verdict, "numbers.costRatio.upper"));
  const mine = which === "lower" ? lower : upper;
  if (mine === null) return { ok: false, note: "app bound blank or not a number" };
  if (lower === null || upper === null) return { ok: false, note: "the other bound is blank or not a number" };
  if (which === "lower" && !(lower >= 0)) return { ok: false, note: `lower bound ${lower} is below 0` };
  if (!(lower <= upper)) return { ok: false, note: `lower bound ${lower} is above upper bound ${upper}` };
  if (!Number.isFinite(ratio)) return pass(which === "lower" || upper === Number.POSITIVE_INFINITY, "hand ratio is infinite but the app's upper bound is finite");
  const slack = REL_TOLERANCE * Math.abs(ratio);
  if (which === "lower") return pass(lower <= ratio + slack, `hand ratio ${ratio} is below the app's lower bound`);
  return pass(upper >= ratio - slack, `hand ratio ${ratio} is above the app's upper bound`);
}

function compareOne(f: HandFigure, verdict: Record<string, unknown> | undefined): FigureResult {
  const app = verdict === undefined ? undefined : resolvePath(verdict, f.path);
  const base = { key: f.key, group: f.group, hand: f.value, app: app === undefined ? null : app, tolerance: toleranceText(f.tolerance) };
  if (verdict === undefined) return { ...base, ok: false, note: "the app has no verdict for this run, prompt version and question" };
  let result: Outcome;
  const hand = f.value;
  if (f.tolerance === "null") result = pass(app === null, "app prints a value where null is expected");
  else if (f.tolerance === "exact") result = pass(typeof app === "string" && app === hand, typeof app === "string" ? "differs" : "app value is not text");
  else if (f.tolerance === "list" || f.tolerance === "set") {
    const list = stringList(app);
    const want = Array.isArray(hand) ? [...hand] : [];
    if (list === null) result = { ok: false, note: "app value is not a list of text" };
    else if (f.tolerance === "list") result = pass(list.length === want.length && list.every((v, i) => v === want[i]), "differs");
    else if (new Set(list).size !== list.length) result = { ok: false, note: "app lists a case more than once" };
    else {
      const a = [...list].sort();
      const b = [...want].sort();
      result = pass(a.length === b.length && a.every((v, i) => v === b[i]), "app cases differ from the paired cases");
    }
  } else if (typeof hand !== "number") result = { ok: false, note: "hand value is not a number" };
  else if (f.tolerance === "bound-lower" || f.tolerance === "bound-upper") result = boundCheck(hand, verdict, f.tolerance === "bound-lower" ? "lower" : "upper");
  else result = numberCheck(hand, app, f.tolerance);
  return { ...base, ...result };
}

/** The hand figures of every cohort in `text`, compared with the app's verdict JSON. */
export function compareWithApp(text: string, appJson: unknown, source: string, selection: Selection): Report {
  const verdicts = appVerdicts(appJson);
  const figures: FigureResult[] = [];
  const excluded: Excluded[] = [];
  const cohorts = cohortsOf(loadRows(text));
  const hands = cohorts.map((cohort) => {
    const verdict = verdicts.get(cohort.id);
    const hand = handCohort(cohort, () => bootstrapOf(verdict));
    excluded.push(...hand.excluded);
    for (const f of hand.figures) figures.push(compareOne(f, verdict));
    return hand.verdict;
  });
  // Top-level exit code, docs/api.md "Exit codes": 3 when any is don't use Jev, else 4 when any is not enough evidence, else 0.
  const exit = hands.includes("don't use Jev") ? 3 : hands.includes("not enough evidence") ? 4 : 0;
  const appExit = isRecord(appJson) ? appJson.exit_code : undefined;
  const exitCheck = numberCheck(exit, appExit, "abs");
  figures.push({ key: "exit_code", group: "state", hand: exit, app: appExit ?? null, tolerance: toleranceText("abs"), ...exitCheck });
  for (const [id, v] of verdicts) {
    if (!cohorts.some((c) => c.id === id)) {
      figures.push({ key: `${String(v.run_id)}/${String(v.prompt_version)}/${String(v.question_id)}:verdict`, group: "state", hand: "(no such question in the records)", app: v.verdict ?? null, tolerance: "exact", ok: false, note: "the app has a question the records do not" });
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

type CliRun = { readonly status: number | null; readonly stdout: string; readonly stderr: string };

/**
 * One app subcommand (`verdict` or `validate`) on a records file (an absolute path), as a separate process.
 * stdout goes to a file, not a pipe: the command calls process.exit() straight after writing, and a piped stdout
 * loses everything past the first buffer (131,072 of 1,242,979 bytes on a 6,000-case file). A file write is
 * synchronous, so the whole output lands.
 */
function runCli(subcommand: "verdict" | "validate", file: string): CliRun {
  const cli = join(ROOT, "src", "decide", "cli.ts");
  const dir = mkdtempSync(join(tmpdir(), "math-check-app-"));
  const outPath = join(dir, "stdout.txt");
  const fd = openSync(outPath, "w");
  try {
    // Only PATH and HOME are passed on: neither command needs a key, and neither must see one.
    const res = spawnSync(process.execPath, [cli, subcommand, file], {
      cwd: ROOT, encoding: "utf8", maxBuffer: MAX_APP_OUTPUT, stdio: ["ignore", fd, "pipe"], env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    if (res.error !== undefined) throw new BadInput(`${subcommand} command failed: ${res.error.message}`);
    return { status: res.status, stdout: readFileSync(outPath, "utf8"), stderr: res.stderr };
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function firstLines(text: string): string {
  return text.trim().split("\n").slice(0, 5).join(" | ");
}

/** The app's verdict JSON for a records file (an absolute path), from the verdict command's stdout (exit 0, 3 or 4). */
export function runApp(file: string): unknown {
  const res = runCli("verdict", file);
  if (res.status === null || ![0, 3, 4].includes(res.status)) throw new BadInput(`verdict command exited ${String(res.status)}: ${firstLines(res.stderr || res.stdout)}`);
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    return parsed;
  } catch {
    throw new BadInput(`verdict command printed no complete JSON (${res.stdout.length} characters)`);
  }
}

/**
 * The product record validator on a records file: exit 0 valid, anything else is bad input with the validator's own
 * errors. Read from its exit code and output only, like verdict; nothing is imported from the product code.
 */
export function runValidate(file: string): void {
  const res = runCli("validate", file);
  if (res.status === 0) return;
  let errors: string[] = [];
  try {
    const parsed: unknown = JSON.parse(res.stdout);
    if (isRecord(parsed)) errors = stringList(parsed.errors) ?? [];
  } catch {
    errors = [];
  }
  const message = errors.length > 0 ? errors.slice(0, 5).join(" | ") : firstLines(res.stderr || res.stdout);
  throw new BadInput(`records file is invalid (validate exited ${String(res.status)}): ${message}`);
}

/**
 * Write exactly `text` to a temporary snapshot, run the product validator on it, then (unless the app's verdict is
 * supplied) the verdict command on the same snapshot: both app commands and the hand side read the same bytes.
 */
export function checkSnapshot(text: string, appJson: unknown): unknown {
  const dir = mkdtempSync(join(tmpdir(), "math-check-"));
  try {
    const file = join(dir, "records.csv");
    writeFileSync(file, text);
    runValidate(file);
    return appJson === undefined ? runApp(file) : appJson;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Strict UTF-8: a byte sequence that is not UTF-8 is bad input, never replaced; a byte order mark is kept. */
export function decodeStrict(bytes: Uint8Array, name: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new BadInput(`cannot read ${name} as UTF-8`);
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

/** The whole command: returns the exit code and what to print. The file is read once; the app runs on that text. */
export function main(argv: readonly string[]): { readonly code: number; readonly out: string; readonly err: string } {
  try {
    const args = parseArgs(argv);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(args.file);
    } catch {
      throw new BadInput(`cannot read ${args.file}`);
    }
    const selection = selectLast(decodeStrict(bytes, args.file), args.last);
    let supplied: unknown = undefined;
    if (args.appJson !== null) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(args.appJson, "utf8"));
        supplied = parsed;
      } catch {
        throw new BadInput(`cannot read ${args.appJson} as JSON`);
      }
    }
    // The product validator always runs, --app-json or not; the verdict runs only when no app JSON is supplied.
    const appJson = checkSnapshot(selection.text, supplied);
    const report = compareWithApp(selection.text, appJson, args.file, selection);
    const code = exitCodeOf(report);
    const head = `source=${report.source} n=${report.n} selection="${report.selection_rule}"\n`;
    if (args.json) return { code, out: JSON.stringify(report, null, 2) + "\n", err: head };
    return { code, out: render(report), err: "" };
  } catch (error) {
    if (error instanceof BadInput) return { code: EXIT_CODES.badInput, out: "", err: `ERROR ${error.message}\n` };
    throw error;
  }
}

if (import.meta.main) {
  const result = main(process.argv.slice(2));
  process.stdout.write(result.out);
  process.stderr.write(result.err);
  process.exitCode = result.code;
}
