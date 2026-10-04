import { expect, test } from "bun:test";
import { buildBackstage } from "../../scripts/backstage-build.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { open, unlink, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
async function digest(path: string) {
  return createHash("sha256")
    .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
    .digest("hex");
}
test("[integration] B8 browser/backend build reproduces exact bytes and excludes secret/server code", async () => {
  const out = await buildBackstage();
  const paths = ["site/backstage/app.js", "server.js", "release.json"];
  const before = await Promise.all(paths.map((p) => digest(`${out}/${p}`)));
  const second = await buildBackstage();
  expect(await Promise.all(paths.map((p) => digest(`${second}/${p}`)))).toEqual(
    before,
  );
  const bundle = await Bun.file(`${out}/site/backstage/app.js`).text();
  expect(bundle).not.toContain("api.typesafe.ai");
  expect(bundle).not.toContain("api.anthropic.com");
  expect(bundle).not.toContain("node:");
  expect(bundle).not.toContain("test-secret");
});

test("[integration] B8 untracked site assets cannot enter a reviewed release", async () => {
  const path = `site/unreviewed-backstage-${crypto.randomUUID()}.txt`;
  const file = await open(path, "wx");
  try {
    await file.writeFile("private-unreviewed-canary");
    await file.close();
    const out = await buildBackstage();
    expect(await Bun.file(`${out}/${path}`).exists()).toBe(false);
  } finally {
    await file.close();
    await unlink(path);
  }
});
test("[integration] B8 concurrent builds keep distinct complete immutable directories", async () => {
  const outputs = await Promise.all([buildBackstage(), buildBackstage()]);
  expect(outputs[0]).not.toBe(outputs[1]);
  for (const out of outputs)
    expect(await Bun.file(`${out}/site/backstage/backstage.css`).exists()).toBe(
      true,
    );
});
test("[integration] B8 built server rejects an environment revision differing from artifact", async () => {
  const out = await buildBackstage();
  const child = Bun.spawn(["bun", `${out}/server.js`], {
    env: { ...process.env, BACKSTAGE_VERSION: "b".repeat(40) },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 2000);
  try {
    expect(await child.exited).not.toBe(0);
    expect(await new Response(child.stderr).text()).toContain(
      "compiled server revision",
    );
  } finally {
    clearTimeout(timer);
    child.kill();
  }
});
test("[integration] B8 production build ignores dirty working sources and uses approved Git snapshot", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "backstage-source-test-"));
  try {
    for (const directory of ["site/backstage", "src/backstage"])
      await mkdir(join(fixture, directory), { recursive: true });
    for (const path of [
      "site/backstage/index.html",
      "site/backstage/backstage.css",
    ])
      await Bun.write(join(fixture, path), "committed-asset");
    for (const path of ["src/backstage/main.ts", "src/backstage/server.ts"])
      await Bun.write(join(fixture, path), 'console.info("committed-source");');
    for (const args of [
      ["init"],
      ["add", "."],
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "fixture",
      ],
    ]) {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: fixture,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
    }
    await Bun.write(
      join(fixture, "src/backstage/main.ts"),
      "invalid working source that cannot compile",
    );
    await Bun.write(
      join(fixture, "site/backstage/index.html"),
      "unapproved-asset",
    );
    const out = await buildBackstage(fixture, true);
    expect(await Bun.file(`${out}/site/backstage/index.html`).text()).toBe(
      "committed-asset",
    );
    expect(await Bun.file(`${out}/site/backstage/app.js`).text()).toContain(
      "committed-source",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
