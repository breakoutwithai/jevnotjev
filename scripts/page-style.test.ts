// Every public page links the shared stylesheet site/page.css before any other stylesheet or style block,
// so one look covers the site and each page's own css still wins.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SITE = join(import.meta.dir, "..", "site");
const PAGES = ["explainer", "ask", "guide", "label", "little-shop", "maps", "privacy", "replay", "tm"];

function headStyleSources(html: string): string[] {
  const head = html.slice(0, html.indexOf("</head>"));
  return [...head.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*>|<style\b/g)].map((m) => m[0]);
}

describe("shared page stylesheet", () => {
  test("[unit] PS-1 site/page.css exists and defines the house tokens", () => {
    const css = readFileSync(join(SITE, "page.css"), "utf8");
    for (const token of ["--bg", "--ink", "--brass", "--serif", "--sans"]) expect(css).toContain(`${token}:`);
  });

  for (const page of PAGES) {
    test(`[unit] PS-2 ${page} links ../page.css first`, () => {
      const first = headStyleSources(readFileSync(join(SITE, page, "index.html"), "utf8"))[0] ?? "";
      expect(first).toContain('href="../page.css"');
    });
  }
});
