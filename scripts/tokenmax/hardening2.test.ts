// Fixes from the PR #57 re-sweep: each test here failed on a8be2b9. Every run uses stub scripts; no paid call.
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRecords } from "../uc13/arms.ts";
import { applyItemLabels, itemId, loadInputs } from "./arms.ts";
import { defaultPaths, keepLabels, main, parseFixture, rowsFromFixture, writeRecords } from "./run.ts";

const REAL = defaultPaths();
const read = (path: string) => Bun.file(path).text();
/** The run's rows as raw.json produces them, before any label. */
const recorded = rowsFromFixture(loadInputs(await read(REAL.d06)), parseFixture(await read(join(REAL.out, "raw.json"))));
const first = recorded[0];
if (first === undefined) throw new Error("no recorded rows");

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "tokenmax-hard2-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function stub(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!/usr/bin/env bash\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

const GOOD_JEV = `q=$(jq -r '.questions|keys[0]' "$2")\nprintf '{"model":"jev-1.13.0","answers":{"%s":{"choice":"no","confidence":0.9}},"usage":{"input_tokens":10,"output_tokens":1}}\\n' "$q"`;

describe("PR #57 re-sweep fixes", () => {
  test("[unit] TM-26 (finding 2) labels apply by item id, and replay keeps labels per run, when two runs share case, question and arm", () => {
    const other = recorded.map((r) => ({ ...r, run_id: "run-other", output: r.output === "yes" ? "no" : "yes" }));
    const both = [...recorded, ...other];
    const out = applyItemLabels(both, `item_id,label\n${itemId(first)},accept\n`);
    expect(out.filter((r) => r.label !== "").length).toBe(1);
    const otherFirst = other[0];
    if (otherFirst === undefined) throw new Error("no rows");
    expect(applyItemLabels(both, `item_id,label\n${itemId(first)},accept\n${itemId(otherFirst)},reject\n`).filter((r) => r.label !== "").length).toBe(2);
    const labelledOther = other.map((r) => ({ ...r, label: "reject", label_source: "human" }));
    const kept = keepLabels(both, [...recorded, ...labelledOther]);
    expect(kept.filter((r) => r.run_id === "run-other" && r.label === "reject").length).toBe(other.length);
    expect(kept.filter((r) => r.run_id !== "run-other" && r.label !== "").length).toBe(0);
  });

  test("[integration] TM-30 (finding 7) a CV over the 8,000-character record limit is refused before any call", async () => {
    await withDir(async (dir) => {
      const long = "y".repeat(8001);
      const d06 = join(dir, "d06.csv");
      await writeFile(d06, (await read(REAL.d06)).replaceAll(
        "Chief Yield Officer, Aurelian Points Exchange. Pooled 2.3 million dormant frequent flyer accounts into one Family Mega Balance. Skills: points pooling and expiry design, tier status engineering.",
        long,
      ));
      expect(loadInputs(await read(d06)).cases[0]?.case_input).toBe(long);
      const marker = join(dir, "called");
      const jev = await stub(dir, "jev.sh", `touch '${marker}'\n${GOOD_JEV}`);
      await mkdir(join(dir, "out"));
      await expect(main(["run"], { ...REAL, d06, out: join(dir, "out"), jevCall: jev, claude: jev })).rejects.toThrow(/8000|too long/);
      expect(await Bun.file(marker).exists()).toBe(false);
    });
  });

  test("[unit] TM-31 (finding 8) a labels.csv with a repeated column or a row wider or narrower than its header is refused", () => {
    const id = itemId(first);
    expect(() => applyItemLabels(recorded, `item_id,label,label\n${id},accept,reject\n`)).toThrow(/duplicate column/);
    expect(() => applyItemLabels(recorded, `item_id,label\n${id},accept,reject\n`)).toThrow(/fields/);
    expect(() => applyItemLabels(recorded, `item_id,label,note\n${id},accept\n`)).toThrow(/fields/);
  });

  test("[unit] TM-32 (finding 6, temp names only) two writes in one process do not collide on a temp file", async () => {
    await withDir(async (dir) => {
      await Promise.all([writeRecords(dir, recorded), writeRecords(dir, recorded), writeRecords(dir, recorded)]);
      expect(await read(join(dir, "records.csv"))).toBe(formatRecords(recorded));
      expect(await readdir(dir)).toEqual(["records.csv"]);
    });
  });
});
