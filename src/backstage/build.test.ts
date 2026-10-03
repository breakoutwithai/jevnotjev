import { expect, test } from "bun:test";
import { buildBackstage } from "../../scripts/backstage-build.ts";
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
  await buildBackstage();
  expect(await Promise.all(paths.map((p) => digest(`${out}/${p}`)))).toEqual(
    before,
  );
  const bundle = await Bun.file(`${out}/site/backstage/app.js`).text();
  expect(bundle).not.toContain("api.typesafe.ai");
  expect(bundle).not.toContain("api.anthropic.com");
  expect(bundle).not.toContain("node:");
  expect(bundle).not.toContain("test-secret");
});

test("[integration] B8 untracked site assets cannot enter a reviewed release", async () => {
  const path = "site/unreviewed-backstage-canary.txt";
  try {
    await Bun.write(path, "private-unreviewed-canary");
    const out = await buildBackstage();
    expect(await Bun.file(`${out}/${path}`).exists()).toBe(false);
  } finally {
    await Bun.file(path).delete();
  }
});
