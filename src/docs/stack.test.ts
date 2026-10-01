// The repo is TypeScript on Bun with no Python. A tracked .py file, or a tracked Markdown file that names the old
// Python stack, fails this test, so a stale setup step cannot come back. Only AGENTS.md's rule lines are exempt.

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
// AGENTS.md states the rule, so it must name the old stack: only these exact lines are exempt.
// Any other line there that names it fails like any other doc.
const ALLOWED_LINES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "AGENTS.md",
    new Set([
      "## Stack: TypeScript on Bun, no Python",
      "- No Python: no `.py` files, pytest, pip, venv or requirements files. A new need is written in TypeScript. `src/docs/stack.test.ts` fails on a tracked `.py` file or a doc that names the old stack.",
    ]),
  ],
]);

function trackedMarkdown(): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.md"], { cwd: ROOT });
  if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
  return listed.stdout.toString().split("\0").filter((path) => path.length > 0);
}

function staleLines(text: string, path = ""): string[] {
  const allowed = ALLOWED_LINES.get(path);
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => STACK_WORDS.test(line) && !allowed?.has(line.trim()))
    .map(({ line, number }) => `${number}: ${line.trim().slice(0, 120)}`);
}

describe("docs name the TypeScript and Bun stack", () => {
  test("[unit] the matcher flags each old-stack word and passes a Bun line", () => {
    for (const line of ["run pytest", "Python 3", "pip install -r x", ".venv/", "requirements.txt", "format/validate.py here"]) {
      expect(staleLines(line)).toHaveLength(1);
    }
    expect(staleLines("bun test; see src/format/validate.test.ts")).toEqual([]);
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

  test("[unit] AGENTS.md is scanned: only its rule lines are exempt", async () => {
    const text = await Bun.file(join(ROOT, "AGENTS.md")).text();
    expect(staleLines(text, "AGENTS.md")).toEqual([]);
    expect(staleLines(`${text}\nSetup: run \`pip install pytest\`, then \`python3 format/validate.py\`.\n`, "AGENTS.md")).toHaveLength(1);
  });

  test("[unit] no tracked .py file", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "*.py"], { cwd: ROOT });
    if (listed.exitCode !== 0) throw new Error(`git ls-files failed: ${listed.stderr.toString()}`);
    expect(listed.stdout.toString().split("\0").filter((path) => path.length > 0)).toEqual([]);
  });

  test("[unit] no tracked Markdown names the Python stack", async () => {
    const files = trackedMarkdown();
    expect(files.length).toBeGreaterThan(10);
    const found: string[] = [];
    for (const path of files) {
      for (const hit of staleLines(await Bun.file(join(ROOT, path)).text(), path)) found.push(`${path}:${hit}`);
    }
    expect(found).toEqual([]);
  });
});
