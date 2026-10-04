// Prints the repository files the Backstage build bundles, one per line, sorted: the relative
// import graph of every entrypoint in the SCANNED root's scripts/backstage-build.ts. ship.sh runs
// it on a `git archive` of origin/main, so both the entrypoints and the graph are origin/main's,
// never the local checkout's. Package imports are not followed: package.json and bun.lock cover
// them.
//
// Usage: bun .deploy/backstage-deps.ts <source root>
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const SCANNED = /\.(ts|tsx|js|jsx|mts|mjs)$/;

/** Entrypoints of BACKSTAGE_BUILD_TARGETS exported by <root>/scripts/backstage-build.ts. */
export async function backstageEntrypoints(sourceRoot: string): Promise<string[]> {
  const script = join(realpathSync(sourceRoot), "scripts/backstage-build.ts");
  const loaded: unknown = await import(pathToFileURL(script).href);
  if (typeof loaded !== "object" || loaded === null || !("BACKSTAGE_BUILD_TARGETS" in loaded))
    throw new Error(`${script} does not export BACKSTAGE_BUILD_TARGETS`);
  const targets: unknown = loaded.BACKSTAGE_BUILD_TARGETS;
  if (!Array.isArray(targets) || targets.length === 0)
    throw new Error(`${script}: BACKSTAGE_BUILD_TARGETS is not a non-empty list`);
  return targets.map((target: unknown) => {
    if (!Array.isArray(target)) throw new Error(`${script}: a build target is not a list`);
    const entry: unknown = target[0];
    if (typeof entry !== "string" || entry === "")
      throw new Error(`${script}: a build target has no entrypoint path`);
    return entry;
  });
}

export function backstageDependencies(sourceRoot: string, entries: readonly string[]): string[] {
  // Real paths on both sides: the resolver returns them (macOS /var is /private/var).
  const root = realpathSync(sourceRoot);
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const seen = new Set<string>();
  const queue = entries.map((entry) => realpathSync(resolve(root, entry)));
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    const rel = relative(root, file);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error(`Backstage import outside the source root: ${file}`);
    seen.add(file);
    if (!SCANNED.test(file)) continue;
    for (const found of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!found.path.startsWith(".")) continue;
      queue.push(realpathSync(Bun.resolveSync(found.path, dirname(file))));
    }
  }
  return [...seen].map((file) => relative(root, file).split(sep).join("/")).sort();
}

/** The whole graph of a source root, entrypoints included, both read from that root. */
export async function backstageGraph(sourceRoot: string): Promise<string[]> {
  return backstageDependencies(sourceRoot, await backstageEntrypoints(sourceRoot));
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: bun .deploy/backstage-deps.ts <source root>");
  const files = await backstageGraph(resolve(root));
  if (files.length === 0) throw new Error("Backstage import graph is empty.");
  console.log(files.join("\n"));
}
