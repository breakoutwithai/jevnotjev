import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import { parseCsv } from "../../scripts/math-check.ts";
import { main, runMathCheck } from "./export.ts";
import { buildWorkbook } from "./xlsx.ts";

const D15 = fileURLToPath(new URL("../../examples/d15-sheet-check/records.csv", import.meta.url));
const D06 = fileURLToPath(new URL("../../examples/d06-tiny/records.csv", import.meta.url));
const SHEET = "Check";

const tmp = mkdtempSync(join(tmpdir(), "math-check-xlsx-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let written = 0;
function nextPath(): string {
  written += 1;
  return join(tmp, `w${written}.xlsx`);
}

function exportTo(records: string, extra: readonly string[] = []): string {
  const out = nextPath();
  const result = main([records, ...extra, "--out", out]);
  if (result.code !== 0) throw new Error(`export exited ${result.code}: ${result.err}`);
  return out;
}

/** An independent zip reader: end of central directory, central entries, local headers, inflate, CRC. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory record");
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, string>();
  for (let k = 0; k < count; k += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error(`central entry ${k} has a bad signature`);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`${name}: bad local header signature`);
    if (view.getUint32(local + 14, true) !== crc) throw new Error(`${name}: local and central CRC differ`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    if (data.length !== size) throw new Error(`${name}: size ${data.length}, header says ${size}`);
    if (crc32(data) !== crc) throw new Error(`${name}: CRC mismatch`);
    out.set(name, new TextDecoder().decode(data));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function part(parts: Map<string, string>, name: string): string {
  const text = parts.get(name);
  if (text === undefined) throw new Error(`no part ${name}`);
  return text;
}

/** Sheet name to its part path, through workbook.xml and its rels, in workbook order. */
function sheetParts(parts: Map<string, string>): Array<{ name: string; path: string }> {
  const rels = new Map<string, string>();
  for (const m of part(parts, "xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) rels.set(m[1] ?? "", m[2] ?? "");
  return [...part(parts, "xl/workbook.xml").matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*\br:id="([^"]+)"/g)].map((m) => ({
    name: m[1] ?? "",
    path: `xl/${rels.get(m[2] ?? "") ?? "(missing)"}`,
  }));
}

type ParsedCell = { formula: string | null; value: string | null; text: string | null };

function unescape(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/** Every cell of a worksheet part by reference: its formula, cached value and inline text. */
function cellsOf(xml: string): Map<string, ParsedCell> {
  const out = new Map<string, ParsedCell>();
  for (const m of xml.matchAll(/<c r="([A-Z]+\d+)"[^>]*?(?:\/>|>(.*?)<\/c>)/g)) {
    const inner = m[2] ?? "";
    const f = /<f>(.*?)<\/f>/.exec(inner);
    const v = /<v>(.*?)<\/v>/.exec(inner);
    const t = /<t[^>]*>(.*?)<\/t>/.exec(inner);
    out.set(m[1] ?? "", { formula: f === null ? null : unescape(f[1] ?? ""), value: v === null ? null : (v[1] ?? ""), text: t === null ? null : unescape(t[1] ?? "") });
  }
  return out;
}

/** The first sheet's XML of an exported workbook. */
function firstSheet(file: string): { readonly parts: Map<string, string>; readonly xml: string } {
  const parts = readZip(readFileSync(file));
  const [first] = sheetParts(parts);
  return { parts, xml: part(parts, first?.path ?? "(none)") };
}

/** Rows of the figure blocks: after the "Figure | Hand | App | Status" header, before the case table's title. */
function blockRows(cells: Map<string, ParsedCell>): { readonly first: number; readonly last: number } {
  const rowOf = (test: (t: string) => boolean): number => {
    const hit = [...cells.entries()].find(([ref, c]) => /^A\d+$/.test(ref) && test(c.text ?? ""));
    return Number((hit?.[0] ?? "A0").slice(1));
  };
  return { first: rowOf((t) => t === "Figure") + 1, last: rowOf((t) => t.startsWith("Case table")) - 1 };
}

/** Rows that hold a figure: column D (Status) is a formula. */
function figureRows(cells: Map<string, ParsedCell>): number[] {
  return [...cells.entries()].flatMap(([ref, c]) => {
    const m = /^D(\d+)$/.exec(ref);
    return m !== null && c.formula !== null && Number(m[1]) > 1 ? [Number(m[1])] : [];
  });
}

describe("[unit] math-check single-sheet writer", () => {
  test("[unit] D15.h xlsx is a valid zip with exactly one sheet", () => {
    const parts = readZip(readFileSync(exportTo(D15)));
    for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]) expect(parts.has(name)).toBe(true);
    const sheets = sheetParts(parts);
    expect(sheets.map((s) => s.name)).toEqual([SHEET]);
    const types = part(parts, "[Content_Types].xml");
    expect(parts.has(sheets[0]?.path ?? "")).toBe(true);
    expect(types).toContain(`PartName="/${sheets[0]?.path ?? ""}"`);
    expect([...parts.keys()].filter((k) => k.startsWith("xl/worksheets/")).length).toBe(1);
    expect(part(parts, "xl/workbook.xml")).toContain('<calcPr fullCalcOnLoad="1"');
  });

  test("[unit] D15.i every Hand cell is <f> with no <v>", () => {
    const { parts, xml } = firstSheet(exportTo(D15));
    const cells = cellsOf(xml);
    expect(figureRows(cells).length).toBeGreaterThan(40);
    // Every Hand cell (column B of the figure blocks) is a formula with no stored value.
    const { first, last } = blockRows(cells);
    expect(last - first).toBeGreaterThan(40);
    const hands = [...cells.entries()].filter(([ref]) => /^B\d+$/.test(ref) && Number(ref.slice(1)) >= first && Number(ref.slice(1)) <= last);
    expect(hands.length).toBeGreaterThan(40);
    for (const [ref, hand] of hands) {
      expect(hand.formula ?? `(no formula in ${ref})`).not.toBe(`(no formula in ${ref})`);
      expect(hand.value).toBeNull();
    }
    for (const xmlPart of [...parts.entries()].filter(([k]) => k.startsWith("xl/worksheets/")).map(([, v]) => v)) {
      for (const cell of cellsOf(xmlPart).values()) if (cell.formula !== null) expect(cell.value).toBeNull();
    }
    // Short COUNTIFS and SUMIFS over the case table: no SUMPRODUCT stacks.
    const formulas = [...cells.values()].flatMap((c) => (c.formula === null ? [] : [c.formula]));
    expect(formulas.some((f) => f.includes("SUMPRODUCT"))).toBe(false);
    expect(formulas.filter((f) => f.startsWith("COUNTIFS(")).length).toBeGreaterThan(10);
  });

  test("[unit] D15.j the result line formula", () => {
    const { xml } = firstSheet(exportTo(D15));
    const cells = cellsOf(xml);
    const lines = [...cells.entries()].filter(([ref, c]) => /^A\d+$/.test(ref) && (c.formula ?? "").includes('" app-read"'));
    // One line per question (q1, q2, q3) and one overall line.
    expect(lines.length).toBe(4);
    for (const [, c] of lines) {
      const f = c.formula ?? "";
      expect(f).toContain('" checked, "');
      expect(f).toContain('" differ, "');
      expect(f).toMatch(/COUNTIF\(\$D\$\d+:\$D\$\d+,"CHECKED"\)/);
      expect(f).toMatch(/COUNTIF\(\$D\$\d+:\$D\$\d+,"DIFF"\)/);
      expect(f).toMatch(/COUNTIF\(\$D\$\d+:\$D\$\d+,"ERROR"\)/);
    }
    for (const q of ["q1", "q2", "q3"]) expect(lines.some(([, c]) => (c.formula ?? "").startsWith(`"${q} "&`))).toBe(true);
  });

  test("[unit] the interval working rows are a collapsed row group", () => {
    const { xml } = firstSheet(exportTo(D15));
    expect(xml).toContain('<outlinePr summaryBelow="0"/>');
    const grouped = [...xml.matchAll(/<row r="\d+"([^>]*)>/g)].filter((m) => (m[1] ?? "").includes('outlineLevel="1"'));
    expect(grouped.length).toBeGreaterThan(5);
    for (const m of grouped) expect(m[1] ?? "").toContain('hidden="1"');
  });

  test("[unit] export: fewer than N cases and an existing file both exit 2 and write nothing new", () => {
    const short = main([D15, "--last", "43", "--out", join(tmp, "short.xlsx")]);
    expect(short.code).toBe(2);
    expect(short.err).toContain("fewer than 43 cases");
    expect(existsSync(join(tmp, "short.xlsx"))).toBe(false);
    const first = exportTo(D15);
    const before = readFileSync(first);
    const again = main([D15, "--out", first]);
    expect(again.code).toBe(2);
    expect(again.err).toContain("never overwritten");
    expect(readFileSync(first)).toEqual(before);
  });

  test("[unit] export prints the source, N and the selection rule", () => {
    const out = nextPath();
    const result = main([D15, "--last", "30", "--out", out]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("source: ");
    expect(result.out).toContain("n: 30\n");
    expect(result.out).toContain("selection: last 30 distinct case_id values in order of first appearance (of 42)");
    expect(result.out).toContain(`workbook: ${out}`);
  });

  test("[unit] export prints the sentence the mod toasts, from math-check's counts", () => {
    const out = nextPath();
    const result = main([D15, "--out", out]);
    const { report } = runMathCheck(D15, null);
    expect(report.compared).toBeGreaterThan(0);
    expect(result.out).toContain(`summary: ${report.compared} figures checked, 0 differ\n`);
  });

  test("[unit] export with no --out names the workbook <cwd>/jnj-math-check/<run_id>-last<N>-<yyyymmdd-hhmm>.xlsx", () => {
    const cwd = realpathSync(mkdtempSync(join(tmp, "cwd-")));
    const res = spawnSync(process.execPath, [fileURLToPath(new URL("./export.ts", import.meta.url)), D15, "--last", "30"], { cwd, encoding: "utf8" });
    expect(res.status).toBe(0);
    const files = readdirSync(join(cwd, "jnj-math-check"));
    expect(files.length).toBe(1);
    expect(files[0] ?? "").toMatch(/^[A-Za-z0-9._-]+-last30-\d{8}-\d{4}\.xlsx$/);
    expect(res.stdout).toContain(`workbook: ${join(cwd, "jnj-math-check", files[0] ?? "")}`);
  });
});

/** The Check sheet as CSV rows, recalculated by LibreOffice headless; fails when soffice is absent. */
function recalculate(workbook: string): string[][] {
  const which = spawnSync("sh", ["-c", "command -v soffice || ls /opt/homebrew/bin/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice 2>/dev/null"], { encoding: "utf8" });
  const soffice = which.stdout.trim().split("\n")[0] ?? "";
  if (which.status !== 0 || soffice === "") throw new Error("soffice (LibreOffice) is not installed: the [integration] recalculation needs it; install LibreOffice and rerun");
  const dir = mkdtempSync(join(tmp, "soffice-"));
  const res = spawnSync(
    soffice,
    [`-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`, "--headless", "--convert-to", "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,1", "--outdir", dir, workbook],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (res.status !== 0) throw new Error(`soffice exited ${String(res.status)}: ${res.stderr}`);
  const path = join(dir, `${basename(workbook, ".xlsx")}-${SHEET}.csv`);
  if (!existsSync(path)) throw new Error(`soffice wrote no ${basename(path)}; files: ${readdirSync(dir).join(", ")}`);
  return parseCsv(readFileSync(path, "utf8"));
}

/** The result lines (column A text containing " app-read"), first the overall line, then one per question. */
function resultLines(rows: string[][]): string[] {
  return rows.map((r) => r[0] ?? "").filter((a) => a.endsWith(" app-read"));
}

function statusesOf(rows: string[][]): string[] {
  return rows.map((r) => r[3] ?? "").filter((s) => ["CHECKED", "DIFF", "ERROR", "APP-READ"].includes(s));
}

describe("[integration] math-check workbook recalculated by LibreOffice", () => {
  const runs: ReadonlyArray<readonly [string, string, number | null, number]> = [
    ["D15 fixture", D15, null, 3],
    ["d06-tiny", D06, null, 2],
    ["D15 fixture --last 30", D15, 30, 3],
  ];
  for (const [name, file, last, questions] of runs) {
    test(`[integration] D15 recalc ${name}: every result line shows 0 differ`, () => {
      const rows = recalculate(exportTo(file, last === null ? [] : ["--last", String(last)]));
      const lines = resultLines(rows);
      expect(lines.length).toBe(questions + 1);
      for (const line of lines) expect(line).toContain(" 0 differ, ");
      for (const line of lines) expect(line).not.toContain(" 0 checked");
      const statuses = statusesOf(rows);
      expect(statuses.filter((s) => s === "DIFF" || s === "ERROR")).toEqual([]);
      expect(rows.some((r) => /^per-case costs: (\d+)\/\1 match$/.test(r[0] ?? ""))).toBe(true);
    }, 180_000);
  }

  test("[integration] D15 recalc a planted app figure turns its question's line to DIFF", () => {
    const { report } = runMathCheck(D15, null);
    const changed = "q2:numbers.jevVsLlm.a";
    const planted = { ...report, figures: report.figures.map((f) => (f.key === changed && typeof f.app === "number" ? { ...f, app: f.app + 1 } : f)) };
    const out = nextPath();
    writeFileSync(out, buildWorkbook({ report: planted, records: readFileSync(D15, "utf8"), last: null, sha: "0".repeat(40) }));
    const rows = recalculate(out);
    const lines = resultLines(rows);
    expect(lines.filter((l) => l.startsWith("q2 "))[0] ?? "").toContain(" 1 differ, ");
    for (const l of lines.filter((x) => x.startsWith("q1 ") || x.startsWith("q3 "))) expect(l).toContain(" 0 differ, ");
    expect(lines[0] ?? "").toContain(" 1 differ, ");
    expect(statusesOf(rows).filter((s) => s === "DIFF").length).toBe(1);
  }, 180_000);

  test("[integration] D15 recalc a blank per-case app cost breaks the per-case line", () => {
    const { report } = runMathCheck(D15, null);
    const blanked = report.figures.find((f) => f.key.startsWith("q1:numbers.jevVsLlm.cases[") && f.key.endsWith(".otherCostUsd"))?.key ?? "(none)";
    const planted = { ...report, figures: report.figures.map((f) => (f.key === blanked ? { ...f, app: null } : f)) };
    const out = nextPath();
    writeFileSync(out, buildWorkbook({ report: planted, records: readFileSync(D15, "utf8"), last: null, sha: "0".repeat(40) }));
    const rows = recalculate(out);
    const perCase = rows.map((r) => r[0] ?? "").filter((a) => a.startsWith("per-case costs: "));
    const m = /^per-case costs: (\d+)\/(\d+) match$/.exec(perCase[0] ?? "");
    expect(Number(m?.[1] ?? "0")).toBe(Number(m?.[2] ?? "0") - 1);
    expect(resultLines(rows).filter((l) => l.startsWith("q1 "))[0] ?? "").toContain(" 1 differ, ");
  }, 180_000);
});
