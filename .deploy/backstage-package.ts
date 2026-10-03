import { readdir, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";
export async function checkRelease(
  directory: string,
  sha: string,
): Promise<string[]> {
  if (!/^[a-f0-9]{40}$/.test(sha))
    throw new Error("Release version must be a full Git SHA.");
  const raw: unknown = await Bun.file(join(directory, "release.json")).json();
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("version" in raw) ||
    raw.version !== sha
  )
    throw new Error("Release version does not match HEAD.");
  const files: string[] = [];
  async function visit(prefix: string): Promise<void> {
    for (const name of await readdir(join(directory, prefix))) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || name.startsWith("."))
        throw new Error("Hidden or unsafe release path.");
      const path = prefix ? `${prefix}/${name}` : name;
      const info = await lstat(join(directory, path));
      if (info.isSymbolicLink())
        throw new Error("Release symlinks are forbidden.");
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push(path);
      else throw new Error("Non-file release entry.");
    }
  }
  await visit("");
  for (const path of [
    "server.js",
    "site/backstage/index.html",
    "site/backstage/app.js",
  ])
    if (!files.includes(path))
      throw new Error(`Missing paired artifact: ${path}`);
  if (
    files.some(
      (path) =>
        !["server.js", "release.json"].includes(path) &&
        !path.startsWith("site/"),
    )
  )
    throw new Error("Unexpected release file.");
  return files.sort();
}
if (import.meta.main) {
  const [directory, sha, ...flags] = process.argv.slice(2);
  if (!directory || !sha || flags.some((flag) => flag !== "--dry-run"))
    throw new Error(
      "Usage: bun .deploy/backstage-package.ts directory SHA [--dry-run]",
    );
  const root = resolve(directory);
  const files = await checkRelease(root, sha);
  if (flags.includes("--dry-run"))
    console.info(`Validated ${files.length} paired artifact files for ${sha}`);
  else {
    const output = `${root}.tar.gz`;
    const result = Bun.spawnSync(
      ["tar", "-czf", output, "-C", root, ...files],
      { stdout: "inherit", stderr: "inherit" },
    );
    if (result.exitCode !== 0) throw new Error("Packaging failed.");
    console.info(output);
  }
}
