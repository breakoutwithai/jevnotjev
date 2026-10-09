import { test, expect } from "bun:test";
import { join } from "node:path";
import { hasMergedMainPr } from "../.deploy/backstage-merged-pr.ts";

const REPO = join(import.meta.dir, "..");
const MERGED = "2026-10-09T10:00:00Z";
const pr = (merged_at: string | null, ref: string, body: string): Record<string, unknown> => ({ merged_at, base: { ref }, body });

test("[unit] #91 AC1 a merged main PR whose body does not mention #67 passes", () => {
  expect(hasMergedMainPr([pr(MERGED, "main", "feat(replay): page a 300-case run")])).toBe(true);
});

test("[unit] #91 AC2 an unmerged PR into main fails", () => {
  expect(hasMergedMainPr([pr(null, "main", "Refs #67")])).toBe(false);
});

test("[unit] #91 AC2 a merged PR into another branch fails", () => {
  expect(hasMergedMainPr([pr(MERGED, "release", "Refs #67")])).toBe(false);
});

test("[unit] #91 AC2 no PR, or an answer that is not a list, fails", () => {
  expect(hasMergedMainPr([])).toBe(false);
  expect(hasMergedMainPr({ message: "Not Found" })).toBe(false);
  expect(hasMergedMainPr(null)).toBe(false);
});

test("[unit] #91 one merged main PR among unmerged ones passes", () => {
  expect(hasMergedMainPr([pr(null, "main", ""), pr(MERGED, "main", "")])).toBe(true);
});

function runGate(stdin: string): number {
  const run = Bun.spawnSync(["bun", join(REPO, ".deploy/backstage-merged-pr.ts")], { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  return run.exitCode;
}

test("[integration] #91 the CLI backstage-deploy.sh pipes gh into exits 0 for a merged main PR without #67, 1 otherwise", () => {
  expect(runGate(JSON.stringify([pr(MERGED, "main", "no issue here")]))).toBe(0);
  expect(runGate(JSON.stringify([pr(null, "main", "Refs #67")]))).toBe(1);
  expect(runGate("not json")).toBe(1);
});

test("[unit] #91 backstage-deploy.sh calls this gate and no longer requires #67", async () => {
  const script = await Bun.file(join(REPO, ".deploy/backstage-deploy.sh")).text();
  expect(script).toContain("bun .deploy/backstage-merged-pr.ts");
  expect(script).not.toContain("#67\\b");
});
