import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRecords } from "../uc13/arms.ts";
import { validate } from "../../src/format/validate.ts";
import { itemId, loadInputs } from "./arms.ts";
import { defaultPaths, main, type Paths } from "./run.ts";

const REAL = defaultPaths();

/** A copy of the recorded run in a temp dir; the d06 inputs and the template are read in place, never written. */
async function withRun(fn: (paths: Paths) => Promise<void>): Promise<void> {
  const out = await mkdtemp(join(tmpdir(), "tokenmax-run-"));
  try {
    await copyFile(join(REAL.out, "records.csv"), join(out, "records.csv"));
    await copyFile(join(REAL.out, "raw.json"), join(out, "raw.json"));
    await fn({ ...REAL, out, jevCall: join(out, "no-such-jev-call"), claude: join(out, "no-such-claude") });
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const read = (path: string) => Bun.file(path).text();

describe("TokenMax recorded live run", () => {
  test("[integration] TM-9 replay rebuilds records.csv byte-identical from raw.json, with no network", async () => {
    await withRun(async (paths) => {
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(await read(join(REAL.out, "records.csv")));
    });
  });

  test("[integration] TM-10 the run holds 30 valid rows, 10 per arm, 10 Jev and 10 LLM raw calls, no labels", async () => {
    const text = await read(join(REAL.out, "records.csv"));
    const rows = parseRecords(text);
    expect(validate(text).errors).toEqual([]);
    expect(["rule", "jev", "llm"].map((a) => rows.filter((r) => r.answerer === a).length)).toEqual([10, 10, 10]);
    expect(rows.filter((r) => r.label !== "" || r.label_source !== "").length).toBe(0);
    expect(rows.filter((r) => r.answerer === "jev").every((r) => r.answerer_model === "jev-1.13.0" && r.cost_usd !== "" && r.confidence !== "")).toBe(true);
    expect(rows.filter((r) => r.answerer === "llm").every((r) => r.answerer_model.startsWith("claude-haiku-4-5") && r.cost_usd !== "")).toBe(true);
    const raw: unknown = JSON.parse(await read(join(REAL.out, "raw.json")));
    expect(raw).toMatchObject({ calls: { jev: 10, llm: 10 }, jev_model: "jev-1.13.0", llm_model_requested: "haiku" });
  });

  test("[integration] TM-11 the label page lists all 30 answers and never names an arm, model or confidence", async () => {
    await withRun(async (paths) => {
      await main(["page"], paths);
      const html = await read(join(paths.out, "label.html"));
      const rows = parseRecords(await read(join(paths.out, "records.csv")));
      for (const r of rows) expect(html).toContain(itemId(r));
      for (const banned of [/\bjev\b/i, /\bllm\b/i, /"rule"/, /haiku/i, /keywords:/, /confidence/i, /answerer/]) expect(html).not.toMatch(banned);
      for (const r of rows.filter((x) => x.answerer === "jev")) expect(html).not.toContain(r.confidence);
    });
  });

  test("[integration] TM-12 label merges the page's labels.csv into records.csv and replay keeps them", async () => {
    await withRun(async (paths) => {
      const rows = parseRecords(await read(join(paths.out, "records.csv")));
      const first = rows[0];
      if (first === undefined) throw new Error("no rows");
      await writeFile(join(paths.out, "labels.csv"), `item_id,label\n${itemId(first)},accept\n`);
      await main(["label"], paths);
      const labelled = await read(join(paths.out, "records.csv"));
      expect(parseRecords(labelled).filter((r) => r.label === "accept").length).toBe(1);
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(labelled);
    });
  });

  test("[integration] TM-13 replay refuses a fixture whose inputs no longer match", async () => {
    await withRun(async (paths) => {
      const edited = (await read(REAL.d06)).replaceAll("Chief Yield Officer", "Chief Yield Officers");
      const d06 = join(paths.out, "d06.csv");
      await writeFile(d06, edited);
      expect(loadInputs(edited).cases.length).toBe(5);
      await expect(main(["replay"], { ...paths, d06 })).rejects.toThrow(/inputs_sha256/);
    });
  });
});
