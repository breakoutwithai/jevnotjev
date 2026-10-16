// The TokenMax strip on the landing page (#238) is switched off by one word: the `hidden` attribute on its <section>
// in site/index.html. These helpers let a test serve the page as it is with that word removed, which is the whole of
// what re-enabling the strip means. Shared by the landing and /maps/ DOM tests.

const HIDDEN_STRIP = /(<section class="tm-first" id="tmFirst"[^>]*?) hidden>/;

/** The page's HTML with the strip switched back on: the one `hidden` removed, nothing else changed. */
export function withStripShown(html: string): string {
  return html.replace(HIDDEN_STRIP, "$1>");
}

/** True when the strip's tag still carries `hidden` (the shipped state). */
export function stripIsHidden(html: string): boolean {
  return HIDDEN_STRIP.test(html);
}
