// D15 (PR B): the "check the math by hand" workbook, one sheet ("Check"), top to bottom:
//   1. an overall result line and one result line per question, by formula ("q1 use Jev: 18 checked, 0 differ, 4 app-read")
//   2. the provenance line (source, N, selection rule, SHA) and the tolerance, stated once
//   3. a block per question: Figure | Hand (live formula) | App | Status (CHECKED, DIFF, ERROR or APP-READ)
//   4. a minimal case table; every Hand cell is a short COUNTIFS or SUMIFS over it
// Hand follows docs/decision/verdict-rules.md "Formulas". App holds the app's figures exactly as
// `scripts/math-check.ts --json` read them from the verdict command; nothing here computes a figure in TypeScript, and
// no formula cell carries a cached value: the spreadsheet computes them all on open (`fullCalcOnLoad`). The zip and the
// XML are written by hand with node:zlib only. README.md maps every math-check figure to its row.

import { crc32, deflateRawSync } from "node:zlib";
import { ABS_TOLERANCE, parseCsv, REL_TOLERANCE } from "../../scripts/math-check.ts";

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
// Cells, rows and the sheet

/** A cell: text, a number, a formula (no leading `=`, never with a cached value), or empty. */
export type Cell = { readonly text: string } | { readonly num: number } | { readonly formula: string } | null;

type Row = { cells: Cell[]; readonly level: number; readonly collapsed: boolean };

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

/** Column widths (A onwards) and the hidden echo column. */
const WIDTHS = [46, 18, 18, 11, 11, 11, 9, 34, 13, 13, 12, 12, 11, 12];

function sheetXml(rows: readonly Row[]): string {
  const cols = WIDTHS.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("") + `<col min="${ECHO_INDEX + 1}" max="${ECHO_INDEX + 1}" width="12" hidden="1" customWidth="1"/>`;
  const body = rows
    .map((row, r) => {
      const attrs = `${row.level > 0 ? ` outlineLevel="${row.level}" hidden="1"` : ""}${row.collapsed ? ' collapsed="1"' : ""}`;
      return `<row r="${r + 1}"${attrs}>${row.cells.map((cell, c) => cellXml(`${columnName(c)}${r + 1}`, cell)).join("")}</row>`;
    })
    .join("");
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheetPr><outlinePr summaryBelow="0"/></sheetPr><sheetFormatPr defaultRowHeight="15" outlineLevelRow="1"/><cols>${cols}</cols><sheetData>${body}</sheetData></worksheet>`;
}

// ---------------------------------------------------------------------------------------------
// Selection and the case table

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

/** One answerer's row of a case, transcribed: accept 1, reject 0, or null with the reason it does not count. */
type Arm = { readonly accept: number | null; readonly cost: number | null; readonly why: string };

type CaseEntry = {
  readonly caseId: string;
  readonly prefix: string;
  readonly jev: Arm;
  readonly llm: Arm;
  readonly rule: Arm;
};

const COST_PATTERN = /^\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** The (run_id, prompt_version, question_id) groups as math-check names them: the question id, or run/prompt/question. */
function prefixesOf(selected: Selected): { readonly order: readonly string[]; readonly of: (cells: readonly string[]) => string } {
  const at = (name: string): number => {
    const i = selected.header.indexOf(name);
    if (i < 0) throw new WorkbookError(`records file has no ${name} column`);
    return i;
  };
  const [run, pv, q] = [at("run_id"), at("prompt_version"), at("question_id")];
  const single = new Set(selected.rows.map((r) => JSON.stringify([r.cells[run], r.cells[pv]]))).size === 1;
  const of = (cells: readonly string[]): string => (single ? (cells[q] ?? "") : `${cells[run] ?? ""}/${cells[pv] ?? ""}/${cells[q] ?? ""}`);
  const order = [...new Set(selected.rows.map((r) => of(r.cells)))];
  // A COUNTIFS criterion treats * ? ~ as wildcards, a leading = < > as an operator, and ignores letter case.
  const folded = new Map<string, string>();
  for (const p of order) {
    if (/[*?~]/.test(p) || /^[=<>]/.test(p)) throw new WorkbookError(`question "${p}" holds a character a spreadsheet criterion would read as a wildcard or operator`);
    const seen = folded.get(p.toLowerCase());
    if (seen !== undefined) throw new WorkbookError(`questions "${seen}" and "${p}" differ only in letter case`);
    folded.set(p.toLowerCase(), p);
  }
  return { order, of };
}

/**
 * One entry per (question, case) with a Jev or LLM row, in order of first appearance. The label is transcribed as
 * 1 (accept) or 0 (reject); an unlabelled, unanswered or agent-labelled row is left blank, with its reason
 * (format/README.md "Missing cost or labels": an agent label was never reviewed, so it counts as unlabelled).
 */
function caseTable(selected: Selected, prefixOf: (cells: readonly string[]) => string): CaseEntry[] {
  const at = (name: string): number => selected.header.indexOf(name);
  const [cs, who, label, source, cost, outcome] = [at("case_id"), at("answerer"), at("label"), at("label_source"), at("cost_usd"), at("outcome")];
  const groups = new Map<string, { caseId: string; prefix: string; by: Map<string, readonly string[]> }>();
  for (const row of selected.rows) {
    const prefix = prefixOf(row.cells);
    const caseId = row.cells[cs] ?? "";
    const id = JSON.stringify([prefix, caseId]);
    const group = groups.get(id) ?? { caseId, prefix, by: new Map<string, readonly string[]>() };
    group.by.set(row.cells[who] ?? "", row.cells);
    groups.set(id, group);
  }
  const arm = (cells: readonly string[] | undefined, name: string): Arm => {
    if (cells === undefined) return { accept: null, cost: null, why: `no ${name} row` };
    const costText = (cells[cost] ?? "").trim();
    const c = COST_PATTERN.test(costText) ? Number(costText) : null;
    const l = cells[label] ?? "";
    const o = outcome < 0 ? "" : (cells[outcome] ?? "");
    if (l === "") return { accept: null, cost: c, why: o !== "" && o !== "answered" ? `${name} ${o}` : `${name} unlabelled` };
    if ((cells[source] ?? "") === "agent") return { accept: null, cost: c, why: `${name} label by agent (unreviewed)` };
    return { accept: l === "accept" ? 1 : 0, cost: c, why: "" };
  };
  return [...groups.values()]
    .filter((g) => g.by.has("jev") || g.by.has("llm"))
    .map((g) => ({ caseId: g.caseId, prefix: g.prefix, jev: arm(g.by.get("jev"), "Jev"), llm: arm(g.by.get("llm"), "LLM"), rule: arm(g.by.get("rule"), "rule") }));
}

/** Case table columns: the minimal record, then the app's per-case costs and two per-row checks, then the rule. */
const T = { caseId: 0, question: 1, jevAccept: 2, llmAccept: 3, jevCost: 4, llmCost: 5, included: 6, reason: 7, appJevCost: 8, appLlmCost: 9, costChecks: 10, costMatches: 11, ruleAccept: 12, ruleIncluded: 13 };
type TableColumn = keyof typeof T;
const T_HEADERS = ["case_id", "question", "Jev accept", "LLM accept", "Jev cost", "LLM cost", "included", "reason", "app Jev cost", "app LLM cost", "costs checked", "costs matching", "rule accept", "rule included"];

/** The hidden column holding a second app value a row also checks (wins beside b, jevAccepted beside Jev accepted). */
const ECHO_INDEX = 15;
const ECHO = columnName(ECHO_INDEX);

/** The tolerance cell, stated once. */
const TOL = "$B$3";

// ---------------------------------------------------------------------------------------------
// Statuses

type Kind = "abs" | "rel" | "bound-lower" | "bound-upper";

function kindOf(f: ReportFigure): Kind {
  if (f.tolerance.startsWith("abs ")) return "abs";
  if (f.tolerance.startsWith("rel ")) return "rel";
  if (f.tolerance.startsWith("0 <= lower")) return f.key.endsWith(".upper") ? "bound-upper" : "bound-lower";
  throw new WorkbookError(`figure ${f.key}: unknown tolerance "${f.tolerance}"`);
}

function agreeFormula(kind: Kind, hand: string, app: string): string {
  if (kind === "abs") return `ABS(${app}-${hand})<=${TOL}`;
  if (kind === "rel") return `ABS(${app}-${hand})<=${TOL}*MAX(ABS(${hand}),ABS(${app}))`;
  if (kind === "bound-lower") return `AND(${app}>=0,${app}<=${hand}+${TOL}*ABS(${hand}))`;
  return `${app}>=${hand}-${TOL}*ABS(${hand})`;
}

/** ERROR on any error, blank or text; else `ok` when every check holds, DIFF when one does not. */
function statusFormula(cells: readonly string[], checks: readonly string[], ok: string): string {
  return `IF(OR(${cells.map((c) => `ISERROR(${c})`).join(",")}),"ERROR",IF(AND(${cells.map((c) => `ISNUMBER(${c})`).join(",")}),IF(AND(${checks.join(",")}),"${ok}","DIFF"),"ERROR"))`;
}

function appCell(value: unknown): Cell {
  if (typeof value === "number") return Number.isFinite(value) ? num(value) : text(String(value));
  if (typeof value === "string") return text(value);
  if (value === null || value === undefined) return null;
  return text(JSON.stringify(value));
}

// ---------------------------------------------------------------------------------------------
// The question blocks

/** Where math-check's figure lands on the sheet: the row's Hand, its hidden echo, the per-case line, or an app-read bound. */
export type KeyPlace = { readonly row: number; readonly via: "hand" | "echo" | "per-case" | "bound" };

type Blocks = {
  readonly rows: Row[];
  readonly places: Map<string, KeyPlace>;
  /** Per question: its first and last row and the verdict row. */
  readonly spans: ReadonlyArray<{ readonly prefix: string; readonly first: number; readonly last: number; readonly verdict: number }>;
};

function blocks(start: number, prefixes: readonly string[], report: MathCheckReport, range: (c: TableColumn) => string): Blocks {
  const rows: Row[] = [];
  const places = new Map<string, KeyPlace>();
  const spans: Array<{ prefix: string; first: number; last: number; verdict: number }> = [];
  const byKey = new Map(report.figures.map((f) => [f.key, f]));
  const figureKeys = report.figures.filter((f) => f.group === "figure").map((f) => f.key);
  const next = (): number => start + rows.length;
  const push = (cells: Cell[], level = 0, collapsed = false): number => {
    const r = next();
    rows.push({ cells, level, collapsed });
    return r;
  };
  const ref = (r: number): string => `$B$${r}`;

  for (const p of prefixes) {
    const mine = figureKeys.filter((k) => k.startsWith(`${p}:`));
    const has = (path: string): boolean => byKey.get(`${p}:${path}`)?.group === "figure";
    const hasAny = (startOf: string): boolean => mine.some((k) => k.startsWith(`${p}:${startOf}`));
    const app = (path: string): unknown => byKey.get(`${p}:${path}`)?.app;
    const q = `"${p.replace(/"/g, '""')}"`;
    const countifs = (...pairs: ReadonlyArray<readonly [TableColumn, string | number]>): string =>
      `COUNTIFS(${range("question")},${q}${pairs.map(([c, v]) => `,${range(c)},${String(v)}`).join("")})`;
    const sumifs = (sum: TableColumn, ...pairs: ReadonlyArray<readonly [TableColumn, string | number]>): string =>
      `SUMIFS(${range(sum)},${range("question")},${q}${pairs.map(([c, v]) => `,${range(c)},${String(v)}`).join("")})`;

    /** A figure row: Hand formula, the app value of `path`, and a status; `echo` checks a second app value too. */
    const fig = (label: string, hand: string, path: string | null, options: { echo?: { path: string; hand: string; cells: readonly string[] }; level?: number; collapsed?: boolean } = {}): string => {
      const r = next();
      const b = `$B$${r}`;
      const c = `$C$${r}`;
      const key = path === null ? null : `${p}:${path}`;
      const f = key === null ? undefined : byKey.get(key);
      if (f === undefined || f.group !== "figure") {
        push([text(label), formula(hand)], options.level ?? 0, options.collapsed ?? false);
        return b;
      }
      const kind = kindOf(f);
      const cells: string[] = [b, c];
      const checks: string[] = [agreeFormula(kind, b, c)];
      const row: Cell[] = [text(label), formula(hand), appCell(f.app), null];
      const echoKey = options.echo === undefined ? null : `${p}:${options.echo.path}`;
      const echo = echoKey === null ? undefined : byKey.get(echoKey);
      if (options.echo !== undefined && echo !== undefined && echo.group === "figure") {
        const e = `$${ECHO}$${r}`;
        cells.push(e, ...options.echo.cells);
        checks.push(agreeFormula(kindOf(echo), `(${options.echo.hand})`, e));
        while (row.length < ECHO_INDEX) row.push(null);
        row.push(appCell(echo.app));
        places.set(echo.key, { row: r, via: "echo" });
      }
      const bound = kind === "bound-lower" || kind === "bound-upper";
      row[3] = formula(statusFormula(cells, checks, bound ? "APP-READ" : "CHECKED"));
      places.set(f.key, { row: r, via: bound ? "bound" : "hand" });
      push(row, options.level ?? 0, options.collapsed ?? false);
      return b;
    };
    /** A working row: a Hand formula with no app counterpart and no status. */
    const work = (label: string, hand: string, level = 0, appNote = "", collapsed = false): string =>
      `$B$${push([text(label), formula(hand), appNote === "" ? null : text(appNote)], level, collapsed)}`;
    /** Newcombe method 10 for p1 - p2 on paired cells a, b, c, d, with its Wilson chain in a collapsed group. */
    const newcombe = (base: string, n: string, a: string, b: string, c: string, d: string, first: string, second: string): { lower: string; upper: string } => {
      const p1 = fig(`p1 (${first} rate)`, `(${a}+${b})/${n}`, `${base}.p1`);
      const p2 = fig(`p2 (${second} rate)`, `(${a}+${c})/${n}`, `${base}.p2`);
      fig("diff (p1 - p2)", `${p1}-${p2}`, `${base}.diff`);
      // Rows: phi, lower, upper, then the collapsed group (label, z, l1, u1, l2, u2, phi before the reduction).
      const at = next();
      const [z, l1, u1, l2, u2] = [4, 5, 6, 7, 8].map((k) => ref(at + k));
      const root = `SQRT((${a}+${b})*(${c}+${d})*(${a}+${c})*(${b}+${d}))`;
      const raw = `(${a}*${d}-${b}*${c})`;
      const phi = work("phi (n/2 reduced)", `IF(${root}=0,0,IF(${raw}>0,MAX(${raw}-${n}/2,0),${raw})/${root})`, 0, "not printed (#168)");
      const dl1 = `(${p1}-${l1})`;
      const du1 = `(${u1}-${p1})`;
      const dl2 = `(${p2}-${l2})`;
      const du2 = `(${u2}-${p2})`;
      const lower = fig("Newcombe lower", `${p1}-${p2}-SQRT(MAX(${dl1}^2-2*${phi}*${dl1}*${du2}+${du2}^2,0))`, `${base}.lower`);
      const upper = fig("Newcombe upper", `${p1}-${p2}+SQRT(MAX(${du1}^2-2*${phi}*${du1}*${dl2}+${dl2}^2,0))`, `${base}.upper`);
      push([text("interval working: Wilson bounds, phi before the n/2 reduction (expand)")], 0, true);
      const wilson = (x: string, pr: string, which: "lower" | "upper"): string => {
        const centre = `${pr}+${z}^2/(2*${n})`;
        const half = `${z}*SQRT(${pr}*(1-${pr})/${n}+${z}^2/(4*${n}^2))`;
        const den = `(1+${z}^2/${n})`;
        return which === "lower" ? `IF(${x}=0,0,(${centre}-${half})/${den})` : `IF(${x}=${n},1,(${centre}+${half})/${den})`;
      };
      work("z (95%)", "NORMSINV(0.975)", 1);
      work("l1 (Wilson lower of p1)", wilson(`(${a}+${b})`, p1, "lower"), 1);
      work("u1 (Wilson upper of p1)", wilson(`(${a}+${b})`, p1, "upper"), 1);
      work("l2 (Wilson lower of p2)", wilson(`(${a}+${c})`, p2, "lower"), 1);
      work("u2 (Wilson upper of p2)", wilson(`(${a}+${c})`, p2, "upper"), 1);
      work("phi before the n/2 reduction", `IF(${root}=0,0,${raw}/${root})`, 1);
      return { lower, upper };
    };

    const first = push([text(`Question ${p}`)]);
    const verdict = next();
    push([text("verdict"), null, appCell(app("verdict")), formula(`IF(ISBLANK($C$${verdict}),"ERROR","APP-READ")`)]);
    const unmet = app("unmet");
    const unmetText = Array.isArray(unmet) && unmet.length > 0 ? ` (unmet: ${unmet.map(String).join(", ")})` : "";
    const ruleApp = app("rule");
    const ruleText = ruleApp === undefined || ruleApp === null ? null : text(`${String(ruleApp)}: ${String(app("condition") ?? "")}${unmetText}`);
    const ruleRow = next();
    push([text("rule fired"), null, ruleText, formula(`IF(ISBLANK($C$${ruleRow}),"ERROR","APP-READ")`)]);
    // Deciding conditions, filled once the rows they read exist.
    const conditions: Array<{ row: number; label: string; hand: () => string | null }> = [];
    const condition = (label: string, hand: () => string | null): void => {
      conditions.push({ row: push([]), label, hand });
    };
    let nRef: string | null = null;
    let lowerRef: string | null = null;
    let upperRef: string | null = null;
    let ratioRef: string | null = null;
    let ruleLowerRef: string | null = null;
    const vs = (cell: string | null, threshold: string, test: string): string | null => (cell === null ? null : `ROUND(${cell},4)&" vs ${threshold}: "&IF(${cell}${test},"met","not met")`);
    if (hasAny("numbers.")) condition("paired n vs 30 (rule 1 needs 30)", () => vs(nRef, "30", ">=30"));
    if (has("numbers.jevVsLlm.lower")) condition("Newcombe lower vs -0.10 (rule 3 needs above)", () => vs(lowerRef, "-0.10", ">-0.1"));
    if (has("numbers.jevVsLlm.upper")) condition("Newcombe upper vs -0.10 (rule 2 if below)", () => vs(upperRef, "-0.10", "<-0.1"));
    if (has("numbers.costRatio.ratio")) condition("cost ratio vs 0.8 (rule 3 needs at most)", () => vs(ratioRef, "0.8", "<=0.8"));
    if (has("ruleComparison.lower")) condition("rule minus Jev lower vs -0.10 (rule 2 if above)", () => vs(ruleLowerRef, "-0.10", ">-0.1"));

    if (hasAny("numbers.")) {
      const base = "numbers.jevVsLlm";
      const n = fig("paired n", countifs(["included", 1]), `${base}.n`);
      nRef = n;
      if (has("addN")) fig("cases still needed (30 - n)", `30-${n}`, "addN");
      if (has(`${base}.excluded`)) fig("excluded (not paired)", countifs(["included", 0]), `${base}.excluded`);
      let a = "";
      let b = "";
      let c = "";
      let d = "";
      if (has(`${base}.a`)) {
        a = fig("a: both accepted", countifs(["included", 1], ["jevAccept", 1], ["llmAccept", 1]), `${base}.a`);
        const bRow = next();
        b = fig("b: Jev only", countifs(["included", 1], ["jevAccept", 1], ["llmAccept", 0]), `${base}.b`, { echo: { path: `${base}.wins`, hand: `$B$${bRow}`, cells: [] } });
        const cRow = next();
        c = fig("c: LLM only", countifs(["included", 1], ["jevAccept", 0], ["llmAccept", 1]), `${base}.c`, { echo: { path: `${base}.losses`, hand: `$B$${cRow}`, cells: [] } });
        const dRow = next();
        d = fig("d: neither", countifs(["included", 1], ["jevAccept", 0], ["llmAccept", 0]), `${base}.d`, { echo: { path: `${base}.ties`, hand: `${a}+$B$${dRow}`, cells: [a] } });
      }
      const jRow = next();
      const jAcc = has(`${base}.jev.accepted`)
        ? fig("Jev accepted", countifs(["included", 1], ["jevAccept", 1]), `${base}.jev.accepted`, { echo: { path: "numbers.jevAccepted", hand: `$B$${jRow}`, cells: [] } })
        : fig("Jev accepted", countifs(["included", 1], ["jevAccept", 1]), "numbers.jevAccepted");
      if (has(`${base}.jev.acceptRate`)) fig("Jev rate", `${jAcc}/${n}`, `${base}.jev.acceptRate`);
      const oRow = next();
      const oAcc = has(`${base}.otherArm.accepted`)
        ? fig("LLM accepted", countifs(["included", 1], ["llmAccept", 1]), `${base}.otherArm.accepted`, { echo: { path: "numbers.llmAccepted", hand: `$B$${oRow}`, cells: [] } })
        : fig("LLM accepted", countifs(["included", 1], ["llmAccept", 1]), "numbers.llmAccepted");
      if (has(`${base}.otherArm.acceptRate`)) fig("LLM rate", `${oAcc}/${n}`, `${base}.otherArm.acceptRate`);
      if (has(`${base}.p1`)) {
        const ci = newcombe(base, n, a, b, c, d, "Jev", "LLM");
        lowerRef = ci.lower;
        upperRef = ci.upper;
      }
      if (hasAny(`${base}.jev.spend`) || hasAny(`${base}.otherArm.spend`)) {
        const spendRow = (side: "jev" | "otherArm", name: string, cost: TableColumn): { spend: string; missing: string } => {
          const spend = fig(
            has(`${base}.${side}.spend.knownUsd`) ? `${name} spend (known costs)` : `${name} spend`,
            sumifs(cost, ["included", 1]),
            has(`${base}.${side}.spend.knownUsd`) ? `${base}.${side}.spend.knownUsd` : `${base}.${side}.spend.usd`,
          );
          const missingFormula = `${countifs(["included", 1])}-${countifs(["included", 1], [cost, '">=0"'])}`;
          // A row only when math-check compares it (some cost is missing); otherwise the count sits inside cost per accepted.
          const missing = has(`${base}.${side}.spend.missing`) ? fig(`${name} costs missing`, missingFormula, `${base}.${side}.spend.missing`) : `(${missingFormula})`;
          return { spend, missing };
        };
        const js = spendRow("jev", "Jev", "jevCost");
        const os = spendRow("otherArm", "LLM", "llmCost");
        const cpa = (side: "jev" | "otherArm", name: string, s: { spend: string; missing: string }, acc: string): string => {
          const f = `IF(${s.missing}>0,"incomplete",IF(${acc}=0,"undefined",${s.spend}/${acc}))`;
          return has(`${base}.${side}.costPerAccepted.usd`) ? fig(`${name} cost per accepted`, f, `${base}.${side}.costPerAccepted.usd`) : work(`${name} cost per accepted`, f);
        };
        const jc = cpa("jev", "Jev", js, jAcc);
        const oc = cpa("otherArm", "LLM", os, oAcc);
        if (has("numbers.costRatio.ratio")) {
          const ratio = fig("cost ratio (Jev / LLM per accepted)", `IF(${oAcc}=0,0,${jc}/${oc})`, "numbers.costRatio.ratio");
          ratioRef = ratio;
          fig("bootstrap lower (app's, must be at most the ratio)", ratio, "numbers.costRatio.lower");
          fig("bootstrap upper (app's, must be at least the ratio)", ratio, "numbers.costRatio.upper", { collapsed: has("numbers.costRatio.resamples") });
          if (has("numbers.costRatio.resamples")) fig("bootstrap resamples (verdict-rules.md: 2,000)", "2000", "numbers.costRatio.resamples", { level: 1 });
        }
      }
      const perCase = mine.filter((k) => /^.+:numbers\.jevVsLlm\.cases\[.+\]\.(jevCostUsd|otherCostUsd)$/.test(k));
      if (perCase.length > 0) {
        const r = next();
        const matching = sumifs("costMatches");
        push([
          formula(`"per-case costs: "&${matching}&"/"&$B$${r}&" match"`),
          formula(sumifs("costChecks")),
          num(perCase.length),
          formula(`IF(OR(ISERROR($B$${r}),ISERROR($C$${r})),"ERROR",IF(AND(ISNUMBER($B$${r}),ISNUMBER($C$${r})),IF(AND($B$${r}=$C$${r},${matching}=$B$${r}),"CHECKED","DIFF"),"ERROR"))`),
        ]);
        for (const k of perCase) places.set(k, { row: r, via: "per-case" });
      }
    }

    if (hasAny("ruleComparison.")) {
      const base = "ruleComparison";
      push([text("Jev vs rule (rule minus Jev)")]);
      const n = fig("rule-paired n", countifs(["ruleIncluded", 1]), has(`${base}.n`) ? `${base}.n` : `${base}.paired`);
      if (has(`${base}.a`)) {
        const a = fig("a: both accepted", countifs(["ruleIncluded", 1], ["ruleAccept", 1], ["jevAccept", 1]), `${base}.a`);
        const b = fig("b: rule only", countifs(["ruleIncluded", 1], ["ruleAccept", 1], ["jevAccept", 0]), `${base}.b`);
        const c = fig("c: Jev only", countifs(["ruleIncluded", 1], ["ruleAccept", 0], ["jevAccept", 1]), `${base}.c`);
        const d = fig("d: neither", countifs(["ruleIncluded", 1], ["ruleAccept", 0], ["jevAccept", 0]), `${base}.d`);
        ruleLowerRef = newcombe(base, n, a, b, c, d, "rule", "Jev").lower;
      }
    }

    // A figure math-check compares that no row above holds is shown, never dropped: its Hand is not a number, so ERROR.
    for (const k of mine) if (!places.has(k)) fig(`unmapped: ${k.slice(p.length + 1)}`, '"no formula"', k.slice(p.length + 1));

    for (const cnd of conditions) {
      const hand = cnd.hand();
      rows[cnd.row - start] = { cells: [text(cnd.label), hand === null ? null : formula(hand)], level: 0, collapsed: false };
    }
    spans.push({ prefix: p, first, last: next() - 1, verdict });
    push([]);
  }
  return { rows, places, spans };
}

// ---------------------------------------------------------------------------------------------
// The workbook

export type WorkbookInput = {
  /** math-check's --json report on the same records and selection. */
  readonly report: MathCheckReport;
  /** The records file text, read once. */
  readonly records: string;
  /** --last N, or null for the whole file. */
  readonly last: number | null;
  /** jevnotjev git SHA (git rev-parse HEAD). */
  readonly sha: string;
};

export type Layout = {
  readonly bytes: Uint8Array;
  /** Every math-check figure key and the sheet row (1-based) that checks it. */
  readonly places: ReadonlyMap<string, KeyPlace>;
  /** Rows on the sheet. */
  readonly rows: number;
};

export const SHEET_NAME = "Check";

const status = (c: string): string => `COUNTIF(${c},"CHECKED")&" checked, "&(COUNTIF(${c},"DIFF")+COUNTIF(${c},"ERROR"))&" differ, "&COUNTIF(${c},"APP-READ")&" app-read"`;

/** The workbook and where each math-check figure sits on it. */
export function layoutWorkbook(input: WorkbookInput): Layout {
  const report = input.report;
  const selected = selectRows(input.records, input.last);
  if (selected.cases !== report.n) throw new WorkbookError(`the selection has ${selected.cases} cases, math-check reported ${report.n}`);
  if (ABS_TOLERANCE !== REL_TOLERANCE) throw new WorkbookError("the sheet states one tolerance; math-check's absolute and relative tolerances differ");
  const { order, of } = prefixesOf(selected);
  const keyed = new Set(report.figures.map((f) => f.key.split(":")[0] ?? ""));
  const prefixes = order.filter((p) => keyed.has(p));
  const entries = caseTable(selected, of);
  const hasRule = entries.some((e) => e.rule.why !== "no rule row");
  const width = hasRule ? T_HEADERS.length : T.ruleAccept;

  const top = 4 + prefixes.length + 2;
  const blockStart = top + 1;
  const measure = blocks(blockStart, prefixes, report, () => "$A$1:$A$1");
  const tableHeader = blockStart + measure.rows.length + 1;
  const tableFirst = tableHeader + 1;
  const tableLast = tableFirst + Math.max(entries.length, 1) - 1;
  const range = (c: TableColumn): string => {
    const col = columnName(T[c]);
    return `$${col}$${tableFirst}:$${col}$${tableLast}`;
  };
  const built = blocks(blockStart, prefixes, report, range);
  const blockEnd = blockStart + built.rows.length - 1;

  const rows: Row[] = [];
  const add = (cells: Cell[]): void => {
    rows.push({ cells, level: 0, collapsed: false });
  };
  add([formula(`"All questions: "&${status(`$D$${blockStart}:$D$${blockEnd}`)}`)]);
  add([text(`source ${report.source}; N ${report.n}; ${report.selection_rule}; jevnotjev ${input.sha}`)]);
  add([text("tolerance"), num(ABS_TOLERANCE), text("absolute for counts and rates; relative for spend, cost per accepted and the cost ratio")]);
  add([text("Hand: live formulas over the case table below. APP-READ: the app's figure, not recomputed (bootstrap seed not printed, #168). Spend is arithmetic only, not tied to a bill.")]);
  for (const span of built.spans) {
    const q = `"${span.prefix.replace(/"/g, '""')} "`;
    add([formula(`${q}&$C$${span.verdict}&": "&${status(`$D$${span.first}:$D$${span.last}`)}`)]);
  }
  add([]);
  add([text("Figure"), text("Hand"), text("App"), text("Status")]);
  rows.push(...built.rows);
  add([text("Case table: one row per question and case with a Jev or LLM row")]);
  add(T_HEADERS.slice(0, width).map(text));

  const tableRow = (e: CaseEntry, r: number): Cell[] => {
    const cell = (c: TableColumn): string => `$${columnName(T[c])}${r}`;
    const reason = [e.jev.why, e.llm.why].filter((w) => w !== "").join("; ");
    const appCost = (leaf: string): Cell => {
      const v = report.figures.find((f) => f.key === `${e.prefix}:numbers.jevVsLlm.cases[${e.caseId}].${leaf}`)?.app;
      return typeof v === "number" && Number.isFinite(v) ? num(v) : null;
    };
    const costOk = (hand: string, app: string): string => `IF(ISNUMBER(${hand}),IF(ISNUMBER(${app}),IF(ABS(${app}-${hand})<=${TOL}*MAX(ABS(${hand}),ABS(${app})),1,0),0),0)`;
    checkXmlText(e.caseId, `case_id ${e.caseId}`);
    const cells: Cell[] = [
      text(e.caseId),
      text(e.prefix),
      e.jev.accept === null ? null : num(e.jev.accept),
      e.llm.accept === null ? null : num(e.llm.accept),
      e.jev.cost === null ? null : num(e.jev.cost),
      e.llm.cost === null ? null : num(e.llm.cost),
      formula(`IF(AND(ISNUMBER(${cell("jevAccept")}),ISNUMBER(${cell("llmAccept")})),1,0)`),
      reason === "" ? null : text(reason),
      appCost("jevCostUsd"),
      appCost("otherCostUsd"),
      formula(`IF(${cell("included")}=1,IF(ISNUMBER(${cell("jevCost")}),1,0)+IF(ISNUMBER(${cell("llmCost")}),1,0),0)`),
      formula(`IF(${cell("included")}=1,${costOk(cell("jevCost"), cell("appJevCost"))}+${costOk(cell("llmCost"), cell("appLlmCost"))},0)`),
    ];
    if (hasRule) cells.push(e.rule.accept === null ? null : num(e.rule.accept), formula(`IF(AND(ISNUMBER(${cell("jevAccept")}),ISNUMBER(${cell("ruleAccept")})),1,0)`));
    return cells;
  };
  for (const [i, e] of entries.entries()) add(tableRow(e, tableFirst + i));
  if (rows.length !== tableFirst - 1 + entries.length) throw new WorkbookError("sheet layout drifted from its plan");

  const enc = new TextEncoder();
  const workbook = `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${SHEET_NAME}" sheetId="1" r:id="rId1"/></sheets><calcPr fullCalcOnLoad="1"/></workbook>`;
  const pkgRel = "http://schemas.openxmlformats.org/package/2006/relationships";
  const wbRels = `${XML_HEAD}<Relationships xmlns="${pkgRel}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="${pkgRel}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const ct = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  const types = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/></Types>`;
  const styles = `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const bytes = zip([
    { name: "[Content_Types].xml", data: enc.encode(types) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml(rows)) },
  ]);
  return { bytes, places: built.places, rows: rows.length };
}

/** The workbook bytes. */
export function buildWorkbook(input: WorkbookInput): Uint8Array {
  return layoutWorkbook(input).bytes;
}
