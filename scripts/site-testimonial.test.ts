// The home page carries exactly one testimonial, under the Little Shop card on the curtain landing screen.
// What it says comes from TESTIMONIAL in site-testimonial.ts; this file asserts the page matches that constant.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { END, renderTestimonial, replaceBlock, START, TESTIMONIAL } from "./site-testimonial.ts";

const HTML = join(import.meta.dir, "..", "site", "index.html");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("site/index.html testimonial", () => {
  test("[smoke] T-quote: the constant's quote appears exactly once, in a blockquote", async () => {
    const html = await readFile(HTML, "utf8");
    expect(TESTIMONIAL.quote.length).toBeGreaterThan(0);
    expect(count(html, TESTIMONIAL.quote)).toBe(1);
    expect(html).toContain(`<blockquote><p>${TESTIMONIAL.quote}</p></blockquote>`);
  });

  test("[smoke] T-attribution: name, source text and the exact link, rel set, link appears once", async () => {
    const html = await readFile(HTML, "utf8");
    expect(count(html, TESTIMONIAL.url)).toBe(1);
    expect(html).toContain(
      `${TESTIMONIAL.name}, <a href="${TESTIMONIAL.url}" rel="noopener noreferrer">${TESTIMONIAL.source}</a>`,
    );
  });

  test("[unit] T-sync: the marked block equals the rendered constant, so a swap is one edit plus the script", async () => {
    const html = await readFile(HTML, "utf8");
    expect(count(html, START)).toBe(1);
    expect(count(html, END)).toBe(1);
    expect(replaceBlock(html, renderTestimonial())).toBe(html);
  });

  test("[unit] T-placement: the note is inside the Little Shop column, after the poster, before Raise the curtain", async () => {
    const html = await readFile(HTML, "utf8");
    const col = html.indexOf('<div class="shop-col">');
    const poster = html.indexOf('<a class="poster" href="little-shop/"', col);
    const note = html.indexOf('<figure class="shop-say"');
    const raise = html.indexOf('id="raise"');
    expect(col).toBeGreaterThan(-1);
    expect(poster).toBeGreaterThan(col);
    expect(note).toBeGreaterThan(poster);
    expect(raise).toBeGreaterThan(note);
    const block = html.slice(note, html.indexOf("</figure>", note));
    expect(block.includes(EM) || block.includes(EN)).toBe(false);
    expect(count(block, "http")).toBe(1);
  });
});
