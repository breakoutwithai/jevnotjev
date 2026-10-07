import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fresh-clone.sh", import.meta.url));
interface Fixture { readonly root: string; readonly repo: string; readonly out: string; readonly temp: string; readonly sha: string }
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "jnj-134-clone-"));
  const repo = join(root, "source");
  const temp = join(root, "temporary");
  const out = join(root, "evidence");
  await mkdir(repo); await mkdir(temp);
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  git(repo, "add", "tracked.txt");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "fixture");
  return { root, repo, out, temp, sha: git(repo, "rev-parse", "HEAD") };
}
function run(f: Fixture, options: { readonly driver?: string; readonly ref?: string; readonly out?: string } = {}) {
  return spawnSync("bash", [SCRIPT, "--repo", f.repo, "--ref", options.ref ?? "main", "--out", options.out ?? f.out], {
    encoding: "utf8",
    env: { ...process.env, TMPDIR: f.temp, UAT_INSTALL_CMD: "true", UAT_START_CMD: "true", UAT_DRIVER_CMD: options.driver ?? "true", UAT_HEALTH_URL: "skip" },
  });
}
async function withFixture(runTest: (f: Fixture) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await runTest(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}

describe("#134 fresh clone", () => {
  test("[integration] #134 row 31 clean clone succeeds and reports SHA and empty status", async () => withFixture(async (f) => {
    const result = run(f);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(f.sha);
    expect(result.stdout).toContain("git status --porcelain: empty");
  }));
  test("[integration] #134 row 32 RED3 tracked edit in driver fails", async () => withFixture(async (f) => {
    const result = run(f, { driver: "printf dirty > tracked.txt" });
    expect(result.status).toBe(1);
  }));
  test("[integration] #134 row 33 untracked file in driver fails", async () => withFixture(async (f) => {
    const result = run(f, { driver: "touch untracked.txt" });
    expect(result.status).toBe(1);
  }));
  test("[integration] #134 row 34 driver exit 3 makes script nonzero", async () => withFixture(async (f) => {
    const result = run(f, { driver: "exit 3" });
    expect(result.status).not.toBe(0);
  }));
  test("[integration] #134 row 35 --ref selects a different committed branch", async () => withFixture(async (f) => {
    git(f.repo, "checkout", "-qb", "other");
    await writeFile(join(f.repo, "tracked.txt"), "other branch\n");
    git(f.repo, "add", "tracked.txt");
    git(f.repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "other branch");
    const otherSha = git(f.repo, "rev-parse", "HEAD");
    const marker = join(f.root, "other-branch-verified");
    const result = run(f, { ref: "other", driver: `test "$(cat tracked.txt)" = 'other branch' && touch '${marker}'` });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(otherSha);
    expect(existsSync(marker)).toBe(true);
    expect(otherSha).not.toBe(f.sha);
  }));
  test("[integration] #134 row 36 dirty source working tree does not enter clone", async () => withFixture(async (f) => {
    await writeFile(join(f.repo, "tracked.txt"), "uncommitted\n");
    const marker = join(f.root, "committed-clone-verified");
    const result = run(f, { driver: `test "$(cat tracked.txt)" = committed && touch '${marker}'` });
    expect(result.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(await readFile(join(f.repo, "tracked.txt"), "utf8")).toBe("uncommitted\n");
  }));
  test("[integration] #134 row 37 evidence lives outside removed temporary clone on success and failure", async () => withFixture(async (f) => {
    const success = run(f);
    expect(success.status).toBe(0);
    expect((await readdir(f.root)).includes("evidence")).toBe(true);
    expect(await readdir(f.temp)).toEqual([]);
    const failed = run(f, { out: join(f.root, "failed-evidence"), driver: "touch untracked.txt" });
    expect(failed.status).toBe(1);
    expect((await readdir(f.root)).includes("failed-evidence")).toBe(true);
    expect(await readdir(f.temp)).toEqual([]);
  }));
  test("[integration] #134 git status failure never reports an empty clone", async () => withFixture(async (f) => {
    const result = run(f, { driver: "rm -rf .git" });
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("git status --porcelain: empty");
    expect(result.stderr).toContain("git status failed");
  }));
  test("[integration] #134 validates only records produced after this run began", async () => withFixture(async (f) => {
    await mkdir(f.out);
    await writeFile(join(f.out, "records.csv"), "bad old evidence\n");
    const result = run(f);
    expect(result.status).toBe(0);
  }));
});

// Run output never enters the repo: there is no default output folder, and the driver refuses an --out
// inside the git work tree it runs from.
const DRIVER = fileURLToPath(new URL("./backstage-happy-path.ts", import.meta.url));
describe("#134 output stays outside the repo", () => {
  test("[integration] #134 fresh-clone.sh without --out exits 2", () => {
    const result = spawnSync("bash", [SCRIPT, "--repo", "unused", "--ref", "main"], { encoding: "utf8" });
    expect(result.status).toBe(2);
  });
  test("[integration] #134 driver without --out exits 2", () => {
    const result = spawnSync("bun", [DRIVER, "--dry-run"], { encoding: "utf8" });
    expect(result.status).toBe(2);
  });
  test("[integration] #134 driver refuses an --out inside the git work tree it runs from", async () => withFixture(async (f) => {
    const result = spawnSync("bun", [DRIVER, "--dry-run", "--out", join(f.repo, "docs", "uat"), "--base", "http://127.0.0.1:9"], { cwd: f.repo, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("outside the repository");
    expect(existsSync(join(f.repo, "docs"))).toBe(false);
    expect(git(f.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }));
  test("[integration] #134 control: an --out outside the work tree passes the guard", async () => withFixture(async (f) => {
    // No server listens on port 9, so the run stops at the health check; the point is that the guard let it through.
    const result = spawnSync("bun", [DRIVER, "--dry-run", "--out", f.out, "--base", "http://127.0.0.1:9"], { cwd: f.repo, encoding: "utf8" });
    expect(result.status).not.toBe(2);
    expect(result.stderr).not.toContain("outside the repository");
    expect(git(f.repo, "status", "--porcelain", "--untracked-files=all")).toBe("");
  }));
  test("[integration] #134 an inherited GIT_WORK_TREE cannot move the check to another tree", async () => withFixture(async (f) => {
    const env = { ...process.env, GIT_WORK_TREE: f.temp, GIT_DIR: join(f.temp, "none") };
    const result = spawnSync("bun", [DRIVER, "--dry-run", "--out", join(f.repo, "docs"), "--base", "http://127.0.0.1:9"], { cwd: f.repo, encoding: "utf8", env });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("outside the repository");
  }));
});
