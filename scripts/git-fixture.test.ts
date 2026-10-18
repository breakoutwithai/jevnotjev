import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const HELPER = join(ROOT, ".deploy/tests/git-fixture.sh");
const SUITES = ["ship", "branch-guard", "monitor", "release", "verify"];
const scratch: string[] = [];
const GIT_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
const cleanEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !GIT_ENV.includes(entry[0])));
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { env: cleanEnv(), encoding: "utf8" }).trim();

function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), "jnj-fixture-sentinel-"));
  scratch.push(path);
  return path;
}

afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function sentinel(): string {
  const path = temporary();
  git(path, "init", "-q", "--initial-branch=main", "--template=");
  git(path, "config", "user.name", "Sentinel Actor");
  git(path, "config", "user.email", "sentinel@example.test");
  git(path, "config", "commit.gpgsign", "false");
  git(path, "config", "tag.gpgsign", "false");
  git(path, "config", "core.bare", "false");
  git(path, "remote", "add", "origin", join(path, "unreachable-local-origin.git"));
  writeFileSync(join(path, "sentinel.txt"), "unchanged sentinel worktree\n");
  git(path, "add", "sentinel.txt");
  git(path, "commit", "-qm", "sentinel base");
  git(path, "tag", "sentinel-release");
  git(path, "update-ref", "refs/remotes/origin/main", git(path, "rev-parse", "HEAD"));
  return path;
}

function snapshot(path: string): object {
  return {
    config: readFileSync(join(path, ".git/config"), "utf8"),
    head: readFileSync(join(path, ".git/HEAD"), "utf8"),
    refs: git(path, "for-each-ref", "--format=%(refname) %(objectname)"),
    index: readFileSync(join(path, ".git/index")).toString("hex"),
    worktree: readFileSync(join(path, "sentinel.txt"), "utf8"),
  };
}

function helper(command: string, root: string, target: string) {
  return Bun.spawnSync(["bash", "-c", 'source "$1" && ' + command, "fixture-guard", HELPER, root, target], { cwd: ROOT, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
}

test("[unit] 240 fixture init rejects escaped and symlinked destinations before writing", () => {
  const root = temporary();
  const outside = sentinel();
  const before = snapshot(outside);
  scratch.push(`${root}-escaped.git`);
  const link = join(root, "escape");
  symlinkSync(outside, link);
  for (const target of [outside, `${root}-escaped.git`, link, join(link, "nested.git")]) {
    const result = helper('fixture_init "$2" "$3" --bare', root, target);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("fixture safety:");
    expect(snapshot(outside)).toEqual(before);
  }
  expect(existsSync(`${root}-escaped.git`)).toBe(false);
  expect(existsSync(join(outside, "nested.git"))).toBe(false);
});

test("[unit] 240 fixture guard rejects symlinked roots and an escaped gitdir before config writes", () => {
  const root = temporary();
  const outside = sentinel();
  const before = snapshot(outside);
  const linkedRoot = join(root, "linked-root");
  symlinkSync(outside, linkedRoot);
  expect(helper('fixture_init "$2" "$3" --bare', linkedRoot, join(linkedRoot, "new.git")).exitCode).not.toBe(0);
  const work = join(root, "work");
  execFileSync("mkdir", [work]);
  symlinkSync(join(outside, ".git"), join(work, ".git"));
  const result = helper('fixture_assert_repository "$2" "$3" && git -C "$3" config user.name CORRUPTED', root, work);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("fixture safety:");
  expect(helper('fixture_init "$2" "$3"', root, work).exitCode).not.toBe(0);
  expect(snapshot(outside)).toEqual(before);
  expect(existsSync(join(outside, "new.git"))).toBe(false);
});

test("[unit] 240 fixture init verifies and admits only a repository below its owned root", () => {
  const root = temporary();
  const work = join(root, "work");
  const result = helper('fixture_init "$2" "$3" --initial-branch=main && fixture_assert_repository "$2" "$3" && git -C "$3" config user.name OwnedFixture', root, work);
  expect(result.exitCode).toBe(0);
  expect(git(work, "config", "user.name")).toBe("OwnedFixture");
});

for (const suite of SUITES) {
  test(`[integration] 240 ${suite} fixture suite ignores all four inherited Git destinations`, () => {
    const path = sentinel();
    const before = snapshot(path);
    const env = { ...cleanEnv(), GIT_DIR: join(path, ".git"), GIT_WORK_TREE: path, GIT_INDEX_FILE: join(path, ".git/index"), GIT_COMMON_DIR: join(path, ".git") };
    const run = Bun.spawnSync(["bash", `.deploy/tests/${suite}.test.sh`], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe", timeout: 420_000 });
    expect(snapshot(path)).toEqual(before);
    const output = run.stdout.toString() + run.stderr.toString();
    expect(output).toMatch(/\[T1\] passed=[1-9][0-9]* failed=0/);
    expect(run.exitCode).toBe(0);
    console.info(`240 ${suite}: ${output.match(/\[T1\] passed=[1-9][0-9]* failed=0/)?.[0] ?? "missing summary"}; sentinel unchanged`);
  }, 450_000);
}

test("[unit] 240 an in-root gitdir cannot redirect common config and refs outside the fixture", () => {
  const root = temporary();
  const outside = sentinel();
  const before = snapshot(outside);
  const work = join(root, "work");
  execFileSync("mkdir", ["-p", join(work, ".git")]);
  writeFileSync(join(work, ".git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(work, ".git/commondir"), join(outside, ".git") + "\n");
  const result = helper('fixture_assert_repository "$2" "$3" && git -C "$3" config user.name CORRUPTED_COMMON', root, work);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("fixture safety:");
  expect(helper('fixture_init "$2" "$3"', root, work).exitCode).not.toBe(0);
  expect(snapshot(outside)).toEqual(before);
});

test("[unit] 240 init rejects separate-git-dir before creating an external destination", () => {
  const root = temporary();
  const external = `${root}-escape.git`;
  scratch.push(external);
  const result = helper('fixture_init "$2" "$3" --separate-git-dir "$2-escape.git"', root, join(root, "work"));
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("fixture safety:");
  expect(existsSync(external)).toBe(false);
  expect(existsSync(join(root, "work"))).toBe(false);
});

test("[unit] 240 clone rejects an escaped destination before creating files", () => {
  const root = temporary();
  const external = `${root}-escape-clone`;
  scratch.push(external);
  const source = sentinel();
  const before = snapshot(source);
  const result = helper('fixture_clone "$2" "$3" "$2-escape-clone"', root, source);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("fixture safety:");
  expect(existsSync(external)).toBe(false);
  expect(snapshot(source)).toEqual(before);
});
