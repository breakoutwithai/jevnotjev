import { test, expect } from "bun:test";
import { checkRelease } from "./backstage-package.ts";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("[unit] B67 release package requires matching SHA and complete paired artifacts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "backstage-package-"));
  try {
    await mkdir(join(dir, "site/backstage"), { recursive: true });
    await Bun.write(
      join(dir, "release.json"),
      JSON.stringify({ version: "a".repeat(40) }),
    );
    await expect(checkRelease(dir, "b".repeat(40))).rejects.toThrow();
    await expect(checkRelease(dir, "a".repeat(40))).rejects.toThrow();
    for (const path of [
      "server.js",
      "site/backstage/index.html",
      "site/backstage/app.js",
    ])
      await Bun.write(join(dir, path), "artifact");
    const files = await checkRelease(dir, "a".repeat(40));
    expect(files.length).toBe(4);
    await Bun.write(join(dir, ".env"), "secret");
    await expect(checkRelease(dir, "a".repeat(40))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("[unit] B67 deploy dry run is inert and unknown options fail closed", () => {
  const run = Bun.spawnSync(
    ["bash", ".deploy/backstage-deploy.sh", "--dry-run"],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(run.exitCode).toBe(0);
  expect(new TextDecoder().decode(run.stdout)).toContain("Would promote");
  expect(
    Bun.spawnSync(["bash", ".deploy/backstage-deploy.sh", "--not-a-flag"], {
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode,
  ).not.toBe(0);
  expect(
    Bun.spawnSync(
      [
        "bash",
        ".deploy/backstage-deploy.sh",
        "--rollback",
        "unsafe;command",
        "--dry-run",
      ],
      { stdout: "pipe", stderr: "pipe" },
    ).exitCode,
  ).not.toBe(0);
});
test("[unit] B67 deployment distinguishes absent, linked and unreachable current release", () => {
  const run = (probe: string, status: string) =>
    Bun.spawnSync(
      [
        "bash",
        "-c",
        'source .deploy/backstage-lib.sh; remote(){ printf "%s" "$PROBE"; return "$PROBE_STATUS"; }; backstage_previous_release /var/www/jevnotjev-backstage-current',
      ],
      {
        env: { ...process.env, PROBE: probe, PROBE_STATUS: status },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
  const absent = run("ABSENT", "0");
  expect(absent.exitCode).toBe(0);
  expect(new TextDecoder().decode(absent.stdout)).toBe("");
  const sha = "a".repeat(40);
  const linked = run(`LINK:/var/www/jevnotjev-backstage-releases/${sha}`, "0");
  expect(linked.exitCode).toBe(0);
  expect(new TextDecoder().decode(linked.stdout).trim()).toBe(
    `/var/www/jevnotjev-backstage-releases/${sha}`,
  );
  for (const [probe, status] of [
    ["", "255"],
    ["", "0"],
    ["ABSENT", "255"],
    ["FOREIGN", "0"],
    ["LINK:/tmp/other", "0"],
  ])
    expect(run(probe ?? "", status ?? "").exitCode).not.toBe(0);
});
test("[unit] B67 deployment rejects untracked shippable source before building", () => {
  const script =
    'source .deploy/backstage-lib.sh; git(){ case "$*" in *--untracked-files=all*"src site scripts .deploy package.json bun.lock tsconfig.json"*) printf "%s" "$DIRTY_SOURCE" ;; *) return 2 ;; esac; }; backstage_clean_sources';
  for (const dirty of [
    "?? src/helper.ts",
    "?? site/private.json",
    " M scripts/backstage-build.ts",
  ])
    expect(
      Bun.spawnSync(["bash", "-c", script], {
        env: { ...process.env, DIRTY_SOURCE: dirty },
        stdout: "pipe",
        stderr: "pipe",
      }).exitCode,
    ).not.toBe(0);
  expect(
    Bun.spawnSync(["bash", "-c", script], {
      env: { ...process.env, DIRTY_SOURCE: "" },
      stdout: "pipe",
      stderr: "pipe",
    }).exitCode,
  ).toBe(0);
});
test("[unit] B67 nginx locations preserve inherited security headers", async () => {
  expect(await Bun.file(".deploy/backstage-nginx.conf").text()).not.toMatch(
    /^\s*add_header\s/m,
  );
});
