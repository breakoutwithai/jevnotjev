import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertReleaseOutput, command, formatCheck, summarizeChecks } from "./release-check.ts";

test("[unit] RELEASE-CHECK-TIMEOUT names the timed out step", () => {
  expect(() => command([process.execPath, "-e", "Bun.sleepSync(200)"], import.meta.dir, {}, "cli timeout probe", 10)).toThrow("cli timeout probe timed out after 10 ms");
});

test("[unit] RELEASE-CHECK-ARMS requires all four documented arms", () => {
  expect(() => assertReleaseOutput("arms", { arms: [] })).toThrow("documented arms missing");
  expect(() => assertReleaseOutput("arms", { arms: ["jev", "decisions", "llm", "rule"].map((arm) => ({ arm })) })).not.toThrow();
});

test("[unit] RELEASE-CHECK-ESTIMATE rejects zero calls and cost", () => {
  expect(() => assertReleaseOutput("estimate", { calls: 0, costUsd: 0 })).toThrow("positive calls and cost missing");
  expect(() => assertReleaseOutput("estimate", { calls: 2, costUsd: 0.01 })).not.toThrow();
});

test("[unit] RELEASE-CHECK-VERDICT requires the expected named verdict", () => {
  for (const verdict of ["use Jev", "don't use Jev", "not enough evidence"]) {
    expect(() => assertReleaseOutput("verdict", { exit_code: 0, verdicts: [] }, verdict)).toThrow("expected verdict missing");
    expect(() => assertReleaseOutput("verdict", { verdicts: [{ verdict }] }, verdict)).not.toThrow();
  }
});

test("[unit] RELEASE-CHECK-FIXTURE requires a positive row count and an answered record", () => {
  expect(() => assertReleaseOutput("fixture run", { rows: 1 }, undefined, "outcome\nerror\n")).toThrow("answered record missing");
  expect(() => assertReleaseOutput("fixture run", { rows: 0 }, undefined, "outcome\nanswered\n")).toThrow("positive row count missing");
  expect(() => assertReleaseOutput("fixture run", { rows: 1 }, undefined, "outcome\nanswered\n")).not.toThrow();
});

test("[unit] RELEASE-CHECK-LINES formats one pass and one failure with a reason", () => {
  expect(formatCheck({ name: "cli help", ok: true })).toBe("PASS cli help");
  expect(formatCheck({ name: "mcp validate", ok: false, reason: "wrong exit code" })).toBe("FAIL mcp validate: wrong exit code");
});

test("[unit] RELEASE-CHECK-SUMMARY succeeds only for a nonempty all-pass set", () => {
  expect(summarizeChecks([])).toEqual({ line: "release-check: FAIL 0/0", exitCode: 1 });
  expect(summarizeChecks([{ name: "a", ok: true }, { name: "b", ok: true }])).toEqual({ line: "release-check: PASS 2/2", exitCode: 0 });
  expect(summarizeChecks([{ name: "a", ok: true }, { name: "b", ok: false, reason: "bad" }])).toEqual({ line: "release-check: FAIL 1/2", exitCode: 1 });
});

test("[integration] RELEASE-CHECK-FRESH relative repo runs every CLI and MCP check from a local fresh clone", () => {
  const root = join(import.meta.dir, "..");
  const done = Bun.spawnSync([process.execPath, "scripts/release-check.ts", "--repo", ".", "--ref", "HEAD"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const output = done.stdout.toString();
  expect(done.exitCode, `${output}\n${done.stderr.toString()}`).toBe(0);
  const names = output.split("\n").filter((line) => line.startsWith("PASS ")).map((line) => line.slice(5));
  expect(names).toEqual([
    "fresh clone", "frozen install", "cli help", "cli arms", "cli estimate", "cli validate valid", "cli validate invalid",
    "cli verdict use", "cli verdict insufficient", "cli verdict reject", "cli fixture run", "cli validate fixture records",
    "mcp tools/list", "mcp validate", "mcp verdict",
  ]);
  expect(output).toMatch(/release-check: PASS 15\/15\s*$/);
}, 120_000);
