// The fish-eggs answer page is static public copy: its pictures resolve, it loads no script, and it never presents
// the scripted test question as a customer testimonial.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..", "..", "site", "answers", "fish-eggs");
const page = readFileSync(join(DIR, "index.html"), "utf8");

describe("fish-eggs answer page", () => {
  test("[unit] every local image the page names exists next to it", () => {
    const srcs = [...page.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1] ?? "");
    expect(srcs.sort()).toEqual(["eggs.svg", "hatched.svg"]);
    for (const src of srcs) expect(existsSync(join(DIR, src))).toBe(true);
  });
  test("[unit] the page and its pictures load no script and hold no credential", () => {
    for (const text of [page, readFileSync(join(DIR, "eggs.svg"), "utf8"), readFileSync(join(DIR, "hatched.svg"), "utf8")]) {
      expect(text).not.toMatch(/<script|javascript:|\son[a-z]+=/i);
      expect(text).not.toMatch(/\b(?:gtk|jng|jna)_[A-Za-z0-9]|api[_-]key|bearer\s/i);
    }
  });
  test("[unit] the question is labelled a test session and the page says no verdict was run", () => {
    expect(page).toContain("during a test session");
    expect(page).toContain("did not run its three-way comparison");
    expect(page).not.toMatch(/testimonial|game.?changer/i);
  });
  test("[unit] no em or en dash in visible text", () => {
    expect(page.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(page.includes(String.fromCharCode(0x2013))).toBe(false);
  });
});
