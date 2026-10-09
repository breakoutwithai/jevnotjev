import { expect, test } from "bun:test";
import { join } from "node:path";
import { assertReleaseOutput, command, formatCheck, summarizeChecks } from "./release-check.ts";

test("[unit] RELEASE-CHECK-TIMEOUT names the timed out step", () => {
  expect(() => command([process.execPath, "-e", "Bun.sleepSync(200)"], import.meta.dir, {}, "cli timeout probe", 10)).toThrow("cli timeout probe timed out after 10 ms");
});

test("[unit] RELEASE-CHECK-ARMS requires all four documented arms", () => {
  expect(() => assertReleaseOutput("arms", { arms: [] })).toThrow("documented arms missing");
  expect(() => assertReleaseOutput("arms", { arms: ["jev", "decisions", "llm", "rule"].map((arm) => ({ arm })) })).not.toThrow();
  expect(() => assertReleaseOutput("arms", { arms: ["jev", "decisions", "llm", "rule", "extra"].map((arm) => ({ arm })) })).toThrow("documented arms missing");
});

const expectedRun = { caseIds: ["m01", "m02"], arms: ["jev"] };

test("[unit] RELEASE-CHECK-ESTIMATE rejects one fewer call and wrong case count", () => {
  expect(() => assertReleaseOutput("estimate", { cases: 2, calls: 1, costUsd: 0.000035658 }, expectedRun)).toThrow("expected 2 calls");
  expect(() => assertReleaseOutput("estimate", { cases: 1, calls: 2, costUsd: 0.000035658 }, expectedRun)).toThrow("expected 2 cases");
  expect(() => assertReleaseOutput("estimate", { cases: 2, calls: 2, costUsd: 0.000035658 }, expectedRun)).not.toThrow();
});

test("[unit] RELEASE-CHECK-ESTIMATE requires a positive finite cost", () => {
  const valid = { cases: 2, calls: 2, costUsd: 0.000035658 };
  expect(() => assertReleaseOutput("estimate", valid, expectedRun)).not.toThrow();
  for (const costUsd of [undefined, 0, -1, null, "broken"]) {
    expect(() => assertReleaseOutput("estimate", { ...valid, costUsd }, expectedRun)).toThrow("expected positive finite costUsd");
  }
});

test("[unit] RELEASE-CHECK-VERDICT requires the expected named verdict", () => {
  for (const verdict of ["use Jev", "don't use Jev", "not enough evidence"]) {
    expect(() => assertReleaseOutput("verdict", { exit_code: 0, verdicts: [] }, verdict)).toThrow("expected exactly one verdict");
    expect(() => assertReleaseOutput("verdict", { verdicts: [{ verdict }] }, verdict)).not.toThrow();
    expect(() => assertReleaseOutput("verdict", { verdicts: [{ verdict }, { verdict: "contradictory" }] }, verdict)).toThrow("expected exactly one verdict");
  }
});

test("[unit] RELEASE-CHECK-FIXTURE rejects one missing row and the wrong case-arm set", () => {
  const records = "format_version,case_id,answerer,outcome\njnj-record/1.2,m01,jev,answered\njnj-record/1.2,m02,jev,answered\n";
  expect(() => assertReleaseOutput("fixture run", { rows: 1 }, expectedRun, records)).toThrow("expected 2 rows");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records.replace("jnj-record/1.2,m02,jev,answered\n", ""))).toThrow("expected 2 record rows");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records.replace("m02", "m01"))).toThrow("case-arm set differs");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records.replace("m02,jev,answered", "m02,jev,error"))).toThrow("expected every row answered");
  expect(() => assertReleaseOutput("fixture run", { rows: 2 }, expectedRun, records)).not.toThrow();
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
