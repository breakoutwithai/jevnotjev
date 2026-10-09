// D15 (PR B): the mod's one path. The button and /jnj-math-check both reach check(), which runs export.ts as a
// subprocess; these tests stand a recording Host in for the engine's $.fs and $.process.
import { describe, expect, test } from "bun:test";
import { BUTTON_LABEL, check, COMMAND, DEFAULT_N, exportArgv, fromButton, fromCommand, isRepo, parseArgs, pickSource, type Entry, type Host, type RunResult } from "./run.ts";

const ROOT = "/repo";
const OK_STDOUT = [
  "source: docs/product/runs/2026-10-03-tokenmax/records.csv",
  "n: 30",
  "selection: last 30 distinct case_id values in order of first appearance (of 80)",
  "math-check: compared 120, mismatches 0 (exit 0)",
  "summary: All 120 figures match",
  "workbook: /repo/jnj-math-check/tokenmax-last30-20261009-1430.xlsx",
  "",
].join("\n");

type Fake = Host & { readonly calls: Array<{ argv: readonly string[]; cwd: string }> };

function fakeHost(opts: { files?: readonly string[]; dirs?: Record<string, readonly Entry[]>; exportResult?: RunResult; openResult?: RunResult | "throw" } = {}): Fake {
  const files = new Set(opts.files ?? [`${ROOT}/scripts/math-check.ts`, `${ROOT}/mods/math-check/export.ts`, `${ROOT}/docs/product/runs/2026-10-03-tokenmax/records.csv`, `${ROOT}/docs/product/runs/2026-10-01-uc13-shop-bot/records.csv`]);
  const dirs = opts.dirs ?? {
    [`${ROOT}/docs/product/runs`]: [
      { name: "2026-10-01-uc13-shop-bot", kind: "dir" },
      { name: "2026-10-03-tokenmax", kind: "dir" },
      { name: "README.md", kind: "file" },
    ],
  };
  const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
  return {
    calls,
    exists: async (path) => files.has(path),
    list: async (path) => {
      const found = dirs[path];
      if (found === undefined) throw new Error(`no such directory ${path}`);
      return found;
    },
    run: async (argv, cwd) => {
      calls.push({ argv, cwd });
      if (argv[0] === "open") {
        if (opts.openResult === "throw") throw new Error("open: cannot start");
        return opts.openResult ?? { exitCode: 0, stdout: "", stderr: "" };
      }
      return opts.exportResult ?? { exitCode: 0, stdout: OK_STDOUT, stderr: "" };
    },
  };
}

describe("math-check mod", () => {
  test("[unit] D15.k button and command call math-check", async () => {
    const pressed = fakeHost();
    const typed = fakeHost();
    const a = await fromButton(pressed, ROOT);
    const b = await fromCommand(typed, ROOT, "");
    const expected = ["bun", "mods/math-check/export.ts", "docs/product/runs/2026-10-03-tokenmax/records.csv", "--last", "30"];
    expect(pressed.calls[0]).toEqual({ argv: expected, cwd: ROOT });
    expect(typed.calls[0]).toEqual(pressed.calls[0]);
    expect(a.argv).toEqual(expected);
    expect(b.argv).toEqual(a.argv);
    expect(a.text).toBe(b.text);
    expect(BUTTON_LABEL).toBe("Check Jev!Jev math by hand");
    expect(COMMAND).toBe("jnj-math-check");
  });

  test("[unit] the toast names the Summary sentence, the workbook, the source and N", async () => {
    const out = await check(fakeHost(), ROOT, { n: 30, csv: null });
    expect(out.ok).toBe(true);
    expect(out.workbook).toBe("/repo/jnj-math-check/tokenmax-last30-20261009-1430.xlsx");
    expect(out.text).toContain("All 120 figures match");
    expect(out.text).toContain("/repo/jnj-math-check/tokenmax-last30-20261009-1430.xlsx");
    expect(out.text).toContain("source docs/product/runs/2026-10-03-tokenmax/records.csv");
    expect(out.text).toContain("N 30");
  });

  test("[unit] the workbook is opened once with open, and an open failure leaves the printed path", async () => {
    const host = fakeHost();
    const out = await check(host, ROOT, { n: 30, csv: null });
    expect(host.calls.map((c) => c.argv)).toEqual([exportArgv("docs/product/runs/2026-10-03-tokenmax/records.csv", 30), ["open", "/repo/jnj-math-check/tokenmax-last30-20261009-1430.xlsx"]]);
    expect(out.opened).toBe("opened");
    const failed = await check(fakeHost({ openResult: { exitCode: 1, stdout: "", stderr: "no application" } }), ROOT, { n: 30, csv: null });
    expect(failed.ok).toBe(true);
    expect(failed.opened).toContain("not opened");
    expect(failed.text).toContain("/repo/jnj-math-check/tokenmax-last30-20261009-1430.xlsx");
    const thrown = await check(fakeHost({ openResult: "throw" }), ROOT, { n: 30, csv: null });
    expect(thrown.opened).toContain("not opened");
  });

  test("[unit] fewer than N cases is an error, never a shorter export, and nothing is opened", async () => {
    const host = fakeHost({ exportResult: { exitCode: 2, stdout: "", stderr: "ERROR math-check exited 2: fewer than 30 cases (12)\n" } });
    const out = await check(host, ROOT, { n: 30, csv: null });
    expect(out.ok).toBe(false);
    expect(out.workbook).toBeNull();
    expect(out.text).toContain("fewer than 30 cases");
    expect(out.text).toContain("source docs/product/runs/2026-10-03-tokenmax/records.csv");
    expect(host.calls.length).toBe(1);
  });

  test("[unit] a mismatch still reports the workbook it wrote", async () => {
    const stdout = OK_STDOUT.replace("summary: All 120 figures match", "summary: 2 of 120 differ").replace("(exit 0)", "(exit 1)");
    const out = await check(fakeHost({ exportResult: { exitCode: 1, stdout, stderr: "" } }), ROOT, { n: 30, csv: null });
    expect(out.ok).toBe(true);
    expect(out.text).toContain("2 of 120 differ");
  });

  test("[unit] source: the named csv, else the newest run folder by its date", async () => {
    const host = fakeHost({ files: [`${ROOT}/examples/d15-sheet-check/records.csv`, `${ROOT}/docs/product/runs/2026-10-03-tokenmax/records.csv`, "/abs/other.csv"] });
    expect(await pickSource(host, ROOT, "examples/d15-sheet-check/records.csv")).toEqual({ source: "examples/d15-sheet-check/records.csv" });
    expect(await pickSource(host, ROOT, "/abs/other.csv")).toEqual({ source: "/abs/other.csv" });
    expect(await pickSource(host, ROOT, "missing.csv")).toEqual({ error: "missing.csv: no such file under /repo" });
    expect(await pickSource(host, ROOT, null)).toEqual({ source: "docs/product/runs/2026-10-03-tokenmax/records.csv" });
    const newerWithout = fakeHost({
      files: [`${ROOT}/docs/product/runs/2026-10-01-uc13-shop-bot/records.csv`],
      dirs: { [`${ROOT}/docs/product/runs`]: [{ name: "2026-10-01-uc13-shop-bot", kind: "dir" }, { name: "2026-10-05-empty", kind: "dir" }, { name: "notes", kind: "dir" }] },
    });
    expect(await pickSource(newerWithout, ROOT, null)).toEqual({ source: "docs/product/runs/2026-10-01-uc13-shop-bot/records.csv" });
    const none = fakeHost({ files: [], dirs: { [`${ROOT}/docs/product/runs`]: [] } });
    expect(await pickSource(none, ROOT, null)).toEqual({ error: "no docs/product/runs/<date>-*/records.csv under /repo; name a records.csv" });
  });

  test("[unit] N parsing: default 30, a whole number above 0, a csv in either order", () => {
    expect(DEFAULT_N).toBe(30);
    expect(parseArgs("")).toEqual({ n: 30, csv: null });
    expect(parseArgs("  12 ")).toEqual({ n: 12, csv: null });
    expect(parseArgs("12 examples/d15-sheet-check/records.csv")).toEqual({ n: 12, csv: "examples/d15-sheet-check/records.csv" });
    expect(parseArgs("examples/d15-sheet-check/records.csv 5")).toEqual({ n: 5, csv: "examples/d15-sheet-check/records.csv" });
    expect(parseArgs("0")).toEqual({ error: 'N must be a whole number above 0, got "0"' });
    expect(parseArgs("2.5")).toEqual({ error: 'N must be a whole number above 0, got "2.5"' });
    expect(parseArgs("-3")).toEqual({ error: 'N must be a whole number above 0, got "-3"' });
    expect(parseArgs("3 4")).toEqual({ error: "usage: /jnj-math-check [N] [records.csv]" });
    expect(parseArgs("a.csv b.csv")).toEqual({ error: "usage: /jnj-math-check [N] [records.csv]" });
  });

  test("[unit] a bad argument is an error and runs nothing", async () => {
    const host = fakeHost();
    const out = await fromCommand(host, ROOT, "0");
    expect(out.ok).toBe(false);
    expect(out.text).toContain("whole number above 0");
    expect(host.calls).toEqual([]);
  });

  test("[unit] guard: only a cwd holding scripts/math-check.ts and mods/math-check/export.ts", async () => {
    expect(await isRepo(fakeHost(), ROOT)).toBe(true);
    expect(await isRepo(fakeHost({ files: [`${ROOT}/scripts/math-check.ts`] }), ROOT)).toBe(false);
    expect(await isRepo(fakeHost({ files: [`${ROOT}/mods/math-check/export.ts`] }), ROOT)).toBe(false);
    expect(await isRepo(fakeHost(), "/elsewhere")).toBe(false);
  });
});
