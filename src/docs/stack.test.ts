// The docs describe the TypeScript and Bun code. A tracked Markdown file outside the allowlist
// that names the old Python stack fails this test, so a stale setup step cannot come back.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

const STACK_WORDS = /python|pytest|pip install|venv|requirements\.txt|\.py\b/i;
// The two research scripts stay Python (#22): naming or running one of them is allowed.
const RESEARCH_SCRIPT = /(python3 )?[\w./-]*\b(sim_min_n|newcombe_check)\.py\b/g;

// Dated records.
const ALLOWED_PREFIXES = ["docs/research/", "docs/blog/", "docs/benchmarks/"];
const ALLOWED_FILES = new Set([
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
    .filter(({ line }) => STACK_WORDS.test(line.replace(RESEARCH_SCRIPT, "")))
    .map(({ line, number }) => `${number}: ${line.trim().slice(0, 120)}`);
}

describe("docs name the TypeScript and Bun stack", () => {
  test("[unit] the matcher flags each old-stack word and passes a Bun line", () => {
    for (const line of ["run pytest", "Python 3", "pip install -r x", ".venv/", "requirements.txt", "format/validate.py here"]) {
      expect(staleLines(line)).toHaveLength(1);
    }
    expect(staleLines("bun test; see py-to-ts-test-map.md and docs/decision/newcombe_check.py:12-15")).toEqual([]);
    expect(staleLines("run `python3 docs/decision/sim_min_n.py`, see [sim_min_n.py](sim_min_n.py)")).toEqual([]);
    expect(staleLines("docs/decision/newcombe_check.py and format/validate.py")).toHaveLength(1);
    expect(staleLines("docs/decision/hand_check.py")).toHaveLength(1);
    expect(staleLines("python3 docs/decision/sim_min_n.py; a Python helper")).toHaveLength(1);
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
