// Fixes from the PR #57 re-sweep: each test here failed on a8be2b9. Every run uses stub scripts; no paid call.
import { describe, expect, test } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "../uc13/arms.ts";
import { applyItemLabels, itemId, loadInputs } from "./arms.ts";
import * as runModule from "./run.ts";
import { defaultPaths, keepLabels, main, parseFixture, writeRecords } from "./run.ts";

const REAL = defaultPaths();
const read = (path: string) => Bun.file(path).text();
const recorded = parseRecords(await read(join(REAL.out, "records.csv")));
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

async function journals(out: string): Promise<string[]> {
  const names = (await readdir(out)).filter((n) => n.startsWith("run.journal")).sort();
  return Promise.all(names.map((n) => read(join(out, n))));
}

describe("PR #57 re-sweep fixes", () => {
  test("[integration] TM-25 (finding 1) a secret in a response's stdout or a failed call's stderr never reaches the journal", async () => {
    await withDir(async (dir) => {
      const jev = await stub(dir, "jev.sh", `echo '{"model":"jev-1.13.0","api_key":"api_SECRETAAAA1234"}'`);
      const out = join(dir, "a");
      await expect(main(["run"], { ...REAL, out, jevCall: jev, claude: jev })).rejects.toThrow();
      const claude = await stub(dir, "claude.sh", `echo 'Authorization: Bearer SECRETBBBB5678' >&2\nexit 1`);
      const out2 = join(dir, "b");
      await expect(main(["run"], { ...REAL, out: out2, jevCall: await stub(dir, "ok.sh", GOOD_JEV), claude })).rejects.toThrow();
      const text = [...(await journals(out)), ...(await journals(out2))].join("\n");
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain("SECRETAAAA1234");
      expect(text).not.toContain("SECRETBBBB5678");
    });
  });

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

  test("[integration] TM-27 (finding 3) a call that prints a response and exits non-zero has its stdout and exit code journalled", async () => {
    await withDir(async (dir) => {
      const claude = await stub(dir, "claude.sh", `echo '{"partial":"usage-evidence-42"}'\nexit 3`);
      const out = join(dir, "out");
      await expect(main(["run"], { ...REAL, out, jevCall: await stub(dir, "ok.sh", GOOD_JEV), claude })).rejects.toThrow();
      const text = (await journals(out)).join("\n");
      expect(text).toContain("usage-evidence-42");
      expect(text).toContain('"exit_code":3');
    });
  });

  test("[integration] TM-28 (finding 4) each run attempt gets its own journal and a prior one is never truncated", async () => {
    await withDir(async (dir) => {
      const claude = await stub(dir, "claude.sh", "exit 1");
      const paths = { ...REAL, out: join(dir, "out"), jevCall: await stub(dir, "ok.sh", GOOD_JEV), claude };
      await expect(main(["run"], paths)).rejects.toThrow();
      const [firstJournal] = await journals(paths.out);
      await expect(main(["run"], { ...paths, jevCall: join(dir, "missing.sh") })).rejects.toThrow();
      const after = await journals(paths.out);
      expect(after.length).toBe(2);
      expect(after).toContain(firstJournal ?? "missing");
      expect((firstJournal ?? "").split("\n").filter((l) => l.includes('"event":"call"')).length).toBeGreaterThanOrEqual(10);
    });
  });

  test("[integration] TM-29 (finding 5) publishing validates both files before writing either, so a bad run leaves raw.json untouched", async () => {
    await withDir(async (dir) => {
      await copyFile(join(REAL.out, "raw.json"), join(dir, "raw.json"));
      await copyFile(join(REAL.out, "records.csv"), join(dir, "records.csv"));
      const inputs = loadInputs(await read(REAL.d06));
      const fixture = parseFixture(await read(join(REAL.out, "raw.json")));
      const huge = { ...inputs, cases: inputs.cases.map((c, i) => (i === 0 ? { ...c, case_input: "x".repeat(8001) } : c)) };
      const publish = runModule.publishRun;
      expect(typeof publish).toBe("function");
      await expect(publish(dir, huge, fixture)).rejects.toThrow();
      expect(await read(join(dir, "raw.json"))).toBe(await read(join(REAL.out, "raw.json")));
      expect(await read(join(dir, "records.csv"))).toBe(await read(join(REAL.out, "records.csv")));
      expect((await readdir(dir)).sort()).toEqual(["raw.json", "records.csv"]);
    });
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
      expect(await read(join(dir, "records.csv"))).toBe(await read(join(REAL.out, "records.csv")));
      expect(await readdir(dir)).toEqual(["records.csv"]);
    });
  });
});
