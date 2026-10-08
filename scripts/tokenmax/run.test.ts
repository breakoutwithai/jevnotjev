import { describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "../uc13/arms.ts";
import { validate } from "../../src/format/validate.ts";
import { itemId, loadInputs } from "./arms.ts";
import { defaultPaths, main, type Paths } from "./run.ts";

const REAL = defaultPaths();

/**
 * The recorded run in a temp dir, unlabelled: raw.json copied and records.csv rebuilt from it by replay, so a label test
 * starts from the jnj-record/1 file the run wrote, not from the labels committed later. d06 and the template are read
 * in place, never written.
 */
async function withRun(fn: (paths: Paths) => Promise<void>): Promise<void> {
  const out = await mkdtemp(join(tmpdir(), "tokenmax-run-"));
  try {
    await copyFile(join(REAL.out, "raw.json"), join(out, "raw.json"));
    const paths = { ...REAL, out, jevCall: join(out, "no-such-jev-call"), claude: join(out, "no-such-claude") };
    await main(["replay"], paths);
    await fn(paths);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

const APPROVED = ["--source", "human_reviewed", "--by", "operator", "--at", "2026-10-07"];

const read = (path: string) => Bun.file(path).text();

describe("TokenMax recorded live run", () => {
  test("[integration] TM-9 replay rebuilds records.csv byte-identical from raw.json, with no network", async () => {
    await withRun(async (paths) => {
      await copyFile(join(REAL.out, "records.csv"), join(paths.out, "records.csv"));
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(await read(join(REAL.out, "records.csv")));
    });
  });

  test("[integration] TM-10 the run holds 30 valid rows, 10 per arm, 10 Jev and 10 LLM raw calls, every label operator-approved", async () => {
    const text = await read(join(REAL.out, "records.csv"));
    const rows = parseRecords(text);
    expect(validate(text).errors).toEqual([]);
    expect(["rule", "jev", "llm"].map((a) => rows.filter((r) => r.answerer === a).length)).toEqual([10, 10, 10]);
    expect(rows.every((r) => r.format_version === "jnj-record/1.1" && r.label !== "")).toBe(true);
    expect(new Set(rows.map((r) => [r.label_source, r.labelled_by, r.labelled_at, r.label_blind].join(" ")))).toEqual(
      new Set(["human_reviewed operator 2026-10-07 false"]),
    );
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

  test("[integration] M1 label refuses a jnj-record/1.1 records.csv instead of keeping another labeller's provenance", async () => {
    await withRun(async (paths) => {
      const v1 = await read(join(paths.out, "records.csv"));
      const [header = "", ...lines] = v1.trimEnd().split("\n");
      const v11 = [
        `${header},labelled_by,labelled_at,label_blind`,
        ...lines.map((l) => {
          const up = l.replace(/^jnj-record\/1,/, "jnj-record/1.1,");
          return /,(accept|reject),human,/.test(up) ? `${up},op-1,2026-10-07,true` : `${up},,,`;
        }),
        "",
      ].join("\n");
      expect(validate(v11).errors).toEqual([]);
      await writeFile(join(paths.out, "records.csv"), v11);
      const first = parseRecords(v11)[0];
      if (first === undefined) throw new Error("no rows");
      await writeFile(join(paths.out, "labels.csv"), `item_id,label\n${itemId(first)},reject\n`);
      await expect(main(["label"], paths)).rejects.toThrow(/jnj-record\/1 only/);
      expect(await read(join(paths.out, "records.csv"))).toBe(v11);
    });
  });

  test("[integration] TM-41 label --source human_reviewed --by --at writes jnj-record/1.1 provenance, and replay keeps it byte for byte", async () => {
    await withRun(async (paths) => {
      const rows = parseRecords(await read(join(paths.out, "records.csv")));
      const [a, b] = rows;
      if (a === undefined || b === undefined) throw new Error("no rows");
      const labels = join(paths.out, "approved.csv");
      await writeFile(labels, `item_id,label\n${itemId(a)},accept\n${itemId(b)},reject\n`);
      await main(["label", labels, ...APPROVED], paths);
      const text = await read(join(paths.out, "records.csv"));
      expect(validate(text).errors).toEqual([]);
      expect(text.split("\n")[0]).toEndWith(",labelled_by,labelled_at,label_blind");
      const out = parseRecords(text);
      expect(out.every((r) => r.format_version === "jnj-record/1.1")).toBe(true);
      expect(out.filter((r) => r.label !== "").map((r) => [r.label, r.label_source, r.labelled_by, r.labelled_at, r.label_blind])).toEqual([
        ["accept", "human_reviewed", "operator", "2026-10-07", "false"],
        ["reject", "human_reviewed", "operator", "2026-10-07", "false"],
      ]);
      await main(["replay"], paths);
      expect(await read(join(paths.out, "records.csv"))).toBe(text);
    });
  });

  test("[integration] TM-42 label refuses incomplete or contradictory provenance flags and leaves records.csv untouched", async () => {
    await withRun(async (paths) => {
      const before = await read(join(paths.out, "records.csv"));
      const first = parseRecords(before)[0];
      if (first === undefined) throw new Error("no rows");
      const labels = join(paths.out, "approved.csv");
      await writeFile(labels, `item_id,label\n${itemId(first)},accept\n`);
      const bad: readonly [readonly string[], RegExp][] = [
        [["--source", "human_reviewed", "--at", "2026-10-07"], /--by/],
        [["--source", "human_reviewed", "--by", "operator"], /--at/],
        [["--by", "operator", "--at", "2026-10-07"], /--source/],
        [["--source", "robot", "--by", "operator", "--at", "2026-10-07"], /--source/],
        [[...APPROVED, "--blind", "true"], /blind/],
        [[...APPROVED, "--blind", "maybe"], /--blind/],
        [["--source", "agent", "--by", "a@b.com", "--at", "2026-10-07"], /--by/],
        [["--source", "agent", "--by", "opus", "--at", "Oct 7"], /--at/],
        [[...APPROVED, "--colour", "red"], /usage/],
        [[...APPROVED, "--by", "other"], /twice/],
      ];
      for (const [flags, error] of bad) {
        await expect(main(["label", labels, ...flags], paths)).rejects.toThrow(error);
        expect(await read(join(paths.out, "records.csv"))).toBe(before);
      }
    });
  });

  test("[integration] TM-43 label with no provenance flags still writes jnj-record/1 human labels", async () => {
    await withRun(async (paths) => {
      const first = parseRecords(await read(join(paths.out, "records.csv")))[0];
      if (first === undefined) throw new Error("no rows");
      await writeFile(join(paths.out, "labels.csv"), `item_id,label\n${itemId(first)},accept\n`);
      await main(["label"], paths);
      const out = parseRecords(await read(join(paths.out, "records.csv")));
      expect(out.every((r) => r.format_version === "jnj-record/1")).toBe(true);
      expect(out.filter((r) => r.label !== "").map((r) => [r.label, r.label_source])).toEqual([["accept", "human"]]);
    });
  });
});
