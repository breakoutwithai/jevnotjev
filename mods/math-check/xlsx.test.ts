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
const SHEETS = ["Summary", "Cases", "Hand", "App", "Compare", "Coverage"];

const tmp = mkdtempSync(join(tmpdir(), "math-check-xlsx-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let written = 0;
function exportTo(records: string, extra: readonly string[] = []): string {
  written += 1;
  const out = join(tmp, `w${written}.xlsx`);
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

describe("[unit] math-check xlsx writer", () => {
  test("[unit] D15.h xlsx is a valid zip, six sheets", () => {
    const parts = readZip(readFileSync(exportTo(D15)));
    for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels"]) expect(parts.has(name)).toBe(true);
    const sheets = sheetParts(parts);
    expect(sheets.map((s) => s.name)).toEqual(SHEETS);
    const types = part(parts, "[Content_Types].xml");
    for (const s of sheets) {
      expect(parts.has(s.path)).toBe(true);
      expect(types).toContain(`PartName="/${s.path}"`);
    }
    expect(part(parts, "xl/workbook.xml")).toContain('<calcPr fullCalcOnLoad="1"');
  });

  test("[unit] D15.i Hand cells are <f> formulas", () => {
    const parts = readZip(readFileSync(exportTo(D15)));
    const paths = new Map(sheetParts(parts).map((s) => [s.name, s.path]));
    const hand = cellsOf(part(parts, paths.get("Hand") ?? ""));
    const compare = cellsOf(part(parts, paths.get("Compare") ?? ""));
    // Every Hand row Compare reads holds the figure in column B.
    const handRefs = [...compare.entries()].flatMap(([ref, c]) => {
      const m = /^B\d+$/.test(ref) ? /Hand!\$B\$(\d+)/.exec(c.formula ?? "") : null;
      return m === null ? [] : [m[1]];
    });
    expect(handRefs.length).toBe(compared(D15));
    for (const row of handRefs) {
      const cell = hand.get(`B${row ?? ""}`);
      expect(cell?.formula ?? "(no formula)").not.toBe("(no formula)");
      expect(cell?.value).toBeNull();
    }
    // And no cell on any sheet stores a cached value beside a formula.
    for (const { path } of sheetParts(parts)) for (const cell of cellsOf(part(parts, path)).values()) if (cell.formula !== null) expect(cell.value).toBeNull();
    // The Hand formulas read the Cases sheet, not typed-in numbers.
    const counts = [...hand.values()].filter((c) => (c.formula ?? "").includes("Cases!"));
    expect(counts.length).toBeGreaterThan(100);
  });

  test("[unit] D15.j Summary sentence formula present", () => {
    const parts = readZip(readFileSync(exportTo(D15)));
    const paths = new Map(sheetParts(parts).map((s) => [s.name, s.path]));
    const a1 = cellsOf(part(parts, paths.get("Summary") ?? "")).get("A1");
    const f = a1?.formula ?? "";
    expect(a1?.value).toBeNull();
    expect(f).toContain('"All "&');
    expect(f).toContain('" figures match"');
    expect(f).toContain('" differ"');
    const refs = [...f.matchAll(/Compare!\$B\$(\d+)/g)].map((m) => m[1] ?? "");
    const compare = cellsOf(part(parts, paths.get("Compare") ?? ""));
    const labels = new Set(refs.map((r) => compare.get(`A${r}`)?.text));
    expect(labels).toEqual(new Set(["Compared", "Mismatched (MISMATCH or ERROR)"]));
    for (const r of refs) expect(compare.get(`B${r}`)?.formula ?? "").toContain("COUNTIF(");
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
    written += 1;
    const out = join(tmp, `w${written}.xlsx`);
    const result = main([D15, "--last", "30", "--out", out]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("source: ");
    expect(result.out).toContain("n: 30\n");
    expect(result.out).toContain("selection: last 30 distinct case_id values in order of first appearance (of 42)");
    expect(result.out).toContain(`workbook: ${out}`);
  });

  test("[unit] export prints the Summary sentence the mod toasts, from math-check's counts", () => {
    written += 1;
    const out = join(tmp, `w${written}.xlsx`);
    const result = main([D15, "--out", out]);
    const { report } = runMathCheck(D15, null);
    expect(report.compared).toBeGreaterThan(0);
    expect(result.out).toContain(`summary: All ${report.compared} figures match\n`);
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

/** Every sheet of a workbook as CSV rows, recalculated by LibreOffice headless; fails when soffice is absent. */
function recalculate(workbook: string): Map<string, string[][]> {
  const which = spawnSync("sh", ["-c", "command -v soffice || ls /opt/homebrew/bin/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice 2>/dev/null"], { encoding: "utf8" });
  const soffice = which.stdout.trim().split("\n")[0] ?? "";
  if (which.status !== 0 || soffice === "") throw new Error("soffice (LibreOffice) is not installed: the [integration] recalculation needs it; install LibreOffice and rerun");
  const dir = mkdtempSync(join(tmp, "soffice-"));
  const res = spawnSync(
    soffice,
    [`-env:UserInstallation=${pathToFileURL(join(dir, "profile")).href}`, "--headless", "--convert-to", 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1', "--outdir", dir, workbook],
    { encoding: "utf8", timeout: 120_000 },
  );
  if (res.status !== 0) throw new Error(`soffice exited ${String(res.status)}: ${res.stderr}`);
  const base = basename(workbook, ".xlsx");
  const out = new Map<string, string[][]>();
  for (const sheet of SHEETS) {
    const path = join(dir, `${base}-${sheet}.csv`);
    if (!existsSync(path)) throw new Error(`soffice wrote no ${basename(path)}; files: ${readdirSync(dir).join(", ")}`);
    out.set(sheet, parseCsv(readFileSync(path, "utf8")));
  }
  return out;
}

function sheet(sheets: Map<string, string[][]>, name: string): string[][] {
  const rows = sheets.get(name);
  if (rows === undefined) throw new Error(`no ${name} sheet`);
  return rows;
}

/** Compare sheet statuses (column G) of the figure rows, keyed by figure. */
function statuses(sheets: Map<string, string[][]>): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of sheet(sheets, "Compare").slice(1)) {
    const key = row[0] ?? "";
    if (key === "") break;
    out.set(key, row[6] ?? "");
  }
  return out;
}

function compared(file: string, last: number | null = null): number {
  const { report } = runMathCheck(file, last);
  return report.compared;
}

describe("[integration] math-check workbook recalculated by LibreOffice", () => {
  const runs: ReadonlyArray<readonly [string, string, number | null]> = [["D15 fixture", D15, null], ["d06-tiny", D06, null], ["D15 fixture --last 30", D15, 30]];
  for (const [name, file, last] of runs) {
    test(`[integration] D15 recalc ${name}: Summary A1 reads All N figures match, no Compare ERROR or MISMATCH`, () => {
      const n = compared(file, last);
      expect(n).toBeGreaterThan(0);
      const sheets = recalculate(exportTo(file, last === null ? [] : ["--last", String(last)]));
      const bad = [...statuses(sheets)].filter(([, s]) => s !== "OK");
      expect(bad).toEqual([]);
      expect(statuses(sheets).size).toBe(n);
      expect(sheet(sheets, "Summary")[0]?.[0]).toBe(`All ${n} figures match`);
      expect(sheet(sheets, "Summary")[1]?.[1]).toBe("none");
    }, 180_000);
  }

  test("[integration] D15 recalc a changed app figure is MISMATCH and a blank one is ERROR", () => {
    const { report } = runMathCheck(D15, null);
    const records = readFileSync(D15, "utf8");
    const changed = "q1:numbers.jevVsLlm.a";
    const blanked = "q1:numbers.jevVsLlm.lower";
    const planted = { ...report, figures: report.figures.map((f) => (f.key === changed && typeof f.app === "number" ? { ...f, app: f.app + 1 } : f.key === blanked ? { ...f, app: null } : f)) };
    written += 1;
    const out = join(tmp, `w${written}.xlsx`);
    writeFileSync(out, buildWorkbook({ report: planted, records, last: null, sha: "0".repeat(40), coverage: "" }));
    const sheets = recalculate(out);
    const s = statuses(sheets);
    expect(s.get(changed)).toBe("MISMATCH");
    expect(s.get(blanked)).toBe("ERROR");
    expect([...s.values()].filter((v) => v !== "OK").length).toBe(2);
    expect(sheet(sheets, "Summary")[0]?.[0]).toBe(`2 of ${report.compared} differ`);
    expect(sheet(sheets, "Summary")[1]?.[1]).toBe(`${changed}; ${blanked}`);
  }, 180_000);
});
