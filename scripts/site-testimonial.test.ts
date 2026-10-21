// The home page carries at most one testimonial, under the Little Shop card on the curtain landing screen, and only
// once TESTIMONIAL.approved is true. What it says comes from TESTIMONIAL in site-testimonial.ts. The present-case tests
// render with approved true into the page text in memory; the page on disk is checked against the constant as it stands.

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { END, renderTestimonial, replaceBlock, START, TESTIMONIAL } from "./site-testimonial.ts";

const HTML = join(import.meta.dir, "..", "site", "index.html");
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const ON = { ...TESTIMONIAL, approved: true };
const OFF = { ...TESTIMONIAL, approved: false };

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function page(): Promise<string> {
  return readFile(HTML, "utf8");
}

describe("site/index.html testimonial", () => {
  test("[smoke] T-hidden: with approved false nothing is rendered: no quote, no link, no note markup", async () => {
    expect(renderTestimonial(OFF)).toBe("");
    const html = replaceBlock(await page(), renderTestimonial(OFF));
    expect(TESTIMONIAL.quote.length).toBeGreaterThan(0);
    expect(count(html, TESTIMONIAL.quote)).toBe(0);
    expect(count(html, TESTIMONIAL.url)).toBe(0);
    expect(count(html, "shop-say")).toBe(0);
    expect(count(html, "<blockquote")).toBe(0);
  });

  test("[smoke] T-page: the page on disk follows the constant, shown once when approved and absent when not", async () => {
    const html = await page();
    const n = TESTIMONIAL.approved ? 1 : 0;
    expect({ quote: count(html, TESTIMONIAL.quote), url: count(html, TESTIMONIAL.url), note: count(html, 'class="shop-say"') }).toEqual({ quote: n, url: n, note: n });
  });

  test("[smoke] T-quote: approved true renders the quote exactly once, in a blockquote", async () => {
    const html = replaceBlock(await page(), renderTestimonial(ON));
    expect(count(html, ON.quote)).toBe(1);
    expect(html).toContain(`<blockquote><p>${ON.quote}</p></blockquote>`);
  });

  test("[smoke] T-attribution: approved true renders name, source text and the exact link, rel set, link once", async () => {
    const html = replaceBlock(await page(), renderTestimonial(ON));
    expect(count(html, ON.url)).toBe(1);
    expect(html).toContain(`${ON.name}, <a href="${ON.url}" rel="noopener noreferrer">${ON.source}</a>`);
  });

  test("[unit] T-sync: the marked block on disk equals the rendered constant, so a swap is one edit plus the script", async () => {
    const html = await page();
    expect(count(html, START)).toBe(1);
    expect(count(html, END)).toBe(1);
    expect(replaceBlock(html, renderTestimonial())).toBe(html);
  });

  test("[unit] T-placement: when rendered the note is inside the Little Shop column, after the poster, before Raise the curtain", async () => {
    const html = replaceBlock(await page(), renderTestimonial(ON));
    const col = html.indexOf('<div class="shop-col">');
    const poster = html.indexOf('<div class="poster">', col);
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
