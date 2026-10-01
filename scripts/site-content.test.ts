// Content gate for the public site: no leaderboard person names (M1) and no em or en dash glyphs (M5) in site/.
// The names are read from the private leaderboard at run time and never written into this repo; a planted copy of
// site/ proves the gate fails before the real folder is trusted to pass.

import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DASHES, leaderboardNames, leaderboardPath, scanSite } from "./site-content.ts";

const SITE = join(import.meta.dir, "..", "site");

async function names(): Promise<string[]> {
  const path = leaderboardPath();
  const text = await readFile(path, "utf8").catch(() => {
    throw new Error(`leaderboard not readable at ${path}; set JNJ_LEADERBOARD to its path`);
  });
  return leaderboardNames(text);
}

describe("site content gate", () => {
  test("[unit] SITE-1 the Builder column is read from a leaderboard table, parentheticals dropped", () => {
    const table = [
      "| Rank | Builder | Project | Score |",
      "|---|---|---|---|",
      "| 01 | Ann Example (you) | Thing | 46 |",
      "| 02 | Bo | Other Thing | 45 |",
      "| 03 | Cy Sample (Some Org) | Third | 40 |",
    ].join("\n");
    expect(leaderboardNames(table)).toEqual(["Ann Example", "Bo", "Cy Sample"]);
  });

  test("[unit] SITE-2 a name matches only as a whole word, any case", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jnj-site-"));
    try {
      await writeFile(join(dir, "a.html"), "<p>a trolley and a jolly bo-peep</p>\n<p>hello BO there</p>\n");
      const r = await scanSite(dir, ["Bo"]);
      expect(r.nameHits.map((h) => h.line)).toEqual([1, 2]);
      const r2 = await scanSite(dir, ["Olly"]);
      expect(r2.nameHits).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[integration] SITE-3 a planted leaderboard name and a planted em dash in a copy of site/ both fail", async () => {
    const list = await names();
    const planted = list[0] ?? "";
    expect(planted.length).toBeGreaterThan(0);
    const dir = await mkdtemp(join(tmpdir(), "jnj-site-"));
    try {
      await cp(SITE, dir, { recursive: true });
      const page = join(dir, "index.html");
      const html = await readFile(page, "utf8");
      await writeFile(page, `${html}\n<p>${planted} was here ${String.fromCharCode(0x2014)} twice</p>\n`);
      const r = await scanSite(dir, list);
      expect(r.namesChecked).toBe(list.length);
      expect(r.nameHits.map((h) => h.file)).toEqual(["index.html"]);
      expect(r.dashHits.map((h) => h.code)).toEqual([0x2014]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("[integration] SITE-4 site/ holds 0 leaderboard names (M1) and 0 em or en dashes (M5)", async () => {
    const list = await names();
    const r = await scanSite(SITE, list);
    console.log(`site-content: ${r.filesChecked} files, ${r.namesChecked} names checked, ${r.nameHits.length} name hits, ${r.dashHits.length} dash hits (${DASHES.map((c) => `U+${c.toString(16).toUpperCase()}`).join(", ")})`);
    expect(r.namesChecked).toBeGreaterThan(0);
    expect(r.filesChecked).toBeGreaterThan(0);
    expect(r.nameHits.map((h) => `${h.file}:${h.line}`)).toEqual([]);
    expect(r.dashHits.map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });
});
