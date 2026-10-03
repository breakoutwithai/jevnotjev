import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

/** Build both sides off-host from the same revision. No credentials are read. */
export async function buildBackstage(root = process.cwd()): Promise<string> {
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  if (git.exitCode !== 0) throw new Error("Cannot identify build revision.");
  const version = git.stdout.toString().trim();
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("Invalid revision.");
  const out = join(root, "dist/backstage");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "site"], {
    cwd: root,
  });
  if (listed.exitCode !== 0)
    throw new Error("Cannot enumerate tracked site assets.");
  const files = listed.stdout.toString().split("\0").filter(Boolean);
  // New Backstage sources are explicit during development; arbitrary untracked assets never ship.
  for (const path of [
    "site/backstage/index.html",
    "site/backstage/backstage.css",
  ])
    if (!files.includes(path)) files.push(path);
  for (const path of files) {
    await mkdir(dirname(join(out, path)), { recursive: true });
    await copyFile(join(root, path), join(out, path));
  }
  for (const [entry, target, outdir, naming] of [
    ["src/backstage/main.ts", "browser", "site/backstage", "app.js"],
    ["src/backstage/server.ts", "bun", "", "server.js"],
  ]) {
    if (
      !entry ||
      (!outdir && outdir !== "") ||
      !naming ||
      (target !== "browser" && target !== "bun")
    )
      throw new Error("Invalid build target.");
    const built = await Bun.build({
      entrypoints: [join(root, entry)],
      target,
      outdir: join(out, outdir),
      naming,
      minify: true,
      define: { BACKSTAGE_BUILD_VERSION: JSON.stringify(version) },
    });
    if (!built.success)
      throw new AggregateError(built.logs, "Backstage build failed.");
  }
  await Bun.write(
    join(out, "release.json"),
    JSON.stringify({ version, protocol: "backstage/1", issue: 67 }) + "\n",
  );
  return out;
}
if (import.meta.main) console.info(await buildBackstage());
