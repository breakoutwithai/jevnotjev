// Content gate for the public site: no leaderboard person names (M1) and no em or en dash glyphs (M5) in site/.
// This suite runs on synthetic names, so it passes on any checkout. The real-name scan reads the private leaderboard
// and is its own command: `bun scripts/site-content.ts --leaderboard <path>` (see the CLI tests below).

import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaderboardNames, scanSite } from "./site-content.ts";

const SITE = join(import.meta.dir, "..", "site");
const CLI = join(import.meta.dir, "site-content.ts");
const DASH = String.fromCharCode(0x2014);

const BOARD = [
  "# Board",
  "",
  "| Rank | Builder | Project | Score |",
  "|---|---|---|---|",
  "| 01 | Ann Example (you) | Thing | 46 |",
  "| 02 | Bo | Other Thing | 45 |",
  "| 03 | Cy Sample (Some Org) | Third | 40 |",
  "| 04 | **Di Fixture** | Fourth | 30 |",
  "| 05 | [Ed Placeholder](https://example.com/ed) | Fifth | 20 |",
  "| 06 | _Flo Dummy_ | Sixth | 10 |",
].join("\n");
const NAMES = leaderboardNames(BOARD);

async function withDir<T>(files: Record<string, string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jnj-site-"));
  try {
    for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("site content gate", () => {
  test("[unit] SITE-1 the Builder column is read as plain text: parentheticals, emphasis and links dropped", () => {
    expect(NAMES).toEqual(["Ann Example", "Bo", "Cy Sample", "Di Fixture", "Ed Placeholder", "Flo Dummy"]);
  });

  test("[unit] SITE-2 a name matches only as a whole word, any case", async () => {
    await withDir({ "a.html": "<p>a trolley and a jolly bo-peep</p>\n<p>hello BO there</p>\n" }, async (dir) => {
      expect((await scanSite(dir, ["Bo"])).nameHits.map((h) => h.line)).toEqual([1, 2]);
      expect((await scanSite(dir, ["Olly"])).nameHits).toEqual([]);
    });
  });

  test("[unit] SITE-2 a name split across lines, inline tags or character references is still caught", async () => {
    const forms = ["<p>Ann\nExample</p>\n", "<p>Ann <b>Example</b></p>\n", "<p>Ann&#32;Example</p>\n", "<p>Ann&nbsp;<em>Ex</em>ample</p>\n", "<p>Ann&#x20;Example</p>\n"];
    for (const html of forms) {
      await withDir({ "a.html": html }, async (dir) => {
        const r = await scanSite(dir, NAMES);
        expect(r.nameHits.length).toBe(1);
        expect(r.nameHits[0]?.line).toBe(1);
      });
    }
  });

  test("[unit] SITE-2 .mjs and .htm are scanned, images pass, and an unclassified file fails the gate", async () => {
    await withDir({ "copy.mjs": `export const t = "Di Fixture ${DASH} x";\n`, "b.htm": "<p>Bo</p>\n", "og.png": "x", "notes.foo": "y" }, async (dir) => {
      const r = await scanSite(dir, NAMES);
      expect(r.nameHits.map((h) => h.file).sort()).toEqual(["b.htm", "copy.mjs"]);
      expect(r.dashHits.map((h) => h.file)).toEqual(["copy.mjs"]);
      expect(r.unclassified).toEqual(["notes.foo"]);
      expect(r.filesChecked).toBe(2);
    });
  });

  test("[integration] SITE-3 a planted name and a planted em dash in a copy of site/ both fail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jnj-site-"));
    try {
      await cp(SITE, dir, { recursive: true });
      const page = join(dir, "index.html");
      await writeFile(page, `${await readFile(page, "utf8")}\n<p>Cy Sample was here ${DASH} twice</p>\n`);
      const r = await scanSite(dir, NAMES);
      expect(r.nameHits.map((h) => h.file)).toEqual(["index.html"]);
      expect(r.dashHits.map((h) => h.code)).toEqual([0x2014]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[integration] SITE-4 site/ has 0 em or en dashes (M5), every file classified, and 0 synthetic-name hits", async () => {
    const r = await scanSite(SITE, NAMES);
    expect(r.filesChecked).toBeGreaterThan(0);
    expect(r.unclassified).toEqual([]);
    expect(r.dashHits.map((h) => `${h.file}:${h.line}`)).toEqual([]);
    expect(r.nameHits).toEqual([]);
  });
});

describe("site content CLI (the real-leaderboard scan)", () => {
  function cli(args: string[]): { code: number; out: string } {
    const p = Bun.spawnSync(["bun", CLI, ...args]);
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
  }

  test("[integration] SITE-10 a missing leaderboard fails loudly, never passes", () => {
    const r = cli([SITE, "--leaderboard", join(tmpdir(), "no-such-leaderboard.md")]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("leaderboard not readable");
  });

  test("[integration] SITE-10 with a leaderboard: passes on site/, fails on a planted copy", async () => {
    await withDir({ "board.md": BOARD }, async (dir) => {
      const ok = cli([SITE, "--leaderboard", join(dir, "board.md")]);
      expect(ok.out).toContain("names checked 6, name hits 0, dash hits 0, unclassified 0");
      expect(ok.code).toBe(0);
      const copy = join(dir, "site");
      await cp(SITE, copy, { recursive: true });
      await writeFile(join(copy, "x.html"), "<p>Ed <i>Placeholder</i></p>\n");
      const bad = cli([copy, "--leaderboard", join(dir, "board.md")]);
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("name hits 1");
    });
  });

  test("[integration] SITE-10 a leaderboard with no Builder column fails, never checks zero names", async () => {
    await withDir({ "board.md": "# nothing here\n" }, async (dir) => {
      const r = cli([SITE, "--leaderboard", join(dir, "board.md")]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("names checked 0");
    });
  });
});
