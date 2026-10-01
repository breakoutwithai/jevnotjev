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

/** A computed figure: a number, a text value, or a set of ids (compared as a set). */
export type FigureValue = number | string | readonly string[];

/** Required figures must be stated in expected.md; the rest are checked only when stated. */
export type Figure = { readonly value: FigureValue; readonly required: boolean };

export type Mismatch = { readonly key: string; readonly expected: string; readonly computed: string };

export type CheckResult = { readonly checked: number; readonly mismatches: readonly Mismatch[] };

const MIN_PAIRED = 30; // verdict-rules.md, Settings: minimum paired labelled cases
const INCOMPLETE = "incomplete";

// ---------------------------------------------------------------------------------------------
// CSV

/** RFC 4180 CSV. A quote is allowed only at the start of a field; malformed quoting throws. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false; // just read the closing quote of a quoted field
  const fail = (i: number, why: string): never => {
    throw new Error(`CSV: ${why} at offset ${i}`);
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else {
        field += ch;
      }
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
    } else if (closed) {
      fail(i, "text after a closing quote");
    } else if (ch === '"') {
      if (field !== "") fail(i, "quote inside an unquoted field");
      quoted = true;
    } else {
      field += ch;
    }
  }
  if (quoted) fail(text.length, "unterminated quote");
  if (field !== "" || closed || row.length > 0) {
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

type Totals = {
  accepted: number;
  rejects: string[];
  spend: number | typeof INCOMPLETE;
  /** case ids of rows with no cost */
  missing: string[];
  rows: number;
  /** the one cost every row carries, or null */
  unit: number | null;
};

function totalsOf(rows: readonly HandRecord[]): Totals {
  let accepted = 0;
  let sum = 0;
  const rejects: string[] = [];
  const missing: string[] = [];
  const costs = new Set<number>();
  for (const row of rows) {
    if (row.label === "accept") accepted += 1;
    if (row.label === "reject") rejects.push(row.caseId);
    if (row.cost === null) missing.push(row.caseId);
    else {
      sum += row.cost;
      costs.add(row.cost);
    }
  }
  const [only] = costs;
  const unit = missing.length === 0 && costs.size === 1 && only !== undefined ? only : null;
  return { accepted, rejects, spend: missing.length > 0 ? INCOMPLETE : sum, missing, rows: rows.length, unit };
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

type Pair = readonly [HandRecord, HandRecord];

export function computeFigures(records: readonly HandRecord[]): Map<string, Figure> {
  const figures = new Map<string, Figure>();
  const put = (key: string, value: FigureValue, required = true): void => {
    if (figures.has(key)) throw new Error(`figure ${key} computed twice`);
    figures.set(key, { value, required });
  };
  /** Spend and its operands (`n x unit`), and which rows are missing a cost when it is incomplete. */
  const putSpend = (prefix: string, t: Totals, required: boolean, missingIds: readonly string[]): void => {
    put(`${prefix}.spend`, t.spend, required || t.spend === INCOMPLETE);
    put(`${prefix}.spend.n`, t.rows, false);
    if (t.unit !== null) put(`${prefix}.spend.unit`, t.unit, false);
    if (t.spend === INCOMPLETE) put(`${prefix}.spend.missing`, missingIds);
  };

  const cases = distinct(records.map((r) => r.caseId));
  const questions = distinct(records.map((r) => r.questionId));
  const answerers = distinct(records.map((r) => r.answerer));
  put("file.cases", cases.length);
  put("file.questions", questions.length);
  put("file.answerers", answerers.length);
  put("file.rows", records.length);
  put("file.min_paired", MIN_PAIRED, false);
  put("file.unlabelled", records.filter((r) => r.label === "").map((r) => `${r.answerer} ${r.caseId} ${r.questionId}`));
  put("file.cost_missing", records.filter((r) => r.cost === null).map((r) => `${r.answerer} ${r.caseId} ${r.questionId}`));

  // Per answerer, whole file.
  for (const who of answerers) {
    const rows = records.filter((r) => r.answerer === who);
    const totals = totalsOf(rows);
    put(`file.${who}.rows`, rows.length);
    put(`file.${who}.labelled`, rows.filter((r) => r.label !== "").length);
    put(`file.${who}.accepted`, totals.accepted);
    putSpend(`file.${who}`, totals, true, rows.filter((r) => r.cost === null).map((r) => `${r.caseId} ${r.questionId}`));
    if (totals.unit !== null) put(`file.${who}.unit_cost`, totals.unit, false);
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
    let pairedJevLlm: Pair[] = [];
    let pairedRule: number | null = null;
    for (const other of ["llm", "rule"]) {
      if (!answerers.includes(other)) continue;
      const otherRows = labelled(records, other, q);
      const pairs: Pair[] = [];
      for (const [caseId, jevRow] of jevRows) {
        const otherRow = otherRows.get(caseId);
        if (otherRow !== undefined) pairs.push([jevRow, otherRow]);
      }
      const n = pairs.length;
      const prefix = `${q}.jev-${other}`;
      const isLlm = other === "llm";
      if (isLlm) pairedJevLlm = pairs;
      else pairedRule = n;
      const pairedIds = pairs.map(([j]) => j.caseId);
      const touched = distinct(records.filter((r) => r.questionId === q && (r.answerer === "jev" || r.answerer === other)).map((r) => r.caseId));
      const dropped = touched.filter((id) => !pairedIds.includes(id));
      put(`${prefix}.paired`, n);
      put(`${prefix}.paired.cases`, pairedIds, isLlm);
      put(`${prefix}.dropped.cases`, dropped, isLlm && dropped.length > 0);

      const sides: ReadonlyArray<readonly [string, Totals]> = [
        ["jev", totalsOf(pairs.map(([j]) => j))],
        [other, totalsOf(pairs.map(([, o]) => o))],
      ];
      for (const [who, t] of sides) {
        const side = `${prefix}.${who}`;
        put(`${side}.accepted`, t.accepted);
        put(`${side}.rejects`, t.rejects, false);
        if (n > 0) {
          put(`${side}.accept_rate`, t.accepted / n, isLlm);
          put(`${side}.accept_rate.num`, t.accepted, false);
          put(`${side}.accept_rate.den`, n, false);
        }
        putSpend(side, t, isLlm, t.missing);
        const cpa = costPerAccepted(t);
        if (cpa !== null && t.spend !== INCOMPLETE) {
          put(`${side}.cost_per_accepted`, cpa, isLlm);
          put(`${side}.cost_per_accepted.num`, t.spend, false);
          put(`${side}.cost_per_accepted.den`, t.accepted, false);
        }
      }
      const jevT = sides[0]?.[1];
      const otherT = sides[1]?.[1];
      if (isLlm && jevT !== undefined && otherT !== undefined) {
        const ratio = costRatio(jevT, otherT);
        if (ratio !== null) {
          put(`${prefix}.cost_ratio`, ratio);
          put(`${prefix}.cost_ratio.fraction`, ratio, false);
          const j = costPerAccepted(jevT);
          const l = costPerAccepted(otherT);
          if (j !== null) put(`${prefix}.cost_ratio.num`, j, false);
          if (l !== null) put(`${prefix}.cost_ratio.den`, l, false);
        }
      }

      // a = both accepted, b = Jev only, c = other only, d = both rejected.
      const cells: Record<"a" | "b" | "c" | "d", string[]> = { a: [], b: [], c: [], d: [] };
      for (const [j, o] of pairs) {
        const ja = j.label === "accept";
        const oa = o.label === "accept";
        cells[ja && oa ? "a" : ja ? "b" : oa ? "c" : "d"].push(j.caseId);
      }
      for (const [cell, ids] of Object.entries(cells)) {
        put(`${prefix}.${cell}`, ids.length);
        put(`${prefix}.${cell}.cases`, ids, false);
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
    const jevPaired = pairedJevLlm.map(([j]) => j);
    const llmPaired = pairedJevLlm.map(([, l]) => l);
    const noRows = !answerers.includes("jev") || !answerers.includes("llm");
    const bothZero = totalsOf(jevPaired).accepted === 0 && totalsOf(llmPaired).accepted === 0;
    const costMissing = [...jevPaired, ...llmPaired].some((r) => r.cost === null);
    if (!(noRows || n < MIN_PAIRED || bothZero || costMissing)) {
      throw new Error(`${q}: verdict rule 1 does not fire; rules 2 to 4 are outside this hand check`);
    }
    put(`${q}.verdict`, "not enough evidence");
    if (!noRows && n < MIN_PAIRED) {
      put(`${q}.verdict.paired`, n);
      put(`${q}.verdict.threshold`, MIN_PAIRED);
      put(`${q}.verdict.add_n`, MIN_PAIRED - n);
    }
    if (pairedRule !== null && pairedRule < MIN_PAIRED) put(`${q}.verdict.rule_skipped_paired`, pairedRule);
  }
  return figures;
}

// ---------------------------------------------------------------------------------------------
// Reading the figures out of expected.md

const ANSWERER_BY_NAME: ReadonlyMap<string, string> = new Map([
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
/** The operand form each metric is written in before its "=" (`4/5`, `5 x 0.00002`, `0.0001 / 4`), and the operand names. */
const OPERANDS: ReadonlyMap<string, readonly [RegExp, string, string]> = new Map([
  ["accept_rate", [/^(\d+)\/(\d+)$/, "num", "den"]],
  ["spend", [/^(\d+) x \$?([\d.]+)$/, "n", "unit"]],
  ["cost_per_accepted", [/^\$?([\d.]+) \/ (\d+)$/, "num", "den"]],
]);

type Put = (key: string, value: string) => void;

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c));
}

/** "cv1 to cv5" -> "cv1,cv2,cv3,cv4,cv5"; any other text is kept and compared as a comma list. */
function idList(text: string): string {
  const range = /^cv(\d+) to cv(\d+)$/.exec(text.trim());
  if (range === null) return text.trim();
  const ids: string[] = [];
  for (let i = Number(range[1]); i <= Number(range[2]); i += 1) ids.push(`cv${i}`);
  return ids.join(",");
}

/**
 * A metric cell: `[operands =] value [(note)]`. The value goes to `key`, operands to `key.<name>`.
 * An operand form this reader does not know goes to `key.expr`, which has no computed counterpart
 * and so is always a mismatch. Returns the note for the caller to place.
 */
function putMetric(key: string, metric: string, cell: string, put: Put): string {
  const terms = cell.split("=").map((t) => t.trim());
  const last = terms.pop() ?? "";
  const match = /^\$?(\S+)(?:\s+\((.*)\))?$/.exec(last);
  if (match === null || match[1] === undefined) {
    put(`${key}.expr`, cell);
    return "";
  }
  put(key, match[1]);
  const form = OPERANDS.get(metric);
  for (const term of terms) {
    const operands = form === undefined ? null : form[0].exec(term);
    if (operands === null || form === undefined) put(`${key}.expr`, term);
    else {
      put(`${key}.${form[1]}`, operands[1] ?? "");
      put(`${key}.${form[2]}`, operands[2] ?? "");
    }
  }
  return match[2] ?? "";
}

/** "(cv5 q2 missing)" / "(cv5 missing)": the rows whose cost is missing. */
function putMissing(key: string, note: string, put: Put): void {
  const missing = /^(.+) missing$/.exec(note);
  if (missing === null) put(`${key}.note`, note);
  else put(`${key}.missing`, missing[1] ?? "");
}

export function parseExpected(markdown: string): Map<string, string> {
  const figures = new Map<string, string>();
  const put: Put = (key, value) => {
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
      const who = ANSWERER_BY_NAME.get(unit[2] ?? "");
      if (who !== undefined) put(`file.${who}.unit_cost`, unit[1] ?? "");
    }
    const noLabel: string[] = [];
    const noCost: string[] = [];
    for (const gap of line.matchAll(/the (\w+) row for (cv\d+) (q\d+) has no (label|cost)/g)) {
      const who = ANSWERER_BY_NAME.get(gap[1] ?? "") ?? gap[1] ?? "";
      (gap[4] === "label" ? noLabel : noCost).push(`${who} ${gap[2] ?? ""} ${gap[3] ?? ""}`);
    }
    if (noLabel.length > 0) put("file.unlabelled", noLabel.join(","));
    if (noCost.length > 0) put("file.cost_missing", noCost.join(","));
    const minimum = /fixture of (\d+) or more cases/.exec(line);
    if (minimum !== null) put("file.min_paired", minimum[1] ?? "");

    if (line.startsWith("|")) {
      const cells = splitRow(line);
      if (isDelimiterRow(cells)) continue;
      if (header === null) {
        header = cells;
        continue;
      }
      parseTableRow(section, question, comparison, header, cells, put);
      continue;
    }
    header = null;
    if (question === "") continue;

    const against = /^\*\*Jev against the (LLM|rule):\*\*\s+(\d+) paired cases(?: \(([^)]*)\))?/.exec(line);
    if (against !== null) {
      comparison = `jev-${(against[1] ?? "").toLowerCase()}`;
      put(`${question}.${comparison}.paired`, against[2] ?? "");
      if (against[3] !== undefined) {
        const [ids, ...rest] = against[3].split(";");
        put(`${question}.${comparison}.paired.cases`, idList(ids ?? ""));
        for (const part of rest) {
          const drop = /^(cv\d+(?:, cv\d+)*) drops? out\b/.exec(part.trim());
          if (drop === null) put(`${question}.${comparison}.paired.note`, part.trim());
          else put(`${question}.${comparison}.dropped.cases`, drop[1] ?? "");
        }
      }
    }
    const verdict = /^\*\*Verdict: ([^.*]+)\.\*\*/.exec(line);
    if (verdict !== null) {
      comparison = "";
      put(`${question}.verdict`, verdict[1] ?? "");
      const paired = /Rule 1: (\d+) paired Jev and LLM cases/.exec(line);
      if (paired !== null) put(`${question}.verdict.paired`, paired[1] ?? "");
      const threshold = /fewer than (\d+)/.exec(line);
      if (threshold !== null) put(`${question}.verdict.threshold`, threshold[1] ?? "");
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
    const ratio = /Cost ratio = ([^*]*)\*\*([^*]+)\*\*/.exec(line);
    if (ratio !== null) {
      const terms = [...(ratio[1] ?? "").split("="), ...(ratio[2] ?? "").split("=")].map((t) => t.trim()).filter((t) => t !== "");
      put(`${prefix}.cost_ratio`, terms.pop() ?? "");
      for (const term of terms) {
        const operands = /^(\d*\.\d+) \/ (\d*\.\d+)$/.exec(term);
        if (operands !== null) {
          put(`${prefix}.cost_ratio.num`, operands[1] ?? "");
          put(`${prefix}.cost_ratio.den`, operands[2] ?? "");
        } else if (/^\d+\/\d+$/.test(term)) put(`${prefix}.cost_ratio.fraction`, term);
        else put(`${prefix}.cost_ratio.expr`, term);
      }
    }
    // Every "(...)" after a cell count is its case list; anything that is not the right set of ids mismatches.
    for (const cell of line.matchAll(/\b([abcd]) (?:\([^)]*\) )?= (\d+)(?: \(([^)]*)\))?/g)) {
      put(`${prefix}.${cell[1] ?? ""}`, cell[2] ?? "");
      if (cell[3] !== undefined) put(`${prefix}.${cell[1] ?? ""}.cases`, cell[3]);
    }
    const jevMinusLlm = /Jev minus LLM = \*\*(-?[\d.]+)\*\*/.exec(line);
    if (jevMinusLlm !== null) put(`${question}.jev-llm.diff`, jevMinusLlm[1] ?? "");
    const ruleMinusJev = /Rule minus Jev = \*\*(-?[\d.]+)\*\*/.exec(line);
    if (ruleMinusJev !== null) put(`${question}.jev-rule.diff`, ruleMinusJev[1] ?? "");
    const ruleSpend = /Rule spend is incomplete(?: \(([^)]*)\))?/.exec(line);
    if (ruleSpend !== null) {
      put(`${question}.jev-rule.rule.spend`, INCOMPLETE);
      if (ruleSpend[1] !== undefined) putMissing(`${question}.jev-rule.rule.spend`, ruleSpend[1], put);
    }
  }
  return figures;
}

function parseTableRow(section: string, question: string, comparison: string, header: readonly string[], cells: readonly string[], put: Put): void {
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
      const who = ANSWERER_BY_NAME.get(name);
      if (who === undefined) return;
      const key = `row.${caseId ?? ""}.${q ?? ""}.${who}`;
      const cell = /^(\S+) ([AR-])(?: \((.*)\))?$/.exec(cells[i] ?? "");
      if (cell === null) {
        put(`${key}.note`, cells[i] ?? "");
        return;
      }
      put(`${key}.output`, cell[1] ?? "");
      put(`${key}.label`, cell[2] ?? "");
      const note = cell[3];
      if (note === "cost missing") put(`${key}.cost`, "missing");
      else if (!(note === undefined || (note === "unlabelled" && cell[2] === "-"))) put(`${key}.note`, note);
    });
    return;
  }
  if (section === "Per answerer, whole file") {
    const who = first;
    header.forEach((name, i) => {
      const cell = cells[i] ?? "";
      const metric = name === "Rows" ? "rows" : name === "Labelled" ? "labelled" : name === "Accepted" ? "accepted" : name.startsWith("Spend") ? "spend" : "";
      if (metric === "") return;
      if (metric === "spend" && cell.startsWith(INCOMPLETE)) {
        put(`file.${who}.spend`, INCOMPLETE);
        const note = /^incomplete(?: \((.*)\))?$/.exec(cell);
        if (note === null) put(`file.${who}.spend.note`, cell);
        else if (note[1] !== undefined) putMissing(`file.${who}.spend`, note[1], put);
        return;
      }
      const note = putMetric(`file.${who}.${metric}`, metric, cell, put);
      if (note !== "") put(`file.${who}.${metric}.note`, note);
    });
    return;
  }
  if (question !== "" && comparison !== "") {
    const metric = METRIC_BY_ROW.get(first);
    if (metric === undefined) throw new Error(`unknown row "${first}" in ${question}`);
    header.forEach((name, i) => {
      const who = ANSWERER_BY_NAME.get(name);
      if (who === undefined) return;
      const key = `${question}.${comparison}.${who}.${metric}`;
      const note = putMetric(key, metric, cells[i] ?? "", put);
      const rejects = /^rejects (.+)$/.exec(note);
      if (metric === "accepted" && rejects !== null) put(`${question}.${comparison}.${who}.rejects`, rejects[1] ?? "");
      else if (note !== "") put(`${key}.note`, note);
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Comparison

function sortedIds(values: readonly string[]): string {
  return [...values].map((v) => v.trim()).sort().join(",");
}

function canonical(value: FigureValue): string {
  if (typeof value === "string") return value;
  if (typeof value !== "number") return sortedIds(value);
  if (!Number.isFinite(value)) return String(value);
  return String(Number(value.toPrecision(12)));
}

/** A stated number: a decimal or a fraction like 1/80. */
function statedNumber(text: string): number | null {
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const fraction = /^(\d+)\/(\d+)$/.exec(text);
  return fraction === null ? null : Number(fraction[1]) / Number(fraction[2]);
}

/**
 * Fixed precision, never taken from the stated text: equal within 1e-9 relative, or equal to the
 * computed value rounded to 3 significant figures (how expected.md writes 0.0000267 and 0.00267).
 */
function sameNumber(stated: number, computed: number): boolean {
  if (stated === computed) return true;
  if (!Number.isFinite(computed)) return false;
  if (Math.abs(stated - computed) <= 1e-9 * Math.max(Math.abs(stated), Math.abs(computed))) return true;
  return Number(computed.toPrecision(3)) === stated;
}

function matches(expected: string, computed: FigureValue): boolean {
  if (typeof computed !== "number" && typeof computed !== "string") return sortedIds(expected.split(",")) === sortedIds(computed);
  const stated = statedNumber(expected);
  if (stated !== null) return typeof computed === "number" && sameNumber(stated, computed);
  return expected === computed;
}

export function compareFigures(expected: ReadonlyMap<string, string>, computed: ReadonlyMap<string, Figure>): CheckResult {
  const mismatches: Mismatch[] = [];
  if (expected.size === 0) mismatches.push({ key: "(expected.md)", expected: "(no figures)", computed: `${computed.size} figures` });
  for (const [key, value] of expected) {
    const figure = computed.get(key);
    if (figure === undefined) mismatches.push({ key, expected: value, computed: "(no computed value)" });
    else if (!matches(value, figure.value)) mismatches.push({ key, expected: value, computed: canonical(figure.value) });
  }
  for (const [key, figure] of computed) {
    if (figure.required && !expected.has(key)) mismatches.push({ key, expected: "(not stated)", computed: canonical(figure.value) });
  }
  return { checked: expected.size, mismatches };
}

export function handCheck(recordsText: string, expectedText: string): CheckResult {
  return compareFigures(parseExpected(expectedText), computeFigures(loadRecords(recordsText)));
}

/** Every module specifier this source imports statically, re-exports, or imports for side effects. */
export function importSpecifiers(source: string): string[] {
  const pattern = /(?:\bfrom\s*|^\s*import\s+)["']([^"']+)["']/gm;
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
