// Prints the repository files the Backstage build bundles, one per line, sorted: the relative
// import graph of every entrypoint in scripts/backstage-build.ts, resolved inside a source root.
// ship.sh runs it on a `git archive` of origin/main so Backstage drift follows the build, not a
// hand-kept path list. Package imports are not followed: package.json and bun.lock cover them.
//
// Usage: bun .deploy/backstage-deps.ts <source root>
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BACKSTAGE_BUILD_TARGETS } from "../scripts/backstage-build.ts";

const SCANNED = /\.(ts|tsx|js|jsx|mts|mjs)$/;

export function backstageEntrypoints(): string[] {
  return BACKSTAGE_BUILD_TARGETS.map(([entry]) => entry);
}

export function backstageDependencies(
  sourceRoot: string,
  entries: readonly string[] = backstageEntrypoints(),
): string[] {
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

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: bun .deploy/backstage-deps.ts <source root>");
  const files = backstageDependencies(resolve(root));
  if (files.length === 0) throw new Error("Backstage import graph is empty.");
  console.log(files.join("\n"));
}
