// The one testimonial on the home page (the curtain landing screen, beside the Little Shop card).
// The words live in TESTIMONIAL only. To swap the quote, edit TESTIMONIAL, then run
//   bun scripts/site-testimonial.ts
// which rewrites the marked block in site/index.html; scripts/site-testimonial.test.ts fails if the page and this constant differ.

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Testimonial = { quote: string; name: string; source: string; url: string; approved: boolean };

// approved false: nothing is rendered into the page. Set it to true (and run the script) only once the speaker has approved the wording.
export const TESTIMONIAL: Testimonial = {
  quote: "Jev has really helped me on my build, I am really enjoying it.",
  name: "Olly Lenton",
  source: "Early AI-dopters community, October 2026",
  url: "https://www.skool.com/earlyaidopters/d26-jevjev",
  approved: false,
};

export const START = "<!-- testimonial:start -->";
export const END = "<!-- testimonial:end -->";

function esc(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderTestimonial(t: Testimonial = TESTIMONIAL): string {
  if (!t.approved) return "";
  return (
    `<figure class="shop-say" id="say"><blockquote><p>${esc(t.quote)}</p></blockquote>` +
    `<figcaption>${esc(t.name)}, <a href="${esc(t.url)}" rel="noopener noreferrer">${esc(t.source)}</a></figcaption></figure>`
  );
}

export function replaceBlock(html: string, block: string): string {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a || html.indexOf(START, a + 1) >= 0) throw new Error("expected exactly one testimonial marker pair");
  return html.slice(0, a + START.length) + block + html.slice(b);
}

if (import.meta.main) {
  const file = join(import.meta.dir, "..", "site", "index.html");
  const html = await readFile(file, "utf8");
  await writeFile(file, replaceBlock(html, renderTestimonial()));
}
