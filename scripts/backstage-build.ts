import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

/** Entrypoint, target, output dir and file name of each bundle. ship.sh drift reads the entrypoints. */
export const BACKSTAGE_BUILD_TARGETS = [
  ["src/backstage/main.ts", "browser", "site/backstage", "app.js"],
  ["src/backstage/server.ts", "bun", "", "server.js"],
] as const;

/** Build both sides off-host from the same revision. No credentials are read. */
export async function buildBackstage(
  root = process.cwd(),
  committed = false,
): Promise<string> {
  const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root });
  if (git.exitCode !== 0) throw new Error("Cannot identify build revision.");
  const version = git.stdout.toString().trim();
  if (!/^[a-f0-9]{40}$/.test(version)) throw new Error("Invalid revision.");
  let sourceRoot = root;
  let snapshot: string | undefined;
  if (committed) {
    snapshot = await mkdtemp(join(tmpdir(), "backstage-source-"));
    const archive = Bun.spawnSync(["git", "archive", "--format=tar", version], {
      cwd: root,
    });
    if (archive.exitCode !== 0) {
      await rm(snapshot, { recursive: true, force: true });
      throw new Error("Cannot snapshot approved revision.");
    }
    const unpack = Bun.spawnSync(["tar", "-xf", "-", "-C", snapshot], {
      stdin: archive.stdout,
    });
    if (unpack.exitCode !== 0) {
      await rm(snapshot, { recursive: true, force: true });
      throw new Error("Cannot unpack approved revision.");
    }
    sourceRoot = snapshot;
  }
  try {
    await mkdir(join(root, "dist"), { recursive: true });
    const out = await mkdtemp(join(root, "dist/backstage-build-"));
    const listed = Bun.spawnSync(
      committed
        ? ["git", "ls-tree", "-rz", "--name-only", version, "--", "site"]
        : ["git", "ls-files", "-z", "--", "site"],
      {
        cwd: root,
      },
    );
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
      await copyFile(join(sourceRoot, path), join(out, path));
    }
    for (const [entry, target, outdir, naming] of BACKSTAGE_BUILD_TARGETS) {
      if (
        !entry ||
        (!outdir && outdir !== "") ||
        !naming ||
        (target !== "browser" && target !== "bun")
      )
        throw new Error("Invalid build target.");
      const built = await Bun.build({
        entrypoints: [join(sourceRoot, entry)],
        target,
        outdir: join(out, outdir),
        naming,
        minify: true,
        define: { BACKSTAGE_BUILD_VERSION: JSON.stringify(version) },
      });
      if (!built.success)
        throw new AggregateError(built.logs, "Backstage build failed.");
    }
    const contracts = await Bun.file(
      join(sourceRoot, "src/backstage/contracts.ts"),
    ).text();
    const protocol =
      /export const PROTOCOL_VERSION = "(backstage\/[12])";/.exec(
        contracts,
      )?.[1];
    if (!protocol) throw new Error("Cannot identify source protocol.");
    await Bun.write(
      join(out, "release.json"),
      JSON.stringify({ version, protocol, issue: 67, gate: "session" }) + "\n",
    );
    return out;
  } finally {
    if (snapshot) await rm(snapshot, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const flags = process.argv.slice(2);
  if (flags.some((flag) => flag !== "--committed"))
    throw new Error("Unknown build flag.");
  console.info(
    await buildBackstage(process.cwd(), flags.includes("--committed")),
  );
}
