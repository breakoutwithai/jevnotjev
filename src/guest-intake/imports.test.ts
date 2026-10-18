import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const FORBIDDEN_DIRS = ["src/decide/"];
const FORBIDDEN_FILES = ["src/backstage/providers.ts", "src/backstage/api-v1.ts", "src/backstage/run.ts", "src/backstage/trial.ts", "src/backstage/server.ts"];
// node:net is absent: tickets.ts (the reused attempt limiter) imports it for isIP only.
const FORBIDDEN_MODULES = ["node:child_process", "child_process", "node:http", "node:https", "node:dgram", "node:tls", "bun:ffi"];

/** Every module reachable from `entry` through relative imports, with every bare or node: specifier it names. */
function importGraph(entries: readonly string[]): { files: Set<string>; external: Set<string> } {
  const ts = new Bun.Transpiler({ loader: "ts" });
  const tsx = new Bun.Transpiler({ loader: "tsx" });
  const js = new Bun.Transpiler({ loader: "js" });
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (files.has(file)) continue;
    files.add(file);
    // A JSON import carries data, not code.
    if (file.endsWith(".json")) continue;
    const transpiler = file.endsWith(".tsx") ? tsx : /\.(?:m?js|cjs)$/.test(file) ? js : ts;
    for (const imported of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (imported.path.startsWith(".")) queue.push(resolve(dirname(file), imported.path));
      else external.add(imported.path);
    }
  }
  return { files, external };
}

const productionModules = readdirSync(import.meta.dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(import.meta.dir, f));

test("[unit] GI-13 src/guest-intake reaches no decide, provider, server or process-spawning code", () => {
  expect(productionModules.length).toBeGreaterThanOrEqual(4);
  const { files, external } = importGraph(productionModules);
  const reached = [...files].map((f) => relative(ROOT, f));
  expect(reached.filter((f) => FORBIDDEN_DIRS.some((d) => f.startsWith(d)) || FORBIDDEN_FILES.includes(f))).toEqual([]);
  expect([...external].filter((m) => FORBIDDEN_MODULES.includes(m))).toEqual([]);
});

test("[unit] GI-13 the import check fails on a planted provider import", () => {
  const { files } = importGraph([join(ROOT, "src/backstage/server.ts")]);
  const reached = [...files].map((f) => relative(ROOT, f));
  expect(reached).toContain("src/backstage/providers.ts");
});
