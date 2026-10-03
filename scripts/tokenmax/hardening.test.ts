// Fixes from the PR #57 sweep: each test here failed on f9a5b54.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRows, readDictRows } from "../../src/format/csv.ts";
import { parseRecords } from "../uc13/arms.ts";
import { itemId, llmCost, loadInputs, parseLlm, applyItemLabels } from "./arms.ts";
import { defaultPaths, keepLabels, main, parseFixture, writeRecords, type Paths } from "./run.ts";

const REAL = defaultPaths();
const read = (path: string) => Bun.file(path).text();
const d06Text = await read(REAL.d06);
const recorded = parseRecords(await read(join(REAL.out, "records.csv")));

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmax-hard-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withRun(fn: (paths: Paths) => Promise<void>): Promise<void> {
  await withDir(async (out) => {
    await copyFile(join(REAL.out, "records.csv"), join(out, "records.csv"));
    await copyFile(join(REAL.out, "raw.json"), join(out, "raw.json"));
    await fn({ ...REAL, out, jevCall: join(out, "no-such-jev-call"), claude: join(out, "no-such-claude") });
  });
}

/** d06 rewritten field by field: fn may change each row's fields; the header is kept. */
function d06With(fn: (fields: string[], header: readonly string[]) => string[] | null): string {
  const { header, rows } = readDictRows(d06Text);
  const h = header ?? [];
  const kept = rows.map(({ fields }) => fn([...fields], h)).filter((x): x is string[] => x !== null);
  return formatRows([h, ...kept]);
}

const first = recorded[0];
if (first === undefined) throw new Error("no recorded rows");

describe("PR #57 sweep fixes", () => {
  test("[unit] TM-14 (finding 1) an item id changes with the answer, CV, question, answer set, prompt version or run", () => {
    const base = itemId(first);
    for (const change of [{ output: "maybe" }, { case_input: "x" }, { question: "x" }, { answer_set: "no|yes" }, { prompt_version: "v2" }, { run_id: "other" }]) {
      expect(itemId({ ...first, ...change })).not.toBe(base);
    }
    const flipped = recorded.map((r, i) => (i === 0 ? { ...r, output: r.output === "yes" ? "no" : "yes" } : r));
    expect(() => applyItemLabels(flipped, `item_id,label\n${base},accept\n`)).toThrow(/unknown item_id/);
  });

  test("[unit] TM-15 (finding 2) replay keeps a label only when input, question, answer set, prompt version and output all match", () => {
    const labelled = recorded.map((r) => ({ ...r, label: "accept", label_source: "human" }));
    expect(keepLabels(recorded, labelled).every((r) => r.label === "accept")).toBe(true);
    for (const change of [{ case_input: "other CV" }, { question: "other?" }, { answer_set: "no|yes" }, { prompt_version: "v0" }]) {
      const old = labelled.map((r) => ({ ...r, ...change }));
      expect(keepLabels(recorded, old).filter((r) => r.label !== "").length).toBe(0);
    }
  });

  test("[unit] TM-17 (finding 4) invalid rows are refused before records.csv is touched", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, "records.csv"), "keep me\n");
      await expect(writeRecords(dir, recorded.map((r) => ({ ...r, case_input: "" })))).rejects.toThrow();
      expect(await read(join(dir, "records.csv"))).toBe("keep me\n");
      expect((await readdir(dir)).sort()).toEqual(["records.csv"]);
    });
  });

  test("[unit] TM-18 (finding 6) blank CV or question text, or a short row, is refused before any call", () => {
    const blank = (col: string) => d06With((f, h) => { f[h.indexOf(col)] = ""; return f; });
    expect(() => loadInputs(blank("case_input"))).toThrow(/blank/);
    expect(() => loadInputs(blank("question"))).toThrow(/blank/);
    expect(() => loadInputs(d06With((f) => f.slice(0, 6)))).toThrow(/fields/);
  });

  test("[unit] TM-19 (finding 7) a fixture whose captured price table differs from the dated table is refused", async () => {
    const raw: unknown = JSON.parse(await read(join(REAL.out, "raw.json")));
    if (typeof raw !== "object" || raw === null) throw new Error("raw.json is not an object");
    expect(() => parseFixture(JSON.stringify(raw))).not.toThrow();
    const edited = JSON.stringify({ ...raw, llm_price_table: { ...("llm_price_table" in raw && typeof raw.llm_price_table === "object" ? raw.llm_price_table : {}), outputPerM: 4 } });
    expect(() => parseFixture(edited)).toThrow(/price table/);
  });

  test("[unit] TM-20 (finding 8) only the exact Haiku 4.5 model id is accepted", () => {
    const reply = (model: string) => ({ is_error: false, result: "no", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: { [model]: {} } });
    expect(parseLlm(reply("claude-haiku-4-5-20251001"), "t").model).toBe("claude-haiku-4-5-20251001");
    expect(() => parseLlm(reply("claude-haiku-4-50"), "t")).toThrow(/price table/);
  });

  test("[unit] TM-21 (finding 9) a malformed cache_creation breakdown, or one that does not sum to the total, is refused", () => {
    const u = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 10 };
    expect(() => llmCost({ ...u, cache_creation: "broken" }, "t")).toThrow(/cache_creation/);
    expect(() => llmCost({ ...u, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 3 } }, "t")).toThrow(/sum/);
    expect(llmCost({ ...u, cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 6 } }, "t")).toBeCloseTo((1 + 4 * 1.25 + 6 * 2 + 5) / 1e6, 15);
  });

  test("[unit] TM-22 (finding 10) the same rows in another order load, in canonical order", () => {
    const { header, rows } = readDictRows(d06Text);
    const reversed = formatRows([header ?? [], ...rows.map(({ fields }) => [...fields]).reverse()]);
    const inputs = loadInputs(reversed);
    expect(inputs.cases.map((c) => c.case_id)).toEqual(["cv1", "cv2", "cv3", "cv4", "cv5"]);
    expect(inputs.questions.map((q) => q.question_id)).toEqual(["q1", "q2"]);
    expect(inputs).toEqual(loadInputs(d06Text));
  });

  test("[integration] TM-23 (finding 11) page and label need no d06 file", async () => {
    await withRun(async (paths) => {
      const noD06 = { ...paths, d06: join(paths.out, "missing.csv") };
      await main(["page"], noD06);
      await writeFile(join(paths.out, "labels.csv"), `item_id,label\n${itemId(first)},reject\n`);
      await main(["label"], noD06);
      expect(parseRecords(await read(join(paths.out, "records.csv"))).filter((r) => r.label === "reject").length).toBe(1);
    });
  });

  test("[integration] TM-24 (finding 13) label reads an explicit labels-file path", async () => {
    await withRun(async (paths) => {
      const elsewhere = join(paths.out, "Downloads-labels.csv");
      await writeFile(elsewhere, `item_id,label\n${itemId(first)},accept\n`);
      await main(["label", elsewhere], paths);
      expect(parseRecords(await read(join(paths.out, "records.csv"))).filter((r) => r.label === "accept").length).toBe(1);
      await expect(main(["label", elsewhere, "extra"], paths)).rejects.toThrow(/usage/);
    });
  });
});
