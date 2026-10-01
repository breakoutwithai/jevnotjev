// The repo is TypeScript on Bun with no Python. A tracked .py file, or a tracked Markdown file outside the allowlist
// that names the old Python stack fails this test, so a stale setup step cannot come back.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const STACK_WORDS = new RegExp(
  [
    "python",
    "pytest",
    "\\bpip3?\\s+install",
    "\\bpipx\\b",
    "\\bpoetry\\b",
    "\\buv\\s+(pip|sync|venv|run|add)\\b",
    "\\bconda\\b",
    "virtualenv",
    "venv",
    "requirements[\\w.-]*\\.txt",
    "pyproject\\.toml",
    "\\bpy\\s+-3",
    "\\.py\\b",
  ].join("|"),
  "i",
);
// Dated records.
const ALLOWED_PREFIXES = ["docs/research/", "docs/blog/", "docs/benchmarks/"];
const ALLOWED_FILES = new Set([
  "AGENTS.md", // states the no-Python rule itself
  "docs/process/pipeline-review.md",
  "docs/process/py-to-ts-test-map.md",
  "docs/process/ts-docs-refresh.md",
]);

function isAllowed(path: string): boolean {
  return ALLOWED_FILES.has(path) || ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function trackedMarkdown(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"], { cwd: ROOT });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\0").filter((path) => path.length > 0);
}

function staleLines(text: string): string[] {
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => STACK_WORDS.test(line))
    .map(({ line, number }) => `${number}: ${line.trim().slice(0, 120)}`);
}

describe("docs name the TypeScript and Bun stack", () => {
  test("[unit] the matcher flags each old-stack word and passes a Bun line", () => {
    for (const line of ["run pytest", "Python 3", "pip install -r x", ".venv/", "requirements.txt", "format/validate.py here"]) {
      expect(staleLines(line)).toHaveLength(1);
    }
    expect(staleLines("bun test; see py-to-ts-test-map.md")).toEqual([]);
    // The research scripts were removed in favour of TypeScript; naming one is now stale too.
    expect(staleLines("docs/decision/newcombe_check.py:12-15")).toHaveLength(1);
    expect(staleLines("run `python3 docs/decision/sim_min_n.py`")).toHaveLength(1);
    expect(staleLines("docs/decision/hand_check.py")).toHaveLength(1);
  });

  // Each is a Python setup step a stale doc could carry; the matcher must flag every one.
  const PLANTED = [
    "pip3 install jsonschema psycopg",
    "pip install -r requirements.txt",
    "pip install -r requirements-dev.txt",
    "pipx install ruff",
    "poetry install",
    "uv pip install jsonschema",
    "uv sync",
    "conda env create -f environment.yml",
    "virtualenv env",
    "python3 -m venv .venv",
    "source .venv/bin/activate",
    "py -3 validate",
    "see pyproject.toml",
    "pytest -m unit",
  ];
  test.each(PLANTED)("[unit] the matcher flags the planted step %p", (line) => {
    expect(staleLines(line)).toHaveLength(1);
  });

  test("[unit] no tracked .py file", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.py"], { cwd: ROOT });
    if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
    expect(listed.stdout.toString().split("\0").filter((path) => path.length > 0)).toEqual([]);
  });

  test("[unit] no tracked Markdown outside the allowlist names the Python stack", async () => {
    const files = trackedMarkdown().filter((path) => !isAllowed(path));
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const path of files) {
      for (const hit of staleLines(await Bun.file(join(ROOT, path)).text())) found.push(`${path}:${hit}`);
    }
    expect(found).toEqual([]);
  });
});
