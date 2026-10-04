import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkCounts, parseJunit, parseManifest, parseShellSummary, type Counts } from "./gate.ts";

// #87: a per-file test-count floor. Expected values come from recorded tool output (a bun junit
// report and a shell suite summary line captured on 2026-10-04) and from the issue's literal
// seeds, never from the gate's own computation.
const root = join(import.meta.dir, "..");
const junit = readFileSync(join(import.meta.dir, "fixtures/gate/bun-junit-2026-10-04.xml"), "utf8");

const results = (entries: Array<[string, number, number]>): Map<string, Counts> =>
  new Map(entries.map(([file, passed, failed]) => [file, { passed, failed }]));

describe("gate parsing", () => {
  test("[unit] #87 junit: one entry per test FILE with its passed count; nested describe suites are not files", () => {
    const parsed = parseJunit(junit);
    expect([...parsed.keys()].sort()).toEqual(["scripts/backstage-deps.test.ts", "scripts/theatre.test.ts"]);
    expect(parsed.get("scripts/backstage-deps.test.ts")).toEqual({ passed: 4, failed: 0 });
    expect(parsed.get("scripts/theatre.test.ts")).toEqual({ passed: 8, failed: 0 });
  });

  test("[unit] #87 junit: failures and skips are not passes", () => {
    const failing = junit.replace(
      'file="scripts/theatre.test.ts" tests="8" assertions="32" failures="0" skipped="0"',
      'file="scripts/theatre.test.ts" tests="8" assertions="32" failures="1" skipped="2"',
    );
    expect(parseJunit(failing).get("scripts/theatre.test.ts")).toEqual({ passed: 5, failed: 1 });
  });

  test("[unit] #87 shell summary: the last [T1] passed=N failed=M line, or null when absent", () => {
    expect(parseShellSummary("  ok   - a\n[T1] passed=81 failed=0\n")).toEqual({ passed: 81, failed: 0 });
    expect(parseShellSummary("[T1] passed=1 failed=0\n...\n[T1] passed=89 failed=2")).toEqual({ passed: 89, failed: 2 });
    expect(parseShellSummary("bash: no such file\n")).toBeNull();
  });

  test("[unit] #87 manifest: a malformed manifest is an error, not an empty floor", () => {
    expect(() => parseManifest('{"files":{"a.test.ts":"3"},"minFiles":1}')).toThrow();
    expect(() => parseManifest('{"files":{}}')).toThrow();
    expect(parseManifest('{"minFiles":2,"files":{"a.test.ts":3,"b.test.sh":4}}')).toEqual({
      minFiles: 2,
      files: { "a.test.ts": 3, "b.test.sh": 4 },
    });
  });
});

describe("gate floors", () => {
  const manifest = { minFiles: 3, files: { "scripts/a.test.ts": 10, "scripts/b.test.ts": 4, ".deploy/tests/ship.test.sh": 81 } };
  const healthy = results([
    ["scripts/a.test.ts", 10, 0],
    ["scripts/b.test.ts", 5, 0],
    [".deploy/tests/ship.test.sh", 81, 0],
  ]);

  test("[unit] #87 every file at or above its floor passes", () => {
    expect(checkCounts(manifest, healthy)).toEqual([]);
  });

  test("[unit] #87 negative control: deleting one test fails the gate naming the file and both counts", () => {
    const fewer = new Map(healthy);
    fewer.set(".deploy/tests/ship.test.sh", { passed: 80, failed: 0 });
    expect(checkCounts(manifest, fewer)).toEqual([".deploy/tests/ship.test.sh: 80 passed, floor 81"]);
  });

  test("[unit] #87 negative control: deleting a file (or bun not discovering it) fails the gate naming it", () => {
    const missing = new Map(healthy);
    missing.delete("scripts/b.test.ts");
    expect(checkCounts(manifest, missing)).toEqual([
      "scripts/b.test.ts: not run (floor 4)",
      "files: 2 ran, floor 3",
    ]);
  });

  test("[unit] #87 a failing test fails the gate even above the floor", () => {
    const red = new Map(healthy);
    red.set("scripts/a.test.ts", { passed: 10, failed: 1 });
    expect(checkCounts(manifest, red)).toEqual(["scripts/a.test.ts: 1 failed"]);
  });

  test("[unit] #87 a test file with no floor fails until its floor is committed", () => {
    const extra = new Map(healthy);
    extra.set("scripts/c.test.ts", { passed: 2, failed: 0 });
    expect(checkCounts(manifest, extra)).toEqual(["scripts/c.test.ts: no floor in .deploy/tests/expected-counts.json (2 passed)"]);
  });
});

describe("committed floors", () => {
  const manifest = parseManifest(readFileSync(join(root, ".deploy/tests/expected-counts.json"), "utf8"));

  test("[unit] #87 AC3 floors are at least the issue's seeds: ship 81, backstage-setup 89, bun 571 across 42 files", () => {
    expect(manifest.files[".deploy/tests/ship.test.sh"]).toBeGreaterThanOrEqual(81);
    expect(manifest.files[".deploy/tests/backstage-setup.test.sh"]).toBeGreaterThanOrEqual(89);
    const bunFiles = Object.entries(manifest.files).filter(([file]) => file.endsWith(".ts"));
    expect(bunFiles.length).toBeGreaterThanOrEqual(42);
    expect(bunFiles.reduce((sum, [, floor]) => sum + floor, 0)).toBeGreaterThanOrEqual(571);
  });

  test("[unit] #87 the 28 tests in .deploy/backstage-package.test.ts are floored through the file bun discovers", () => {
    expect(manifest.files["scripts/backstage-package.test.ts"]).toBeGreaterThanOrEqual(28);
  });

  test("[unit] #87 minFiles equals the number of floored files", () => {
    expect(manifest.minFiles).toBe(Object.keys(manifest.files).length);
  });
});
