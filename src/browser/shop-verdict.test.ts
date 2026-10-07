import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDictRows } from "../format/csv.ts";
import { validate } from "../format/validate.ts";
import { labelRecords, shopVerdict } from "./shop-verdict.ts";

const RECORDS = join(import.meta.dir, "..", "..", "docs", "product", "runs", "2026-10-01-uc13-shop-bot", "records.csv");

async function csv(): Promise<string> {
  return readFile(RECORDS, "utf8");
}

/** The first n case ids, each called the way `pick` says. */
function calls(n: number, pick: (i: number) => "answer" | "hand_off"): Record<string, "answer" | "hand_off"> {
  const out: Record<string, "answer" | "hand_off"> = {};
  for (let i = 0; i < n; i++) out[`m${String(i + 1).padStart(2, "0")}`] = pick(i);
  return out;
}

function column(text: string, name: string): { case_id: string; answerer: string; output: string; value: string }[] {
  const { header, rows } = readDictRows(text);
  const h = header ?? [];
  const at = (c: string): number => h.indexOf(c);
  return rows.map(({ fields }) => ({
    case_id: fields[at("case_id")] ?? "",
    answerer: fields[at("answerer")] ?? "",
    output: fields[at("output")] ?? "",
    value: `${fields[at(name)] ?? ""}|${fields[at("label_source")] ?? ""}`,
  }));
}

describe("shop verdict (the Little Shop page's verdict, read by src/core)", () => {
  test("[unit] SHOP-V1 a call labels every arm's row: accept when the output equals it, reject otherwise, source human", async () => {
    const out = labelRecords(await csv(), { m01: "hand_off", m03: "answer" });
    const rows = column(out, "label");
    expect(rows.length).toBe(120);
    expect(rows.map((r) => `${r.case_id}/${r.answerer}`)).toEqual(column(await csv(), "label").map((r) => `${r.case_id}/${r.answerer}`));
    const m01 = rows.filter((r) => r.case_id === "m01");
    expect(m01.length).toBe(3);
    expect(rows.filter((x) => x.case_id === "m03").length).toBe(3);
    for (const r of m01) expect(r.value).toBe(r.output === "hand_off" ? "accept|human" : "reject|human");
    for (const r of rows.filter((x) => x.case_id === "m03")) expect(r.value).toBe(r.output === "answer" ? "accept|human" : "reject|human");
    expect(rows.filter((r) => r.case_id !== "m01" && r.case_id !== "m03").every((r) => r.value === "|")).toBe(true);
    expect(validate(out).errors).toEqual([]);
  });

  test("[unit] SHOP-V2 a case with no visitor call is unlabelled even if the source file carried a label", async () => {
    const pre = labelRecords(await csv(), { m02: "answer" });
    const again = labelRecords(pre, { m05: "answer" });
    const rows = column(again, "label");
    expect(rows.length).toBe(120);
    expect(rows.filter((r) => r.case_id === "m02").length).toBe(3);
    expect(rows.filter((r) => r.case_id === "m05").length).toBe(3);
    expect(rows.filter((r) => r.value !== "|").length).toBe(3);
    expect(rows.filter((r) => r.case_id === "m02").every((r) => r.value === "|")).toBe(true);
    expect(rows.filter((r) => r.case_id === "m05").every((r) => r.value !== "|")).toBe(true);
  });

  test("[unit] M1 a visitor's calls on the human_reviewed 1.1 run are written as /1 human labels, the recorded provenance dropped", async () => {
    const source = await csv();
    expect(readDictRows(source).header).toContain("labelled_by");
    const out = labelRecords(source, { m01: "hand_off" });
    const { header, rows } = readDictRows(out);
    expect(header).not.toContain("labelled_by");
    expect(header).not.toContain("labelled_at");
    expect(header).not.toContain("label_blind");
    expect(new Set(rows.map(({ fields }) => fields[0]))).toEqual(new Set(["jnj-record/1"]));
    expect(column(out, "label").filter((r) => r.value.endsWith("|human_reviewed"))).toEqual([]);
    expect(validate(out).errors).toEqual([]);
  });

  test("[unit] SHOP-V3 an unknown case id or a call that is not answer or hand_off fails", async () => {
    const text = await csv();
    expect(() => labelRecords(text, { m99: "answer" })).toThrow("m99");
    expect(() => labelRecords(text, JSON.parse('{"m01":"maybe"}'))).toThrow("maybe");
    expect(() => labelRecords(text, JSON.parse('{"__proto__":"answer"}'))).toThrow("__proto__");
  });

  test("[unit] SHOP-V6 a row whose width differs from the header fails before any label is written", async () => {
    const lines = (await csv()).split("\n");
    lines[1] = (lines[1] ?? "").split(",").slice(0, -1).join(",");
    expect(() => labelRecords(lines.join("\n"), { m01: "answer" })).toThrow("fields, header has");
  });

  test("[integration] SHOP-V4 29 calls read not enough evidence (1 more case); 30 calls read a verdict from rule 2, 3 or 4", async () => {
    const text = await csv();
    const short = await shopVerdict(text, calls(29, () => "hand_off"));
    expect(short.verdict).toBe("not enough evidence");
    expect(short.condition).toBe("too-few-paired");
    expect(short.reason).toContain("add 1 more labelled case");
    expect(short.paired).toBe(29);
    const full = await shopVerdict(text, calls(30, (i) => (i % 2 === 0 ? "answer" : "hand_off")));
    expect(full.paired).toBe(30);
    expect(full.reason.startsWith(`${full.verdict}: `)).toBe(true);
    expect(full.condition).not.toBe("too-few-paired");
  });

  test("[integration] SHOP-V5 the same calls give the same verdict and reason every time (seeded by the labelled file)", async () => {
    const text = await csv();
    const c = calls(40, (i) => (i % 3 === 0 ? "answer" : "hand_off"));
    const a = await shopVerdict(text, c);
    const b = await shopVerdict(text, { ...c });
    expect(b).toEqual(a);
  });
});
