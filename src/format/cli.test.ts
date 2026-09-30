// The command line as the READMEs run it: `bun src/format/cli.ts <file>`, a real process.

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "src", "format", "cli.ts");

function run(...args: string[]): { code: number; lines: string[] } {
  const done = Bun.spawnSync([process.execPath, CLI, ...args], { cwd: ROOT });
  return { code: done.exitCode, lines: done.stdout.toString().trimEnd().split("\n") };
}

describe("format validator command line", () => {
  test("[unit] example-v1.csv exits 0 with the README's VALID line", () => {
    const { code, lines } = run("format/example-v1.csv");
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("VALID rows=9 cases=3 errors=0 gaps=2");
  });

  test("[unit] an invalid file exits 1 with an INVALID line", async () => {
    const example = await Bun.file(join(ROOT, "format", "example-v1.csv")).text();
    const broken = example.replace(",jev,jev-1.13.0,yes,0.96,", ",jev,jev-1.13.0,maybe,1.5,");
    expect(broken).not.toBe(example);
    const path = join(tmpdir(), `jnj-cli-test-${process.pid}.csv`);
    await Bun.write(path, broken);
    try {
      const { code, lines } = run(path);
      expect(code).toBe(1);
      expect(lines.at(-1)).toMatch(/^INVALID rows=9 cases=3 errors=[1-9]\d* gaps=2$/);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("[unit] no file prints usage and exits 2", () => {
    const { code, lines } = run();
    expect(code).toBe(2);
    expect(lines[0]).toBe("Validate a Jev!Jev eval record CSV against format jnj-record/1.");
  });
});
