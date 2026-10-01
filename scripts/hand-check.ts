// T17 / R5.h: a second, independent calculation of every figure in examples/d06-tiny/expected.md.
// Written from docs/decision/verdict-rules.md alone. It imports only Node built-ins, never the
// product code, so a defect in the product calculation cannot also hide here (a test reads this
// file's own source and asserts that).
//
// Run: bun scripts/hand-check.ts [records.csv] [expected.md]

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One labelled-test-file row, reduced to the columns the calculation reads. */
export type HandRecord = {
  readonly caseId: string;
  readonly questionId: string;
  readonly answerer: string;
  readonly answers: readonly string[];
  readonly output: string;
  /** "accept", "reject", or "" when unlabelled. */
  readonly label: string;
  /** null when cost_usd is blank. */
  readonly cost: number | null;
};

/** A computed figure. Required figures must be stated in expected.md; the rest are checked only when stated. */
export type Figure = { readonly value: number | string; readonly required: boolean };

export type Mismatch = { readonly key: string; readonly expected: string; readonly computed: string };

export type CheckResult = { readonly checked: number; readonly mismatches: readonly Mismatch[] };

const MIN_PAIRED = 30; // verdict-rules.md, Settings: minimum paired labelled cases
const INCOMPLETE = "incomplete";

// ---------------------------------------------------------------------------------------------
// CSV

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text.charAt(i + 1) === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function loadRecords(text: string): HandRecord[] {
  const [header, ...body] = parseCsv(text);
  if (header === undefined) throw new Error("records file is empty");
  const column = (name: string): number => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`records file has no ${name} column`);
    return index;
  };
  const at = { case: column("case_id"), q: column("question_id"), set: column("answer_set"), who: column("answerer"), out: column("output"), label: column("label"), cost: column("cost_usd") };
  return body.map((cells, n) => {
    const cell = (index: number): string => {
      const value = cells[index];
      if (value === undefined) throw new Error(`records row ${n + 2} is short`);
      return value;
    };
    const costText = cell(at.cost).trim();
    const cost = costText === "" ? null : Number(costText);
    if (cost !== null && !Number.isFinite(cost)) throw new Error(`records row ${n + 2}: cost_usd ${costText} is not a number`);
    return {
      caseId: cell(at.case),
      questionId: cell(at.q),
      answerer: cell(at.who),
      answers: cell(at.set).split("|"),
      output: cell(at.out),
      label: cell(at.label),
      cost,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The calculation, from verdict-rules.md

type Totals = { accepted: number; rejects: string[]; spend: number | typeof INCOMPLETE };

function totalsOf(rows: readonly HandRecord[]): Totals {
  let accepted = 0;
  let sum = 0;
  let missing = false;
  const rejects: string[] = [];
  for (const row of rows) {
    if (row.label === "accept") accepted += 1;
    if (row.label === "reject") rejects.push(row.caseId);
    if (row.cost === null) missing = true;
    else sum += row.cost;
  }
  return { accepted, rejects, spend: missing ? INCOMPLETE : sum };
}

/** spend / accepted; undefined (null) at 0 accepted or incomplete spend. */
function costPerAccepted(totals: Totals): number | null {
  if (totals.spend === INCOMPLETE || totals.accepted === 0) return null;
  return totals.spend / totals.accepted;
}

/** cost_per_accepted(jev) / cost_per_accepted(llm), with the 0 and infinity cases; null when there is no ratio. */
function costRatio(jev: Totals, llm: Totals): number | null {
  if (jev.spend === INCOMPLETE || llm.spend === INCOMPLETE) return null;
  if (jev.accepted === 0 && llm.accepted === 0) return null;
  if (llm.accepted === 0) return 0;
  if (jev.accepted === 0) return Number.POSITIVE_INFINITY;
  const j = costPerAccepted(jev);
  const l = costPerAccepted(llm);
  return j === null || l === null ? null : j / l;
}

function labelled(rows: readonly HandRecord[], answerer: string, question: string): Map<string, HandRecord> {
  const found = new Map<string, HandRecord>();
  for (const row of rows) {
    if (row.answerer !== answerer || row.questionId !== question || row.label === "") continue;
    if (found.has(row.caseId)) throw new Error(`two labelled ${answerer} rows for ${row.caseId} ${question}`);
    found.set(row.caseId, row);
  }
  return found;
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function computeFigures(records: readonly HandRecord[]): Map<string, Figure> {
  const figures = new Map<string, Figure>();
  const put = (key: string, value: number | string, required = true): void => {
    if (figures.has(key)) throw new Error(`figure ${key} computed twice`);
    figures.set(key, { value, required });
  };

  const cases = distinct(records.map((r) => r.caseId));
  const questions = distinct(records.map((r) => r.questionId));
  const answerers = distinct(records.map((r) => r.answerer));
  put("file.cases", cases.length);
  put("file.questions", questions.length);
  put("file.answerers", answerers.length);
  put("file.rows", records.length);

  // Per answerer, whole file.
  for (const who of answerers) {
    const rows = records.filter((r) => r.answerer === who);
    const totals = totalsOf(rows);
    put(`file.${who}.rows`, rows.length);
    put(`file.${who}.labelled`, rows.filter((r) => r.label !== "").length);
    put(`file.${who}.accepted`, totals.accepted);
    put(`file.${who}.spend`, totals.spend);
    const costs = distinct(rows.map((r) => (r.cost === null ? "" : String(r.cost))));
    const only = costs[0];
    if (costs.length === 1 && only !== undefined && only !== "") put(`file.${who}.unit_cost`, Number(only), false);
  }

  // Every row: output, label, a missing cost.
  for (const row of records) {
    const key = `row.${row.caseId}.${row.questionId}.${row.answerer}`;
    put(`${key}.output`, row.output);
    put(`${key}.label`, row.label === "accept" ? "A" : row.label === "reject" ? "R" : "-");
    if (row.cost === null) put(`${key}.cost`, "missing");
  }

  // Correct answers: an accepted output is the correct answer; a rejected yes/no output is the other answer.
  for (const row of records) {
    if (row.label === "") continue;
    const others = row.answers.filter((a) => a !== row.output);
    const other = others[0];
    if (row.label === "reject" && (others.length !== 1 || other === undefined)) continue;
    const correct = row.label === "accept" ? row.output : (other ?? "");
    const key = `correct.${row.caseId}.${row.questionId}`;
    const seen = figures.get(key);
    if (seen === undefined) put(key, correct);
    else if (seen.value !== correct) figures.set(key, { value: "(labels disagree)", required: true });
  }

  // Per decision point: Jev against the LLM (rate and cost) and against the rule (rate only).
  for (const q of questions) {
    const jevRows = labelled(records, "jev", q);
    let pairedJevLlm: HandRecord[][] = [];
    let pairedRule: number | null = null;
    for (const other of ["llm", "rule"]) {
      if (!answerers.includes(other)) continue;
      const otherRows = labelled(records, other, q);
      const pairs: HandRecord[][] = [];
      for (const [caseId, jevRow] of jevRows) {
        const otherRow = otherRows.get(caseId);
        if (otherRow !== undefined) pairs.push([jevRow, otherRow]);
      }
      const n = pairs.length;
      const prefix = `${q}.jev-${other}`;
      const isLlm = other === "llm";
      if (isLlm) pairedJevLlm = pairs;
      else pairedRule = n;
      put(`${prefix}.paired`, n);

      const side = (index: 0 | 1): HandRecord[] => pairs.flatMap((pair) => (pair[index] === undefined ? [] : [pair[index]]));
      const totals = { jev: totalsOf(side(0)), [other]: totalsOf(side(1)) };
      for (const [who, t] of Object.entries(totals)) {
        put(`${prefix}.${who}.accepted`, t.accepted);
        put(`${prefix}.${who}.rejects`, t.rejects.join(","), false);
        if (n > 0) put(`${prefix}.${who}.accept_rate`, t.accepted / n, isLlm);
        put(`${prefix}.${who}.spend`, t.spend, isLlm || t.spend === INCOMPLETE);
        const cpa = costPerAccepted(t);
        if (cpa !== null) put(`${prefix}.${who}.cost_per_accepted`, cpa, isLlm);
      }
      const jevT = totals.jev;
      const otherT = totals[other];
      if (isLlm && jevT !== undefined && otherT !== undefined) {
        const ratio = costRatio(jevT, otherT);
        if (ratio !== null) put(`${prefix}.cost_ratio`, ratio);
      }

      // a = both accepted, b = Jev only, c = other only, d = both rejected.
      const cells: Record<"a" | "b" | "c" | "d", string[]> = { a: [], b: [], c: [], d: [] };
      for (const [j, o] of pairs) {
        if (j === undefined || o === undefined) continue;
        const ja = j.label === "accept";
        const oa = o.label === "accept";
        cells[ja && oa ? "a" : ja ? "b" : oa ? "c" : "d"].push(j.caseId);
      }
      for (const [cell, ids] of Object.entries(cells)) {
        put(`${prefix}.${cell}`, ids.length);
        put(`${prefix}.${cell}.cases`, ids.join(","), false);
      }
      if (n > 0) {
        const p1 = (cells.a.length + cells.b.length) / n;
        const p2 = (cells.a.length + cells.c.length) / n;
        // expected.md states Jev minus the LLM, and the rule minus Jev.
        put(`${prefix}.diff`, isLlm ? p1 - p2 : p2 - p1);
      }
    }

    // Verdict rule 1. Rules 2 to 4 need the Newcombe interval and the seeded cost-ratio resample;
    // d06 never reaches them, so this hand check stops rather than guess.
    const n = pairedJevLlm.length;
    const jevPaired = pairedJevLlm.flatMap((pair) => (pair[0] === undefined ? [] : [pair[0]]));
    const llmPaired = pairedJevLlm.flatMap((pair) => (pair[1] === undefined ? [] : [pair[1]]));
    const noRows = !answerers.includes("jev") || !answerers.includes("llm");
    const bothZero = totalsOf(jevPaired).accepted === 0 && totalsOf(llmPaired).accepted === 0;
    const costMissing = [...jevPaired, ...llmPaired].some((r) => r.cost === null);
    if (!(noRows || n < MIN_PAIRED || bothZero || costMissing)) {
      throw new Error(`${q}: verdict rule 1 does not fire; rules 2 to 4 are outside this hand check`);
    }
    put(`${q}.verdict`, "not enough evidence");
    if (!noRows && n < MIN_PAIRED) {
      put(`${q}.verdict.paired`, n);
      put(`${q}.verdict.add_n`, MIN_PAIRED - n);
    }
    if (pairedRule !== null && pairedRule < MIN_PAIRED) put(`${q}.verdict.rule_skipped_paired`, pairedRule);
  }
  return figures;
}

// ---------------------------------------------------------------------------------------------
// Reading the figures out of expected.md

const ANSWERER_BY_HEADING: ReadonlyMap<string, string> = new Map([
  ["Jev", "jev"],
  ["Rule", "rule"],
  ["LLM", "llm"],
]);
const METRIC_BY_ROW: ReadonlyMap<string, string> = new Map([
  ["Accepted", "accepted"],
  ["Accept rate", "accept_rate"],
  ["Spend", "spend"],
  ["Cost per accepted", "cost_per_accepted"],
]);

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** The figure in a cell: text after the last "=", a leading "$" dropped, a trailing "(...)" split off. */
function cellFigure(cell: string): { value: string; note: string } {
  const afterEquals = cell.includes("=") ? cell.slice(cell.lastIndexOf("=") + 1) : cell;
  const match = /^\s*\$?(\S+)(?:\s+\((.*)\))?\s*$/.exec(afterEquals);
  if (match === null || match[1] === undefined) throw new Error(`no figure in cell "${cell}"`);
  return { value: match[1], note: match[2] ?? "" };
}

function caseList(note: string): string | null {
  return /^cv\d+(?:, cv\d+)*$/.test(note) ? note.split(/,\s*/).join(",") : null;
}

export function parseExpected(markdown: string): Map<string, string> {
  const figures = new Map<string, string>();
  const put = (key: string, value: string): void => {
    if (figures.has(key)) throw new Error(`expected.md states ${key} twice`);
    figures.set(key, value);
  };

  let section = "";
  let question = "";
  let comparison = "";
  let header: string[] | null = null;

  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading !== null && heading[1] !== undefined) {
      section = heading[1];
      question = /^(q\d+):/.exec(section)?.[1] ?? "";
      comparison = "";
      header = null;
      continue;
    }

    // Prose figures anywhere in the file.
    const shape = /(\d+) CVs x (\d+) questions x (\d+) answerers = (\d+) rows/.exec(line);
    if (shape !== null) {
      put("file.cases", shape[1] ?? "");
      put("file.questions", shape[2] ?? "");
      put("file.answerers", shape[3] ?? "");
      put("file.rows", shape[4] ?? "");
    }
    for (const unit of line.matchAll(/\$([\d.]+) per (\w+) call/g)) {
      const who = ANSWERER_BY_HEADING.get(unit[2] ?? "");
      if (who !== undefined) put(`file.${who}.unit_cost`, unit[1] ?? "");
    }

    if (line.startsWith("|")) {
      const cells = splitRow(line);
      if (cells.every((c) => /^-*$/.test(c))) continue;
      if (header === null) {
        header = cells;
        continue;
      }
      parseTableRow(section, question, comparison, header, cells, put);
      continue;
    }
    header = null;
    if (question === "") continue;

    const against = /^\*\*Jev against the (LLM|rule):\*\*\s+(\d+) paired cases/.exec(line);
    if (against !== null) {
      comparison = `jev-${(against[1] ?? "").toLowerCase()}`;
      put(`${question}.${comparison}.paired`, against[2] ?? "");
    }
    const verdict = /^\*\*Verdict: ([^.*]+)\.\*\*/.exec(line);
    if (verdict !== null) {
      comparison = "";
      put(`${question}.verdict`, verdict[1] ?? "");
      const paired = /Rule 1: (\d+) paired Jev and LLM cases/.exec(line);
      if (paired !== null) put(`${question}.verdict.paired`, paired[1] ?? "");
      const add = /add (\d+) more labelled cases/.exec(line);
      if (add !== null) put(`${question}.verdict.add_n`, add[1] ?? "");
      const skipped = /rule comparison is skipped \((\d+) paired rule cases\)/.exec(line);
      if (skipped !== null) put(`${question}.verdict.rule_skipped_paired`, skipped[1] ?? "");
      continue;
    }
    if (comparison === "") continue;
    const prefix = `${question}.${comparison}`;

    const counts = /Jev (\d+) accepted, rule (\d+)/.exec(line);
    if (counts !== null) {
      put(`${prefix}.jev.accepted`, counts[1] ?? "");
      put(`${prefix}.rule.accepted`, counts[2] ?? "");
    }
    const ratio = /Cost ratio = [^*]*\*\*([^*]+)\*\*/.exec(line);
    if (ratio !== null) put(`${prefix}.cost_ratio`, cellFigure(ratio[1] ?? "").value);
    for (const cell of line.matchAll(/\b([abcd]) (?:\([^)]*\) )?= (\d+)(?: \(([^)]*)\))?/g)) {
      put(`${prefix}.${cell[1] ?? ""}`, cell[2] ?? "");
      const ids = caseList(cell[3] ?? "");
      if (ids !== null) put(`${prefix}.${cell[1] ?? ""}.cases`, ids);
    }
    const jevMinusLlm = /Jev minus LLM = \*\*(-?[\d.]+)\*\*/.exec(line);
    if (jevMinusLlm !== null) put(`${question}.jev-llm.diff`, jevMinusLlm[1] ?? "");
    const ruleMinusJev = /Rule minus Jev = \*\*(-?[\d.]+)\*\*/.exec(line);
    if (ruleMinusJev !== null) put(`${question}.jev-rule.diff`, ruleMinusJev[1] ?? "");
    if (/Rule spend is incomplete/.test(line)) put(`${question}.jev-rule.rule.spend`, INCOMPLETE);
  }
  return figures;
}

function parseTableRow(
  section: string,
  question: string,
  comparison: string,
  header: readonly string[],
  cells: readonly string[],
  put: (key: string, value: string) => void,
): void {
  const first = cells[0] ?? "";
  if (section === "Correct answers") {
    header.forEach((q, i) => {
      if (/^q\d+$/.test(q)) put(`correct.${first}.${q}`, cells[i] ?? "");
    });
    return;
  }
  if (section === "Every row, by hand") {
    const [caseId, q] = first.split(/\s+/);
    header.forEach((name, i) => {
      const who = ANSWERER_BY_HEADING.get(name);
      if (who === undefined) return;
      const cell = /^(\S+) ([AR-])(?: \((.*)\))?$/.exec(cells[i] ?? "");
      if (cell === null) throw new Error(`cannot read row cell "${cells[i] ?? ""}"`);
      const key = `row.${caseId ?? ""}.${q ?? ""}.${who}`;
      put(`${key}.output`, cell[1] ?? "");
      put(`${key}.label`, cell[2] ?? "");
      if ((cell[3] ?? "").includes("cost missing")) put(`${key}.cost`, "missing");
    });
    return;
  }
  if (section === "Per answerer, whole file") {
    const who = first;
    header.forEach((name, i) => {
      const cell = cells[i] ?? "";
      if (name === "Rows") put(`file.${who}.rows`, cellFigure(cell).value);
      if (name === "Labelled") put(`file.${who}.labelled`, cellFigure(cell).value);
      if (name === "Accepted") put(`file.${who}.accepted`, cellFigure(cell).value);
      if (name.startsWith("Spend")) put(`file.${who}.spend`, cell.startsWith(INCOMPLETE) ? INCOMPLETE : cellFigure(cell).value);
    });
    return;
  }
  if (question !== "" && comparison !== "") {
    const metric = METRIC_BY_ROW.get(first);
    if (metric === undefined) throw new Error(`unknown row "${first}" in ${question}`);
    header.forEach((name, i) => {
      const who = ANSWERER_BY_HEADING.get(name);
      if (who === undefined) return;
      const { value, note } = cellFigure(cells[i] ?? "");
      put(`${question}.${comparison}.${who}.${metric}`, value);
      const rejects = /^rejects (.+)$/.exec(note);
      if (metric === "accepted" && rejects !== null) put(`${question}.${comparison}.${who}.rejects`, caseList(rejects[1] ?? "") ?? "");
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison

function canonical(value: number | string): string {
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

/** A computed number matches a stated one when it rounds to the stated text at the stated decimal places. */
function render(computed: number | string, expected: string): string {
  const decimals = /^-?\d+(?:\.(\d+))?$/.exec(expected);
  if (typeof computed === "string" || decimals === null || !Number.isFinite(computed)) return canonical(computed);
  const text = computed.toFixed((decimals[1] ?? "").length);
  return /^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text;
}

export function compareFigures(expected: ReadonlyMap<string, string>, computed: ReadonlyMap<string, Figure>): CheckResult {
  const mismatches: Mismatch[] = [];
  if (expected.size === 0) mismatches.push({ key: "(expected.md)", expected: "(no figures)", computed: `${computed.size} figures` });
  for (const [key, value] of expected) {
    const figure = computed.get(key);
    const got = figure === undefined ? "(not computed)" : render(figure.value, value);
    if (got !== value) mismatches.push({ key, expected: value, computed: got });
  }
  for (const [key, figure] of computed) {
    if (figure.required && !expected.has(key)) mismatches.push({ key, expected: "(not stated)", computed: canonical(figure.value) });
  }
  return { checked: expected.size, mismatches };
}

export function handCheck(recordsText: string, expectedText: string): CheckResult {
  return compareFigures(parseExpected(expectedText), computeFigures(loadRecords(recordsText)));
}

/** Every module specifier this source imports, re-exports, dynamically imports or requires. */
export function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
  return [...source.matchAll(pattern)].map((m) => m[1] ?? "");
}

if (import.meta.main) {
  const records = process.argv[2] ?? fileURLToPath(new URL("../examples/d06-tiny/records.csv", import.meta.url));
  const expected = process.argv[3] ?? fileURLToPath(new URL("../examples/d06-tiny/expected.md", import.meta.url));
  const result = handCheck(readFileSync(records, "utf8"), readFileSync(expected, "utf8"));
  for (const m of result.mismatches) console.log(`MISMATCH ${m.key}: expected ${m.expected}, computed ${m.computed}`);
  console.log(`checked=${result.checked} mismatches=${result.mismatches.length}`);
  process.exitCode = result.mismatches.length === 0 && result.checked > 0 ? 0 : 1;
}
