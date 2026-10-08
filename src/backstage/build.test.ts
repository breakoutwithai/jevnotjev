import { PROMPT_TEMPLATE_VERSION } from "./prompt.ts";
import { expect, test, spyOn } from "bun:test";
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
  expect(bundle).toContain("curl https://api.typesafe.ai/v1/systemone");
  expect(bundle).toContain("$TYPESAFE_API_KEY");
  expect(bundle).toContain("/api/backstage/answer");
  expect(bundle).not.toContain("x-api-key");
  expect(bundle).not.toContain("BACKSTAGE_TRIAL_KEY");
  expect(bundle).not.toContain("bun:sqlite");
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
    await Bun.write(
      join(fixture, "src/backstage/contracts.ts"),
      'export const PROTOCOL_VERSION = "backstage/1";',
    );
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
    await Bun.write(
      join(fixture, "src/backstage/contracts.ts"),
      'export const PROTOCOL_VERSION = "backstage/2";',
    );
    const out = await buildBackstage(fixture, true);
    expect(await Bun.file(`${out}/release.json`).json()).toMatchObject({
      protocol: "backstage/1",
      gate: "session",
    });
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

test("[integration] #67 committed build resolves package imports from the approved lockfile and ships a self-contained server", async () => {
  const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"]).stdout.toString().trim();
  const out = await buildBackstage(process.cwd(), true);
  const { checkRelease } = await import("../../.deploy/backstage-package.ts");
  expect(await checkRelease(out, sha)).toContain("server.js");
  const server = await Bun.file(`${out}/server.js`).text();
  expect(server).not.toMatch(/from\s*"zod"|require\("zod"\)/);
  // Run the bundle where no node_modules exist above it, as on the host.
  const isolated = await mkdtemp(join(tmpdir(), "backstage-host-"));
  try {
    await Bun.write(join(isolated, "server.js"), server);
    const child = Bun.spawn(["bun", join(isolated, "server.js")], {
      cwd: isolated,
      env: { ...process.env, BACKSTAGE_VERSION: "b".repeat(40) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      expect(await child.exited).not.toBe(0);
      const stderr = await new Response(child.stderr).text();
      expect(stderr).not.toContain("Cannot find package");
      expect(stderr).toContain("compiled server revision");
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  } finally {
    await rm(isolated, { recursive: true, force: true });
  }
}, 60_000);

test("[integration] #67 committed build refuses dependencies the revision's lockfile does not pin", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "backstage-lock-test-"));
  try {
    await Bun.write(
      join(fixture, "package.json"),
      JSON.stringify({ name: "fixture", dependencies: { zod: "4.6.5" } }),
    );
    await Bun.write(join(fixture, "src/backstage/main.ts"), "export {};");
    for (const args of [
      ["init"],
      ["add", "."],
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"],
    ])
      expect(Bun.spawnSync(["git", ...args], { cwd: fixture, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    await expect(buildBackstage(fixture, true)).rejects.toThrow("Cannot install approved dependencies");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("[integration] JF1 browser transport sends paid requests only to the same-origin backend", async () => {
  const { answerTransport } = await import("./run.ts");
  const { PROTOCOL_VERSION } = await import("./contracts.ts");
  const { CATALOG_VERSION, getModelEntry } = await import("./catalog.ts");
  const entry = getModelEntry("jev");
  if (!entry) throw Error("missing Jev");
  const fetcher = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ test: true }),
  );
  try {
    expect(
      await answerTransport(
        {
          version: PROTOCOL_VERSION,
          revision: "test",
          runId: "test",
          caseId: "c1",
          armId: entry.id,
          provider: "jev",
          modelId: entry.modelId,
          catalogVersion: CATALOG_VERSION,
          promptVersion: PROMPT_TEMPLATE_VERSION,
          key: "test-routing-key",
          question: "Keep?",
          choices: [
            { name: "yes", definition: "keep" },
            { name: "no", definition: "cut" },
          ],
          input: "A case",
        },
        new AbortController().signal,
      ),
    ).toEqual({ test: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const call = fetcher.mock.calls[0];
    expect(call?.[0]).toBe("/api/backstage/answer");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
    expect(init?.redirect).toBe("error");
  } finally {
    fetcher.mockRestore();
  }
});
