import { test, expect } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  backstageDependencies,
  backstageEntrypoints,
  backstageGraph,
} from "../.deploy/backstage-deps.ts";

const REPO = join(import.meta.dir, "..");
const TWO = ["src/backstage/main.ts", "src/backstage/server.ts"];

test("[unit] #82 Backstage drift paths come from the build entrypoints of the scanned root", async () => {
  expect(await backstageEntrypoints(REPO)).toEqual(TWO);
});

test("[unit] #82 gate P2: entrypoints are read from the archived root, not the local build script", async () => {
  const root = await mkdtemp(join(tmpdir(), "backstage-deps-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "src/backstage"), { recursive: true });
    await mkdir(join(root, "src/core"), { recursive: true });
    await Bun.write(
      join(root, "scripts/backstage-build.ts"),
      [
        "export const BACKSTAGE_BUILD_TARGETS = [",
        '  ["src/backstage/main.ts", "browser", "site/backstage", "app.js"],',
        '  ["src/backstage/server.ts", "bun", "", "server.js"],',
        '  ["src/backstage/extra.ts", "bun", "", "extra.js"],',
        "] as const;",
        "",
      ].join("\n"),
    );
    await Bun.write(join(root, "src/backstage/main.ts"), "export const m = 1;\n");
    await Bun.write(join(root, "src/backstage/server.ts"), "export const s = 1;\n");
    await Bun.write(
      join(root, "src/backstage/extra.ts"),
      'import { d } from "../core/extra-dep.ts";\nexport const e = d;\n',
    );
    await Bun.write(join(root, "src/core/extra-dep.ts"), "export const d = 1;\n");
    const archived = await backstageEntrypoints(root);
    expect(archived).toEqual([...TWO, "src/backstage/extra.ts"]);
    expect(archived).not.toEqual(await backstageEntrypoints(REPO));
    expect(await backstageGraph(root)).toContain("src/core/extra-dep.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[unit] #82 a root whose build script lacks valid targets is an error, not an empty graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "backstage-deps-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await Bun.write(join(root, "scripts/backstage-build.ts"), "export const OTHER = 1;\n");
    await expect(backstageEntrypoints(root)).rejects.toThrow();
    const other = await mkdtemp(join(tmpdir(), "backstage-deps-"));
    try {
      await mkdir(join(other, "scripts"), { recursive: true });
      await Bun.write(
        join(other, "scripts/backstage-build.ts"),
        "export const BACKSTAGE_BUILD_TARGETS = [[42]];\n",
      );
      await expect(backstageEntrypoints(other)).rejects.toThrow();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[unit] #82 the real Backstage import graph reaches src/core, src/format and jev-answer", async () => {
  const files = await backstageGraph(REPO);
  for (const path of [
    ...TWO,
    "src/core/verdict.ts",
    "src/format/validate.ts",
    "src/jev-answer.ts",
  ])
    expect(files).toContain(path);
  expect(files.some((path) => path.startsWith("src/db/"))).toBe(false);
});

test("[unit] #82 relative imports are followed transitively; packages and unreached files are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "backstage-deps-"));
  try {
    await mkdir(join(root, "src/backstage"), { recursive: true });
    await mkdir(join(root, "src/core"), { recursive: true });
    await Bun.write(
      join(root, "src/backstage/main.ts"),
      'import { a } from "../core/a.ts";\nimport postgres from "postgres";\nexport const m = [a, postgres];\n',
    );
    await Bun.write(
      join(root, "src/backstage/server.ts"),
      'export const s = await import("./lazy.ts");\n',
    );
    await Bun.write(join(root, "src/backstage/lazy.ts"), "export const l = 1;\n");
    await Bun.write(
      join(root, "src/core/a.ts"),
      'export { b as a } from "./b.ts";\n',
    );
    await Bun.write(join(root, "src/core/b.ts"), "export const b = 1;\n");
    await Bun.write(join(root, "src/core/unused.ts"), "export const u = 1;\n");
    expect(backstageDependencies(root, TWO)).toEqual([
      "src/backstage/lazy.ts",
      "src/backstage/main.ts",
      "src/backstage/server.ts",
      "src/core/a.ts",
      "src/core/b.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("[unit] #82 an import that leaves the source root is an error, not a silent omission", async () => {
  const root = await mkdtemp(join(tmpdir(), "backstage-deps-"));
  const outside = await mkdtemp(join(tmpdir(), "backstage-outside-"));
  try {
    await mkdir(join(root, "src/backstage"), { recursive: true });
    await Bun.write(join(outside, "x.ts"), "export const x = 1;\n");
    await Bun.write(
      join(root, "src/backstage/main.ts"),
      `import { x } from "${relative(join(root, "src/backstage"), join(outside, "x.ts"))}";\nexport const m = x;\n`,
    );
    await Bun.write(join(root, "src/backstage/server.ts"), "export const s = 1;\n");
    expect(() => backstageDependencies(root, TWO)).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
