import { expect, test } from "bun:test";
import { join } from "node:path";
import { formatCheck, summarizeChecks } from "./release-check.ts";

test("[unit] RELEASE-CHECK-LINES formats one pass and one failure with a reason", () => {
  expect(formatCheck({ name: "cli help", ok: true })).toBe("PASS cli help");
  expect(formatCheck({ name: "mcp validate", ok: false, reason: "wrong exit code" })).toBe("FAIL mcp validate: wrong exit code");
});

test("[unit] RELEASE-CHECK-SUMMARY succeeds only for a nonempty all-pass set", () => {
  expect(summarizeChecks([])).toEqual({ line: "release-check: FAIL 0/0", exitCode: 1 });
  expect(summarizeChecks([{ name: "a", ok: true }, { name: "b", ok: true }])).toEqual({ line: "release-check: PASS 2/2", exitCode: 0 });
  expect(summarizeChecks([{ name: "a", ok: true }, { name: "b", ok: false, reason: "bad" }])).toEqual({ line: "release-check: FAIL 1/2", exitCode: 1 });
});

test("[integration] RELEASE-CHECK-FRESH current HEAD passes at least ten checks from a local fresh clone", () => {
  const root = join(import.meta.dir, "..");
  const done = Bun.spawnSync([process.execPath, "scripts/release-check.ts", "--repo", root, "--ref", "HEAD"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = done.stdout.toString();
  expect(done.exitCode, `${output}\n${done.stderr.toString()}`).toBe(0);
  const match = output.match(/release-check: PASS (\d+)\/\1\s*$/);
  expect(match, output).not.toBeNull();
  expect(Number(match?.[1])).toBeGreaterThanOrEqual(10);
});
