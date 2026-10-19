// The sample questions row as theatre posters: one row after the worked example and before the ticket controls, tested
// samples as full posters with Watch now, untested ideas as smaller posters stamped Coming, no tab bar, every number read
// from site/shows/posters.json, and every visible word at 14 px or more on a phone.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "../uat/happy-path-lib.ts";
import type { Poster } from "../../src/shows/posters.ts";

const SITE = process.env.LANDING_TEST_SITE ?? join(import.meta.dir, "..", "..", "site");
const POSTERS: { posters: Poster[] } = JSON.parse(readFileSync(join(SITE, "shows", "posters.json"), "utf8"));
const WIDTHS = [390, 768, 1440];
const BANNED = /\b(model|token|tokens|queued job|curl|gate|rehearsal|script reading)\b/i;
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(`${found.error} Run bunx playwright-core install chromium.`);
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname);
      if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
      const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
      if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
      const file = Bun.file(path);
      return await file.exists() ? new Response(file) : new Response("Not found", { status: 404 });
    },
  });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});

afterAll(async () => {
  await browser?.close();
  server?.stop();
});

async function pageAt(width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
  // The ranking answer re-renders the row; read it once that has settled, never the first render's detached nodes.
  await page.waitForLoadState("networkidle");
  return page;
}

/** What posters.json says the figure line is: the Jev arm's count, never retyped. Ideas carry no figure. */
function figureOf(poster: Poster): string | null {
  const jev = poster.run?.methods.find((method) => method.arm === "jev");
  if (!poster.run || !jev || jev.labelled === 0) return null;
  return `Jev: ${jev.accepted} of ${jev.labelled} right${poster.run.cohorts > 1 ? " on one question" : ""}`;
}

test("[integration] P1 the samples row follows the worked example and sits before the ticket controls", async () => {
  const page = await pageAt(1440);
  try {
    const order = await page.evaluate(() => {
      const samples = document.querySelector("section.samples");
      const heading = [...document.querySelectorAll("h1,h2,h3")].find((node) => node.textContent?.trim() === "Where does your week go?");
      const example = heading?.closest("section") ?? document.getElementById("results");
      const bring = document.getElementById("tkBring");
      const posters = document.getElementById("tkPosters");
      const office = document.getElementById("tickets");
      if (!samples || !example || !bring || !posters || !office) return "missing";
      const after = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      return [
        samples.previousElementSibling === example || samples.previousElementSibling?.contains(example) ? "" : "samples does not directly follow the example",
        after(example, samples) ? "" : "example after samples",
        after(posters, bring) ? "" : "Bring your own decision before the posters",
        after(samples, office) ? "" : "ticket office before samples",
      ].filter(Boolean).join("; ");
    });
    expect(order).toBe("");
  } finally { await page.close(); }
});

test("[integration] P2 one poster row: no tab bar, one poster per sample, each a 2 to 3 portrait with a stamp, a serif title and one button", async () => {
  for (const width of WIDTHS) {
    const page = await pageAt(width);
    try {
      expect(await page.locator("section.samples nav, section.samples [role=tab], .tk-stages").count()).toBe(0);
      const cards = await page.locator("#tkPosters .tk-poster").evaluateAll((nodes) => nodes.map((node) => {
        const title = node.querySelector("h3");
        const outside = [...node.children].filter((child) => child.tagName !== "DETAILS");
        return {
          id: node.getAttribute("data-id"),
          ratio: Math.round(((node instanceof HTMLElement ? node.offsetHeight : 0) / (node instanceof HTMLElement ? node.offsetWidth : 0)) * 100) / 100,
          stamp: node.querySelectorAll(":scope > .tk-stamp").length,
          serif: title ? /Alegreya|serif/i.test(getComputedStyle(title).fontFamily) : false,
          buttons: outside.filter((child) => child.tagName === "A" || child.tagName === "BUTTON").length,
        };
      }));
      expect(cards.map((card) => card.id)).toEqual(POSTERS.posters.map((poster) => poster.id));
      for (const card of cards) {
        expect({ width, id: card.id, stamp: card.stamp, serif: card.serif, buttons: card.buttons }).toEqual({ width, id: card.id, stamp: 1, serif: true, buttons: 1 });
      }
      // Tested posters are 2:3 (1.5); they may grow taller when their words need room, never squatter.
      const full = cards.filter((card) => POSTERS.posters.find((poster) => poster.id === card.id)?.watch);
      expect(full.length).toBeGreaterThan(0);
      for (const card of full) expect({ width, id: card.id, portrait: card.ratio >= 1.45 }).toEqual({ width, id: card.id, portrait: true });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] P3 tested samples are full posters with Watch now and their figure from posters.json; ideas are smaller, stamped Coming, with no number", async () => {
  for (const width of WIDTHS) {
    const page = await pageAt(width);
    try {
      const tested = POSTERS.posters.filter((poster) => poster.watch !== null);
      const ideas = POSTERS.posters.filter((poster) => poster.run === null);
      expect(tested.length).toBeGreaterThan(0);
      expect(ideas.length).toBeGreaterThan(0);
      const area: Record<string, number> = {};
      for (const poster of POSTERS.posters) {
        const card = page.locator(`#tkPosters .tk-poster[data-id="${poster.id}"]`);
        const box = await card.boundingBox();
        area[poster.id] = await card.evaluate((node) => (node instanceof HTMLElement ? node.offsetWidth : 0) * (node instanceof HTMLElement ? node.offsetHeight : 0));
        expect(box).not.toBeNull();
        const visible = await card.evaluate((node) => [...node.children].filter((child) => child.tagName !== "DETAILS").map((child) => (child instanceof HTMLElement ? child.innerText : "")).join(" "));
        if (poster.watch !== null) {
          expect(await card.locator(":scope > a.tk-primary").textContent()).toBe("Watch now");
          expect(await card.locator(":scope > a.tk-primary").getAttribute("href")).toBe(poster.watch);
          expect(await card.locator(":scope > .tk-figure").innerText()).toBe(figureOf(poster) ?? "");
        }
        if (poster.run === null) {
          expect((await card.locator(":scope > .tk-stamp").innerText()).trim().toLowerCase()).toBe("coming");
          expect(await card.locator(":scope > .tk-figure").count()).toBe(0);
          expect(visible.replace(poster.title, "")).not.toMatch(/\d/);
        }
      }
      const smallestTested = Math.min(...tested.map((poster) => area[poster.id] ?? 0));
      const largestIdea = Math.max(...ideas.map((poster) => area[poster.id] ?? 0));
      expect({ width, smaller: largestIdea < smallestTested }).toEqual({ width, smaller: true });
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] P4 poster words: at most 8 words of body copy, plain words only, no dashes, alternating tilt", async () => {
  const page = await pageAt(1440);
  try {
    const cards = await page.locator("#tkPosters .tk-poster").evaluateAll((nodes) => nodes.map((node) => ({
      id: node.getAttribute("data-id"),
      body: [...node.querySelectorAll(":scope > p:not(.tk-stamp)")].map((child) => (child instanceof HTMLElement ? child.innerText : "")).join(" "),
      visible: [...node.children].filter((child) => child.tagName !== "DETAILS").map((child) => (child instanceof HTMLElement ? child.innerText : "")).join(" ")
        + " " + (node.querySelector(":scope > details > summary")?.textContent ?? ""),
      angle: (() => { const m = getComputedStyle(node).transform.match(/matrix\(([^,]+),\s*([^,]+)/); return m ? Math.atan2(Number(m[2]), Number(m[1])) * 180 / Math.PI : 0; })(),
    })));
    expect(cards.length).toBe(POSTERS.posters.length);
    for (const card of cards) {
      expect({ id: card.id, words: card.body.split(/\s+/).filter(Boolean).length <= 8 }).toEqual({ id: card.id, words: true });
      expect(card.visible).not.toMatch(BANNED);
      expect(card.visible).not.toMatch(DASHES);
      expect({ id: card.id, tilted: Math.abs(card.angle) > 0.3 && Math.abs(card.angle) < 3 }).toEqual({ id: card.id, tilted: true });
    }
    for (let i = 1; i < cards.length; i++) expect(Math.sign(cards[i]?.angle ?? 0)).toBe(-Math.sign(cards[i - 1]?.angle ?? 0));
  } finally { await page.close(); }
});

test("[integration] P5 every visible word in the samples row renders at 14 px or more at 390, inside its poster, with no sideways scroll", async () => {
  const page = await pageAt(390);
  try {
    await page.evaluate(() => document.fonts.ready);
    const found = await page.evaluate(() => {
      const section = document.querySelector("section.samples");
      if (!section) return { small: ["no samples section"], outside: [], overflow: 0 };
      const small: string[] = [];
      const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim() ?? "";
        const parent = node.parentElement;
        if (!text || !parent || !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length === 0) continue;
        const size = parseFloat(getComputedStyle(parent).fontSize);
        if (size < 14) small.push(`${size}px ${text.slice(0, 30)}`);
      }
      const outside = [...section.querySelectorAll("#tkPosters .tk-poster > *")].filter((child) => {
        const card = child.parentElement;
        if (!card) return false;
        const a = child.getBoundingClientRect(), b = card.getBoundingClientRect();
        return a.width > 0 && (a.left < b.left - 1 || a.right > b.right + 1);
      }).map((child) => `${child.tagName}.${child.className}`);
      return { small, outside, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    expect(found).toEqual({ small: [], outside: [], overflow: 0 });
  } finally { await page.close(); }
});
