// D15 (PR B): the "check the math by hand" workbook. Six sheets: Summary, Cases, Hand, App, Compare, Coverage.
// Hand recomputes every figure with spreadsheet formulas over the Cases sheet, from
// docs/decision/verdict-rules.md "Formulas"; App holds the app's figures exactly as `scripts/math-check.ts --json`
// read them from the verdict command; Compare sets the two side by side. Nothing here computes a figure in
// TypeScript, and no formula cell carries a cached value: a spreadsheet engine computes them all on open
// (`fullCalcOnLoad`). The zip and the XML are written by hand with node:zlib only.

import { crc32, deflateRawSync } from "node:zlib";
import { parseCsv } from "../../scripts/math-check.ts";

// ---------------------------------------------------------------------------------------------
// The math-check report, as read from its --json stdout

export type ReportFigure = {
  readonly key: string;
  readonly group: string;
  /** The app's value as math-check read it from the verdict command: a number, text, a list or null. */
  readonly app: unknown;
  readonly tolerance: string;
};

export type MathCheckReport = {
  readonly source: string;
  readonly n: number;
  readonly selection_rule: string;
  readonly compared: number;
  readonly mismatches: number;
  readonly figures: readonly ReportFigure[];
};

export class WorkbookError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The fields of math-check's --json report the workbook reads; anything else is refused. */
export function parseReport(json: unknown): MathCheckReport {
  if (!isRecord(json)) throw new WorkbookError("math-check report is not an object");
  const { source, n, selection_rule: rule, compared, mismatches, figures } = json;
  if (typeof source !== "string" || typeof n !== "number" || typeof rule !== "string" || typeof compared !== "number" || typeof mismatches !== "number" || !Array.isArray(figures)) {
    throw new WorkbookError("math-check report lacks source, n, selection_rule, compared, mismatches or figures");
  }
  const out: ReportFigure[] = figures.map((f: unknown, i: number) => {
    if (!isRecord(f) || typeof f.key !== "string" || typeof f.group !== "string" || typeof f.tolerance !== "string") {
      throw new WorkbookError(`math-check report: figures[${i}] lacks key, group or tolerance`);
    }
    return { key: f.key, group: f.group, app: f.app, tolerance: f.tolerance };
  });
  return { source, n, selection_rule: rule, compared, mismatches, figures: out };
}

// ---------------------------------------------------------------------------------------------
// Zip (deflate), written by hand

export type ZipEntry = { readonly name: string; readonly data: Uint8Array };

/** A zip archive of `entries`, deflated, with a fixed 1980-01-01 timestamp so the same input gives the same bytes. */
export function zip(entries: readonly ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const body = new Uint8Array(deflateRawSync(entry.data));
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 8, true);
    lv.setUint16(10, 0, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, body);
    centrals.push(central);
    offset += local.length + body.length;
  }
  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cells and sheets

/** A cell: text, a number, a formula (no leading `=`, never with a cached value), or empty. */
export type Cell = { readonly text: string } | { readonly num: number } | { readonly formula: string } | null;

const text = (value: string): Cell => ({ text: value });
const num = (value: number): Cell => ({ num: value });
const formula = (value: string): Cell => ({ formula: value });

/** Column letters for a 0-based index: 0 is A, 26 is AA. */
export function columnName(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** XML 1.0 refuses most control characters; a records file carrying one is refused rather than altered. */
function checkXmlText(value: string, where: string): void {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(value)) throw new WorkbookError(`${where} holds a control character an xlsx cannot store`);
}

function cellXml(ref: string, cell: Cell): string {
  if (cell === null) return "";
  if ("formula" in cell) return `<c r="${ref}"><f>${escapeXml(cell.formula)}</f></c>`;
  if ("num" in cell) {
    if (!Number.isFinite(cell.num)) throw new WorkbookError(`${ref}: ${cell.num} is not a finite number`);
    return `<c r="${ref}"><v>${String(cell.num)}</v></c>`;
  }
  checkXmlText(cell.text, ref);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.text)}</t></is></c>`;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function sheetXml(rows: readonly (readonly Cell[])[], widths: readonly number[]): string {
  const cols = widths.length === 0 ? "" : `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => cellXml(`${columnName(c)}${r + 1}`, cell)).join("")}</row>`)
    .join("");
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${cols}<sheetData>${body}</sheetData></worksheet>`;
}

// ---------------------------------------------------------------------------------------------
// Cases: the selected rows, raw, with formula helper columns

type CasesLayout = {
  /** Absolute range of a raw column (by CSV name) or a helper column (by helper name), rows 2 to the last row. */
  readonly range: (column: string) => string;
};

/** The CSV columns the formulas match on. */
const KEY_COLUMNS = ["run_id", "prompt_version", "question_id", "case_id"];

type Helper = { readonly name: string; readonly formula: (r: number) => string };

export type Selected = { readonly header: readonly string[]; readonly rows: ReadonlyArray<{ readonly line: number; readonly cells: readonly string[] }>; readonly cases: number };

/**
 * The rows the check reads: the whole file, or every row of the last N distinct case_id values in order of first
 * appearance (math-check's selection rule). Line numbers count the header as line 1, like math-check's messages.
 */
export function selectRows(records: string, last: number | null): Selected {
  const all = parseCsv(records.charCodeAt(0) === 0xfeff ? records.slice(1) : records);
  const [header, ...body] = all;
  if (header === undefined || body.length === 0) throw new WorkbookError("records file has no data rows");
  const caseAt = header.indexOf("case_id");
  if (caseAt < 0) throw new WorkbookError("records file has no case_id column");
  const order = [...new Set(body.map((cells) => cells[caseAt] ?? ""))];
  if (last !== null && order.length < last) throw new WorkbookError(`fewer than ${last} cases: the file has ${order.length}`);
  const keep = new Set(last === null ? order : order.slice(order.length - last));
  const rows = body.map((cells, i) => ({ line: i + 2, cells })).filter((row) => keep.has(row.cells[caseAt] ?? ""));
  return { header, rows, cases: keep.size };
}

/**
 * A spreadsheet compares text without regard to letter case; two ids that differ only in case would merge in the
 * Hand formulas, so such a file is refused rather than checked wrongly.
 */
function checkIdsDistinctByCase(selected: Selected): void {
  for (const name of KEY_COLUMNS) {
    const at = selected.header.indexOf(name);
    if (at < 0) throw new WorkbookError(`records file has no ${name} column`);
    const seen = new Map<string, string>();
    for (const row of selected.rows) {
      const value = row.cells[at] ?? "";
      const folded = value.toLowerCase();
      const first = seen.get(folded);
      if (first !== undefined && first !== value) throw new WorkbookError(`${name} values "${first}" and "${value}" differ only in letter case`);
      seen.set(folded, value);
    }
  }
}

const HELPERS = ["Included", "Accepted", "Cost blank", "LLM rows", "LLM included", "LLM accepted", "LLM cost", "LLM cost blank", "Paired with LLM", "Rule included", "Rule accepted", "Paired with rule"];

function casesSheet(selected: Selected): { readonly rows: Cell[][]; readonly layout: CasesLayout } {
  const header = selected.header;
  const raw = (name: string): string => {
    const at = header.indexOf(name);
    if (at < 0) throw new WorkbookError(`records file has no ${name} column`);
    return columnName(at + 1);
  };
  const last = selected.rows.length + 1;
  const local = (column: string): string => `$${column}$2:$${column}$${last}`;
  const col = (name: string): string => columnName(header.length + 1 + HELPERS.indexOf(name));
  const run = raw("run_id");
  const pv = raw("prompt_version");
  const q = raw("question_id");
  const cs = raw("case_id");
  const who = raw("answerer");
  const label = raw("label");
  const source = raw("label_source");
  const cost = raw("cost_usd");
  /** Rows of `answerer` for this row's run, prompt version, question and case, times an optional column. */
  const sameCase = (r: number, answerer: string, times: string | null): string =>
    `SUMPRODUCT((${local(run)}=$${run}${r})*(${local(pv)}=$${pv}${r})*(${local(q)}=$${q}${r})*(${local(cs)}=$${cs}${r})*(${local(who)}="${answerer}")${times === null ? "" : `*${local(times)}`})`;
  const helpers: Helper[] = [
    { name: "Included", formula: (r) => `IF(AND($${label}${r}<>"",$${source}${r}<>"agent"),1,0)` },
    { name: "Accepted", formula: (r) => `IF(AND($${col("Included")}${r}=1,$${label}${r}="accept"),1,0)` },
    { name: "Cost blank", formula: (r) => `IF(ISNUMBER($${cost}${r}),0,1)` },
    { name: "LLM rows", formula: (r) => sameCase(r, "llm", null) },
    { name: "LLM included", formula: (r) => sameCase(r, "llm", col("Included")) },
    { name: "LLM accepted", formula: (r) => sameCase(r, "llm", col("Accepted")) },
    { name: "LLM cost", formula: (r) => sameCase(r, "llm", cost) },
    { name: "LLM cost blank", formula: (r) => sameCase(r, "llm", col("Cost blank")) },
    { name: "Paired with LLM", formula: (r) => `IF(AND($${who}${r}="jev",$${col("Included")}${r}=1,$${col("LLM included")}${r}>0),1,0)` },
    { name: "Rule included", formula: (r) => sameCase(r, "rule", col("Included")) },
    { name: "Rule accepted", formula: (r) => sameCase(r, "rule", col("Accepted")) },
    { name: "Paired with rule", formula: (r) => `IF(AND($${who}${r}="jev",$${col("Included")}${r}=1,$${col("Rule included")}${r}>0),1,0)` },
  ];
  const costAt = header.indexOf("cost_usd");
  const rows: Cell[][] = [[text("Source line"), ...header.map(text), ...helpers.map((h) => text(`${h.name} (formula)`))]];
  for (const [i, row] of selected.rows.entries()) {
    const r = i + 2;
    const cells: Cell[] = [num(row.line)];
    header.forEach((name, c) => {
      const value = row.cells[c] ?? "";
      checkXmlText(value, `records line ${row.line} ${name}`);
      if (value === "") cells.push(null);
      else if (c === costAt && /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(value.trim())) cells.push(num(Number(value.trim())));
      else cells.push(text(value));
    });
    for (const h of helpers) cells.push(formula(h.formula(r)));
    rows.push(cells);
  }
  const range = (column: string): string => `Cases!${local(HELPERS.includes(column) ? col(column) : raw(column))}`;
  return { rows, layout: { range } };
}

// ---------------------------------------------------------------------------------------------
// Hand: every figure as a formula over Cases

type Cohort = { readonly runId: string; readonly promptVersion: string; readonly questionId: string; readonly prefix: string };

/** The (run_id, prompt_version, question_id) cohorts in order of first appearance, with math-check's key prefix. */
function cohortsOf(selected: Selected): Cohort[] {
  const at = (name: string): number => selected.header.indexOf(name);
  const seen = new Map<string, { runId: string; promptVersion: string; questionId: string }>();
  for (const row of selected.rows) {
    const runId = row.cells[at("run_id")] ?? "";
    const promptVersion = row.cells[at("prompt_version")] ?? "";
    const questionId = row.cells[at("question_id")] ?? "";
    const id = JSON.stringify([runId, promptVersion, questionId]);
    if (!seen.has(id)) seen.set(id, { runId, promptVersion, questionId });
  }
  const list = [...seen.values()];
  const single = new Set(list.map((c) => JSON.stringify([c.runId, c.promptVersion]))).size === 1;
  return list.map((c) => ({ ...c, prefix: single ? c.questionId : `${c.runId}/${c.promptVersion}/${c.questionId}` }));
}

type HandSheet = { readonly rows: Cell[][]; readonly rowOf: ReadonlyMap<string, number> };

export const NO_FORMULA = "no formula for this figure";

function handSheet(cohorts: readonly Cohort[], keys: readonly string[], cases: CasesLayout): HandSheet {
  const rows: Cell[][] = [[text("Figure"), text("Value (formula)"), text("How"), text("run_id"), text("prompt_version"), text("question_id"), text("case_id")]];
  const rowOf = new Map<string, number>();
  const add = (name: string, f: Cell, how: string, cohort: Cohort | null, caseId = ""): string => {
    const r = rows.length + 1;
    const ids: Cell[] = cohort === null ? [null, null, null] : [text(cohort.runId), text(cohort.promptVersion), text(cohort.questionId)];
    rows.push([text(name), f, text(how), ...ids, caseId === "" ? null : text(caseId)]);
    rowOf.set(name, r);
    return `$B$${r}`;
  };
  const z = add("z", formula("NORMSINV(0.975)"), "0.975 quantile of the standard normal: a two-sided 95% interval", null);
  const keySet = new Set(keys);

  for (const cohort of cohorts) {
    const p = cohort.prefix;
    const mine = keys.filter((k) => k.startsWith(`${p}:`));
    if (mine.length === 0) continue;
    rows.push([text(`Question ${cohort.questionId} (run ${cohort.runId}, prompt ${cohort.promptVersion})`)]);
    const match = (r: number, caseCell: boolean): string =>
      `(${cases.range("run_id")}=$D$${r})*(${cases.range("prompt_version")}=$E$${r})*(${cases.range("question_id")}=$F$${r})${caseCell ? `*(${cases.range("case_id")}=$G$${r})` : ""}`;
    /** Rows of answerer `who` in this cohort (the row's own D:F cells, and G for one case), times Cases columns. */
    const mask = (r: number, who: string, extra: readonly string[], caseCell = false): string =>
      `SUMPRODUCT(${match(r, caseCell)}*(${cases.range("answerer")}="${who}")${extra.map((e) => `*${cases.range(e)}`).join("")})`;
    const def = (path: string, build: (r: number) => string, how: string, caseId = ""): string => add(`${p}:${path}`, formula(build(rows.length + 1)), how, cohort, caseId);
    const has = (path: string): boolean => keySet.has(`${p}:${path}`);
    const hasAny = (start: string): boolean => mine.some((k) => k.startsWith(`${p}:${start}`));

    /** Newcombe method 10 for p1 - p2 on paired cells a, b, c, d (verdict-rules.md "Formulas"). */
    const newcombe = (base: string, n: string, a: string, b: string, c: string, d: string, first: string, second: string): void => {
      const p1 = def(`${base}.p1`, () => `(${a}+${b})/${n}`, `(a + b) / n: ${first} accept rate`);
      const p2 = def(`${base}.p2`, () => `(${a}+${c})/${n}`, `(a + c) / n: ${second} accept rate`);
      def(`${base}.diff`, () => `${p1}-${p2}`, "p1 - p2");
      const wilson = (x: string, pr: string, which: "lower" | "upper"): string => {
        const centre = `${pr}+${z}^2/(2*${n})`;
        const half = `${z}*SQRT(${pr}*(1-${pr})/${n}+${z}^2/(4*${n}^2))`;
        const den = `(1+${z}^2/${n})`;
        return which === "lower" ? `IF(${x}=0,0,(${centre}-${half})/${den})` : `IF(${x}=${n},1,(${centre}+${half})/${den})`;
      };
      const l1 = def(`${base}.wilson1.lower`, () => wilson(`(${a}+${b})`, p1, "lower"), "Wilson 95% lower bound of p1 (0 when a + b is 0)");
      const u1 = def(`${base}.wilson1.upper`, () => wilson(`(${a}+${b})`, p1, "upper"), "Wilson 95% upper bound of p1 (1 when a + b is n)");
      const l2 = def(`${base}.wilson2.lower`, () => wilson(`(${a}+${c})`, p2, "lower"), "Wilson 95% lower bound of p2");
      const u2 = def(`${base}.wilson2.upper`, () => wilson(`(${a}+${c})`, p2, "upper"), "Wilson 95% upper bound of p2");
      const root = `SQRT((${a}+${b})*(${c}+${d})*(${a}+${c})*(${b}+${d}))`;
      const raw = `(${a}*${d}-${b}*${c})`;
      const phi = def(
        `${base}.phi`,
        () => `IF(${root}=0,0,IF(${raw}>0,MAX(${raw}-${n}/2,0),${raw})/${root})`,
        "(a*d - b*c) / sqrt((a+b)(c+d)(a+c)(b+d)), with a*d - b*c reduced by n/2 (not below 0) when positive; 0 when the root is 0",
      );
      const dl1 = `(${p1}-${l1})`;
      const du1 = `(${u1}-${p1})`;
      const dl2 = `(${p2}-${l2})`;
      const du2 = `(${u2}-${p2})`;
      def(`${base}.lower`, () => `(${p1}-${p2})-SQRT(MAX(${dl1}^2-2*${phi}*${dl1}*${du2}+${du2}^2,0))`, "Newcombe method 10 lower bound of p1 - p2");
      def(`${base}.upper`, () => `(${p1}-${p2})+SQRT(MAX(${du1}^2-2*${phi}*${du1}*${dl2}+${dl2}^2,0))`, "Newcombe method 10 upper bound of p1 - p2");
    };

    if (hasAny("numbers.")) {
      const base = "numbers.jevVsLlm";
      const jevRows = def(`${base}.jev rows`, (r) => mask(r, "jev", []), "Jev rows in this question");
      const llmRows = def(`${base}.llm rows`, (r) => mask(r, "llm", []), "LLM rows in this question");
      const both = def(`${base}.cases with both rows`, (r) => `SUMPRODUCT(${match(r, false)}*(${cases.range("answerer")}="jev")*(${cases.range("LLM rows")}>0))`, "Cases with both a Jev and an LLM row, labelled or not");
      const n = def(`${base}.n`, (r) => mask(r, "jev", ["Paired with LLM"]), "Paired cases: Jev and the LLM both have an included row");
      def(`${base}.excluded`, () => `${jevRows}+${llmRows}-${both}-${n}`, "Cases with a Jev or LLM row that are not paired");
      const jAcc = def(`${base}.jev.accepted`, (r) => mask(r, "jev", ["Paired with LLM", "Accepted"]), "Accepted Jev rows on the paired cases");
      const oAcc = def(`${base}.otherArm.accepted`, (r) => mask(r, "jev", ["Paired with LLM", "LLM accepted"]), "Accepted LLM rows on the paired cases");
      def(`${base}.jev.acceptRate`, () => `${jAcc}/${n}`, "accepted / n");
      def(`${base}.otherArm.acceptRate`, () => `${oAcc}/${n}`, "accepted / n");
      const spendHow = "sum of cost_usd over the paired rows, blank costs add 0 (arithmetic only, not tied to a bill)";
      const jSpend = def(`${base}.jev.spend`, (r) => mask(r, "jev", ["Paired with LLM", "cost_usd"]), `Jev ${spendHow}`);
      const oSpend = def(`${base}.otherArm.spend`, (r) => mask(r, "jev", ["Paired with LLM", "LLM cost"]), `LLM ${spendHow}`);
      const jMiss = def(`${base}.jev.spend.missing`, (r) => mask(r, "jev", ["Paired with LLM", "Cost blank"]), "Paired Jev rows with no cost");
      const oMiss = def(`${base}.otherArm.spend.missing`, (r) => mask(r, "jev", ["Paired with LLM", "LLM cost blank"]), "Paired LLM rows with no cost");
      const cpaHow = "spend / accepted: undefined at 0 accepted, incomplete when a cost is missing";
      const jCpa = def(`${base}.jev.costPerAccepted.usd`, () => `IF(${jMiss}>0,"incomplete",IF(${jAcc}=0,"undefined",${jSpend}/${jAcc}))`, cpaHow);
      const oCpa = def(`${base}.otherArm.costPerAccepted.usd`, () => `IF(${oMiss}>0,"incomplete",IF(${oAcc}=0,"undefined",${oSpend}/${oAcc}))`, cpaHow);
      const spends: ReadonlyArray<readonly [string, string]> = [["jev", jSpend], ["otherArm", oSpend]];
      for (const [side, spend] of spends) {
        if (has(`${base}.${side}.spend.usd`)) def(`${base}.${side}.spend.usd`, () => spend, "spend, every paired cost known (arithmetic only, not tied to a bill)");
        if (has(`${base}.${side}.spend.knownUsd`)) def(`${base}.${side}.spend.knownUsd`, () => spend, "sum of the known paired costs, one or more missing (arithmetic only, not tied to a bill)");
      }
      const a = def(`${base}.a`, (r) => mask(r, "jev", ["Paired with LLM", "Accepted", "LLM accepted"]), "a: both accepted");
      const b = def(`${base}.b`, (r) => `${mask(r, "jev", ["Paired with LLM", "Accepted"])}-${mask(r, "jev", ["Paired with LLM", "Accepted", "LLM accepted"])}`, "b: Jev accepted, LLM rejected");
      const c = def(`${base}.c`, (r) => `${mask(r, "jev", ["Paired with LLM", "LLM accepted"])}-${mask(r, "jev", ["Paired with LLM", "Accepted", "LLM accepted"])}`, "c: LLM accepted, Jev rejected");
      const d = def(`${base}.d`, () => `${n}-${a}-${b}-${c}`, "d: both rejected (n - a - b - c)");
      def(`${base}.wins`, () => b, "b");
      def(`${base}.losses`, () => c, "c");
      def(`${base}.ties`, () => `${a}+${d}`, "a + d");
      def("numbers.jevAccepted", () => jAcc, "Jev accepted on the paired cases");
      def("numbers.llmAccepted", () => oAcc, "LLM accepted on the paired cases");
      for (const key of mine) {
        const m = /^numbers\.jevVsLlm\.cases\[(.+)\]\.(jevCostUsd|otherCostUsd)$/.exec(key.slice(p.length + 1));
        if (m === null) continue;
        const caseId = m[1] ?? "";
        const leaf = m[2] ?? "";
        const column = leaf === "jevCostUsd" ? "cost_usd" : "LLM cost";
        def(`${base}.cases[${caseId}].${leaf}`, (r) => mask(r, "jev", ["Paired with LLM", column], true), `${leaf === "jevCostUsd" ? "Jev" : "LLM"} cost of paired case ${caseId}`, caseId);
      }
      if (has(`${base}.p1`)) newcombe(base, n, a, b, c, d, "Jev", "LLM");
      if (has("addN")) def("addN", () => `30-${n}`, "30 minus the paired count (rule 1)");
      if (has("numbers.costRatio.ratio")) {
        const ratio = def("numbers.costRatio.ratio", () => `IF(${oAcc}=0,0,${jCpa}/${oCpa})`, "cost per accepted (Jev) / cost per accepted (LLM); 0 when the LLM has 0 accepted");
        def("numbers.costRatio.resamples", () => "2000", "2,000 resamples, a constant of verdict-rules.md \"Cost ratio interval\"");
        def("numbers.costRatio.lower", () => ratio, "partial: the hand ratio, which the app's bootstrap lower bound must not exceed (seed not printed, #168)");
        def("numbers.costRatio.upper", () => ratio, "partial: the hand ratio, which the app's bootstrap upper bound must not fall below (seed not printed, #168)");
      }
    }

    if (hasAny("ruleComparison.")) {
      const base = "ruleComparison";
      const n = def(`${base}.n`, (r) => mask(r, "jev", ["Paired with rule"]), "Cases where Jev and the rule both have an included row");
      if (has(`${base}.paired`)) def(`${base}.paired`, () => n, "Paired count, when fewer than 30 pair");
      if (has(`${base}.a`)) {
        const both = (r: number): string => mask(r, "jev", ["Paired with rule", "Accepted", "Rule accepted"]);
        const a = def(`${base}.a`, both, "a: both accepted");
        const b = def(`${base}.b`, (r) => `${mask(r, "jev", ["Paired with rule", "Rule accepted"])}-${both(r)}`, "b: rule accepted, Jev rejected (rule first)");
        const c = def(`${base}.c`, (r) => `${mask(r, "jev", ["Paired with rule", "Accepted"])}-${both(r)}`, "c: Jev accepted, rule rejected");
        const d = def(`${base}.d`, () => `${n}-${a}-${b}-${c}`, "d: both rejected");
        newcombe(base, n, a, b, c, d, "rule", "Jev");
      }
    }
  }
  // A figure the writer has no formula for gets a visible row with no value, so Compare says ERROR for it.
  for (const key of keys) if (!rowOf.has(key)) add(key, text(NO_FORMULA), "math-check compares this figure; the workbook has no formula for it", null);
  return { rows, rowOf };
}

// ---------------------------------------------------------------------------------------------
// App, Compare, Summary, Coverage

type ToleranceKind = "abs" | "rel" | "bound-lower" | "bound-upper";

function toleranceOf(f: ReportFigure): { readonly kind: ToleranceKind; readonly value: number } {
  const m = /(\d+(?:\.\d+)?e[-+]?\d+)\s*$/i.exec(f.tolerance);
  if (m === null) throw new WorkbookError(`figure ${f.key}: no tolerance number in "${f.tolerance}"`);
  const value = Number(m[1]);
  if (f.tolerance.startsWith("abs ")) return { kind: "abs", value };
  if (f.tolerance.startsWith("rel ")) return { kind: "rel", value };
  if (f.tolerance.startsWith("0 <= lower")) return { kind: f.key.endsWith(".upper") ? "bound-upper" : "bound-lower", value };
  throw new WorkbookError(`figure ${f.key}: unknown tolerance "${f.tolerance}"`);
}

function appCell(value: unknown): Cell {
  if (typeof value === "number") return Number.isFinite(value) ? num(value) : text(String(value));
  if (typeof value === "string") return text(value);
  if (value === null || value === undefined) return null;
  return text(JSON.stringify(value));
}

function checkFormula(kind: ToleranceKind, hand: string, app: string, tol: string): string {
  if (kind === "abs") return `ABS(${app}-${hand})<=${tol}`;
  if (kind === "rel") return `ABS(${app}-${hand})<=${tol}*MAX(ABS(${hand}),ABS(${app}))`;
  if (kind === "bound-lower") return `AND(${app}>=0,${app}<=${hand}+${tol}*ABS(${hand}))`;
  return `${app}>=${hand}-${tol}*ABS(${hand})`;
}

const TOLERANCE_NOTE = "1e-9 absolute for counts and rates; 1e-9 relative for spend, cost per accepted and ratios (coverage.md)";

export type CoverageRow = { readonly leaf: string; readonly status: string; readonly reason: string };

/** Every `| leaf | formula, partial or excluded | reason |` row of coverage.md, in order. */
export function parseCoverage(markdown: string): CoverageRow[] {
  const out: CoverageRow[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\| (.+?) \| (formula|partial|excluded) \| (.*) \|\s*$/.exec(line);
    if (m !== null) out.push({ leaf: (m[1] ?? "").replace(/`/g, ""), status: m[2] ?? "", reason: m[3] ?? "" });
  }
  return out;
}

export type WorkbookInput = {
  /** math-check's --json report on the same records and selection. */
  readonly report: MathCheckReport;
  /** The records file text, read once. */
  readonly records: string;
  /** --last N, or null for the whole file. */
  readonly last: number | null;
  /** jevnotjev git SHA (git rev-parse HEAD). */
  readonly sha: string;
  /** coverage.md text. */
  readonly coverage: string;
};

export const SHEET_NAMES = ["Summary", "Cases", "Hand", "App", "Compare", "Coverage"];

/** The workbook bytes. */
export function buildWorkbook(input: WorkbookInput): Uint8Array {
  const report = input.report;
  const selected = selectRows(input.records, input.last);
  if (selected.cases !== report.n) throw new WorkbookError(`the selection has ${selected.cases} cases, math-check reported ${report.n}`);
  checkIdsDistinctByCase(selected);
  const figures = report.figures.filter((f) => f.group === "figure");

  const cases = casesSheet(selected);
  const hand = handSheet(cohortsOf(selected), figures.map((f) => f.key), cases.layout);

  const app: Cell[][] = [[text("Figure"), text("App value (verdict command, via scripts/math-check.ts --json)")]];
  for (const f of figures) app.push([text(f.key), appCell(f.app)]);

  const first = 2;
  const lastFig = Math.max(first, figures.length + 1);
  const compare: Cell[][] = [[text("Figure"), text("Hand"), text("App"), text("App minus Hand"), text("Tolerance kind"), text("Tolerance"), text("Status"), text("Differing so far")]];
  for (const [i, f] of figures.entries()) {
    const r = i + first;
    const tol = toleranceOf(f);
    const handRow = hand.rowOf.get(f.key);
    if (handRow === undefined) throw new WorkbookError(`no Hand row for ${f.key}`);
    const check = checkFormula(tol.kind, `B${r}`, `C${r}`, `F${r}`);
    const prev = r === first ? null : `H${r - 1}`;
    const kind = tol.kind === "abs" ? "absolute" : tol.kind === "rel" ? "relative" : tol.kind === "bound-lower" ? "bound: 0 <= app lower <= hand ratio" : "bound: app upper >= hand ratio";
    compare.push([
      text(f.key),
      formula(`IF(ISBLANK(Hand!$B$${handRow}),"",Hand!$B$${handRow})`),
      formula(`IF(ISBLANK(App!$B$${r}),"",App!$B$${r})`),
      formula(`IF(AND(ISNUMBER(B${r}),ISNUMBER(C${r})),C${r}-B${r},"")`),
      text(kind),
      num(tol.value),
      formula(`IF(OR(ISERROR(B${r}),ISERROR(C${r})),"ERROR",IF(AND(ISNUMBER(B${r}),ISNUMBER(C${r})),IF(${check},"OK","MISMATCH"),"ERROR"))`),
      formula(prev === null ? `IF(G${r}="OK","",A${r})` : `${prev}&IF(G${r}="OK","",IF(${prev}="","","; ")&A${r})`),
    ]);
  }
  const status = `$G$${first}:$G$${lastFig}`;
  compare.push([]);
  const totalCompared = compare.length + 1;
  compare.push([text("Compared"), formula(`COUNTIF(${status},"OK")+COUNTIF(${status},"MISMATCH")+COUNTIF(${status},"ERROR")`)]);
  const totalDiffer = compare.length + 1;
  compare.push([text("Mismatched (MISMATCH or ERROR)"), formula(`COUNTIF(${status},"MISMATCH")+COUNTIF(${status},"ERROR")`)]);
  compare.push([text("Of which ERROR"), formula(`COUNTIF(${status},"ERROR")`)]);
  compare.push([text("Tolerance"), text(TOLERANCE_NOTE)]);

  const total = `Compare!$B$${totalCompared}`;
  const differ = `Compare!$B$${totalDiffer}`;
  const differing = figures.length === 0 ? `""` : `Compare!$H$${figures.length + 1}`;
  const summary: Cell[][] = [
    [formula(`IF(${total}=0,"No figures compared",IF(${differ}=0,"All "&${total}&" figures match",${differ}&" of "&${total}&" differ"))`)],
    [text("Differing figures"), formula(`IF(${differing}="","none",${differing})`)],
    [text("Source file"), text(report.source)],
    [text("N (cases)"), num(report.n)],
    [text("Selection rule"), text(report.selection_rule)],
    [text("jevnotjev git SHA"), text(input.sha)],
    [text("Spend"), text("arithmetic only, not tied to a bill")],
    [text("Tolerance"), text(TOLERANCE_NOTE)],
    [text("How to read"), text("Hand recomputes each figure with formulas over Cases (docs/decision/verdict-rules.md \"Formulas\"); App holds the verdict command's figures; Compare sets them side by side. A blank, error or text value is ERROR.")],
    [text("scripts/math-check.ts said"), text(`compared ${report.compared}, mismatches ${report.mismatches}`)],
  ];

  const coverage: Cell[][] = [[text("Leaf"), text("Status"), text("Reason")]];
  for (const row of parseCoverage(input.coverage)) coverage.push([text(row.leaf), text(row.status), text(row.reason)]);
  coverage.push([]);
  coverage.push([text("Source"), text("examples/d15-sheet-check/coverage.md")]);

  const sheets: ReadonlyArray<readonly [string, string]> = [
    ["Summary", sheetXml(summary, [28, 90])],
    ["Cases", sheetXml(cases.rows, [])],
    ["Hand", sheetXml(hand.rows, [52, 22, 70, 14, 18, 12, 10])],
    ["App", sheetXml(app, [52, 22])],
    ["Compare", sheetXml(compare, [52, 22, 22, 16, 30, 10, 10, 60])],
    ["Coverage", sheetXml(coverage, [52, 10, 100])],
  ];
  const enc = new TextEncoder();
  const workbook = `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets.map(([name], i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets><calcPr fullCalcOnLoad="1"/></workbook>`;
  const pkgRel = "http://schemas.openxmlformats.org/package/2006/relationships";
  const wbRels = `${XML_HEAD}<Relationships xmlns="${pkgRel}">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="${pkgRel}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ct = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${ct}.worksheet+xml"/>`).join("")}<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/></Types>`;
  const styles = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(types) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    ...sheets.map(([, xml], i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(xml) })),
  ]);
}
