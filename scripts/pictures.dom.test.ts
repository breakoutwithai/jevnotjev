import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
// The picture story lives on the landing page (the retired /explainer redirects there); these checks cover its .jx block.
const PAGE_FILE = join(SITE, "index.html");
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];
const FONT_HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com"]);
// Words the page copy (visible text, aria-labels, title, meta) must not use.
const BANNED = /\b(models?|tokens?|queued|curl|gates?|fixed list|mid|trivial)\b/i;
// The two dash glyphs are built from code points so this file never carries them itself.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const DASH_GLYPHS = new RegExp(`[${EN_DASH}${EM_DASH}]`);

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
const seen: string[] = [];

// A planted copy of the page: one banned word, one dash glyph and a second "A helper is" definition.
function planted(): string {
  const html = readFileSync(PAGE_FILE, "utf8");
  return force(html, /<section class="entry" id="week"/, `<span>token A helper is ${EM_DASH} here</span><section class="entry" id="week"`);
}

// Each planted page forces ONE old state back onto the current page, so an assertion that cannot fail is caught.
// The patterns match both the shipped markup and the fixed markup.
function force(html: string, pattern: RegExp, old: string, lenient = false): string {
  if (html.search(pattern) < 0) {
    if (lenient) return html;
    throw new Error(`plant pattern did not match: ${String(pattern)}`);
  }
  return html.replace(pattern, old);
}

const OLD_KEY = `<ul class="key" aria-label="Bar colours">
    <li class="k-base"><i></i>already used (36%)</li>
    <li class="k-s"><i></i>small job (adds 1)</li>
    <li class="k-m"><i></i>medium job (adds 4)</li>
    <li class="k-l"><i></i>large job (adds 16)</li>
  </ul>`;
const OLD_LEGEND = `<p class="legend">EXAMPLE: all numbers are invented for this picture. Thin slices are drawn wider so you can see them.</p>`;
const OLD_CAPTIONS = ["Jev gives odds on a yes or no.", "Jev picks one from your list.", "Jev rates how hard a job is.", "Jev points to a spot in a picture."];

const PLANTS: Record<string, (html: string) => string> = {
  "/old-legend/": (html) => {
    const keyed = force(html, /(<p class="keyhead"[^>]*>[^<]*<\/p>\s*)?<ul class="key"[\s\S]*?<\/ul>/, OLD_KEY);
    const noted = force(keyed, /<p class="legend">[^<]*<\/p>/, OLD_LEGEND);
    return noted.replace(/<div class="marks"[\s\S]*?<\/div>/g, "").replace("<span>+16%</span>", "");
  },
  "/old-captions/": (html) => {
    let n = 0;
    const captioned = html.replace(/<p class="p-cap">[^<]*<\/p>/g, () => `<p class="p-cap">${OLD_CAPTIONS[n++] ?? ""}</p>`);
    // c02 put each title in a button: the plant keeps the button and swaps its words.
    return force(captioned, />(How hard|How far up)(<\/button>)?<\/h2>/, ">How far up$2</h2>");
  },
  "/small-label/": (html) => {
    const sized = force(html, /font-size="\d+"( font-weight="700" letter-spacing="2" fill="#8a1a2e">PICK ONE)/g, 'font-size="13"$1');
    // The payoff label size lives in pictures.css: this plant loads a copy of it with 13 px labels.
    return force(sized, /href="pictures\.css"/, 'href="/planted-css/small-label.css"');
  },
  "/hue-only/": (html) => html
    .replace(/fill="url\(#pat-easy\)"/g, 'fill="#86cf9f"')
    .replace(/fill="url\(#pat-ordinary\)"/g, 'fill="#e0b04e"')
    .replace(/fill="url\(#pat-hard\)"/g, 'fill="#f08470"'),
  "/low-contrast/": (html) => {
    const dimmed = force(html, /(fill|stroke)="#cdb9b9"/g, '$1="#6a4a4a"');
    // The unlit ticket's opacity lives in pictures.js: this plant loads a copy of it with the old 40%.
    return force(dimmed, /src="[^"]*pictures\.js"/, 'src="/planted-js/low-contrast.js"');
  },
};

// A planted page is served from another path, so its relative links (scripts, styles, data) resolve from the site root.
const shared = (html: string): string => html.replace("<head>", '<head><base href="/">');
const PICTURES_JS = join(SITE, "pictures.js");
const PICTURES_CSS = join(SITE, "pictures.css");

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/planted-js/low-contrast.js") return new Response(force(readFileSync(PICTURES_JS, "utf8"), /'\.72'/, "'.4'"), { headers: { "content-type": "text/javascript" } });
    if (pathname === "/planted-css/small-label.css") return new Response(force(readFileSync(PICTURES_CSS, "utf8"), /\.seg span\{padding:0 8px;font:700 \d+px/, ".seg span{padding:0 8px;font:700 13px"), { headers: { "content-type": "text/css" } });
    if (pathname === "/planted-long/") return new Response(shared(readFileSync(PAGE_FILE, "utf8")).replace("Is my week going fine?", "Is my week going fine or is it not going fine at all today?"), { headers: { "content-type": "text/html; charset=utf-8" } });
    const plant = PLANTS[pathname];
    if (plant !== undefined) return new Response(plant(shared(readFileSync(PAGE_FILE, "utf8"))), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (pathname === "/planted/") return new Response(shared(planted()), { headers: { "content-type": "text/html; charset=utf-8" } });
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file);
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function pageAt(width: number, height: number, motion: "no-preference" | "reduce", path = "/", allowFonts = false, fakeClock = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  if (fakeClock) await page.clock.install();
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    seen.push(url.origin);
    // Fonts are allowed but not fetched: the tests stay offline-safe and the fallback faces still lay out.
    const local = url.origin === `http://127.0.0.1:${server.port}`;
    return local || (allowFonts && url.protocol === "https:" && FONT_HOSTS.has(url.hostname)) ? route.continue() : route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

type Copy = { text: string; labels: string[]; pageTitle: string; meta: string[] };

// Every string a visitor can read or hear: the text, each aria-label, the title and the meta content.
async function copyOf(page: Page): Promise<Copy> {
  return page.evaluate(() => {
    const block = document.querySelector(".jx");
    if (block === null) throw new Error("no picture story (.jx) on the page");
    const clone = block.cloneNode(true);
    if (!(clone instanceof HTMLElement)) throw new Error(".jx is not an element");
    // The tokenmax-map skill block (#skill, operator request 2026-10-23) shows the skill report's own field names
    // (models, output tokens) on purpose; the plain-words rule covers the picture story around it.
    clone.querySelectorAll("script,style,#skill").forEach((node) => node.remove());
    const pageTitle = document.title;
    const labels = Array.from(document.querySelectorAll(".jx [aria-label]:not(#skill [aria-label])")).map((node) => node.getAttribute("aria-label") ?? "");
    const meta = Array.from(document.querySelectorAll("meta[content]")).map((node) => node.getAttribute("content") ?? "");
    return { text: clone.textContent ?? "", labels, pageTitle, meta };
  });
}

const everyString = (copy: Copy): string[] => [copy.text, ...copy.labels, copy.pageTitle, ...copy.meta];
const bannedIn = (copy: Copy): string[] => everyString(copy).flatMap((s) => s.match(new RegExp(BANNED.source, "gi")) ?? []);
const dashesIn = (copy: Copy): number => everyString(copy).filter((s) => DASH_GLYPHS.test(s)).length;
const helperDefinitions = (copy: Copy): number => (copy.text.match(/A helper is/g) ?? []).length;

for (const [width, height] of VIEWPORTS) {
  for (const motion of MOTIONS) {
    test(`[integration] E1 no horizontal scroll at ${width} px (${motion})`, async () => {
      const page = await pageAt(width, height, motion);
      try {
        const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }));
        expect(sizes.scroll).toBe(sizes.client);
        expect(sizes.body).toBeLessThanOrEqual(sizes.client);
      } finally { await page.close(); }
    });
  }
}

for (const [width, height] of VIEWPORTS) {
  for (const motion of MOTIONS) {
    test(`[integration] E2 the week button scrolls to one week, two ways at ${width} px (${motion})`, async () => {
      // #week opens the curtain at once under motion, so the button is reachable.
      const page = await pageAt(width, height, motion, "/#week");
      try {
        const cta = page.locator("#week a.cta");
        expect(await cta.getAttribute("href")).toBe("#payoff");
        await cta.click();
        await page.waitForFunction(() => {
          const box = document.getElementById("payoff")?.getBoundingClientRect();
          return box !== undefined && box.top < innerHeight && box.bottom > 0;
        });
        expect(new URL(page.url()).hash).toBe("#payoff");
        expect(await page.evaluate(() => document.activeElement?.id)).toBe("payoff");
      } finally { await page.close(); }
    }, 20000);
  }
}

test("[unit] E3 no banned word and no raw dash glyph in the text, aria-labels, title or meta", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    const copy = await copyOf(page);
    expect(copy.labels.length).toBeGreaterThan(10);
    expect(copy.text.length).toBeGreaterThan(500);
    expect(bannedIn(copy)).toEqual([]);
    expect(dashesIn(copy)).toBe(0);
    expect(readFileSync(PAGE_FILE, "utf8")).not.toMatch(DASH_GLYPHS);
    expect(readFileSync(PAGE_FILE, "utf8")).not.toMatch(/\p{Extended_Pictographic}/u);
  } finally { await page.close(); }
});

test("[unit] E3b the checker itself fails a planted banned word, dash and second definition", async () => {
  const page = await pageAt(1440, 900, "reduce", "/planted/");
  try {
    const copy = await copyOf(page);
    expect(bannedIn(copy)).toEqual(["token"]);
    expect(dashesIn(copy)).toBeGreaterThan(0);
    expect(helperDefinitions(copy)).toBe(2);
  } finally { await page.close(); }
});

for (const [width, height] of VIEWPORTS) {
  test(`[integration] E13 every SVG text sits inside its sign, ticket or box with 4 units to spare at ${width} px (fallback fonts, then web fonts if reachable)`, async () => {
    const fallback = await pageAt(width, height, "reduce");
    try {
      const report = await fitReport(fallback);
      expect(report.fontsLoaded).toBe(0);
      expect(report.checked).toBeGreaterThan(20);
      expect(report.failures).toEqual([]);
    } finally { await fallback.close(); }
    const web = await pageAt(width, height, "reduce", "/", true);
    try {
      const report = await fitReport(web);
      // Google Fonts may be unreachable here; then the fallback run above is the whole check and this one is a repeat of it.
      expect(report.checked).toBeGreaterThan(20);
      expect(report.failures).toEqual([]);
    } finally { await web.close(); }
  }, 30000);
}

test("[unit] E13b the fit checker itself fails a planted overlong string at 390 px", async () => {
  const page = await pageAt(390, 844, "reduce", "/planted-long/");
  try {
    const report = await fitReport(page);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.failures.some((f) => f.startsWith("Is my week going fine or"))).toBe(true);
  } finally { await page.close(); }
});

test("[integration] E14 no role=img contains a button, and the four interactive pictures are groups", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    expect(await page.locator('.jx [role="img"] [role="button"], .jx [role="img"] button, .jx [role="img"] a[href]').count()).toBe(0);
    const interactive = await page.locator("article.poster svg").evaluateAll((nodes) => nodes.map((n) => ({ role: n.getAttribute("role"), buttons: n.querySelectorAll('[role="button"]').length })));
    expect(interactive.length).toBe(4);
    for (const svg of interactive) expect(svg).toEqual({ role: "group", buttons: svg.buttons });
    expect(interactive.every((svg) => svg.buttons > 0)).toBe(true);
    expect(await page.locator('.jx svg[role="img"]').count()).toBeGreaterThan(6);
  } finally { await page.close(); }
});

// The demonstration steps every 1.6 s, twice, once the pictures come into view; the page's clock is faked so the test
// advances it instead of waiting.
const posterState = (page: Page): Promise<string> => page.evaluate(() => [
  document.getElementById("noul-read")?.textContent,
  document.getElementById("choice-read")?.textContent,
  document.getElementById("pin")?.style.transform,
  document.getElementById("rungs")?.querySelector('[aria-pressed="true"]')?.getAttribute("data-i"),
].join("|"));

for (const [width, height] of VIEWPORTS) {
  test(`[integration] E15 there is no pause button; the posters move once in view and stop by themselves within 5 s, and a tap still works after at ${width} px`, async () => {
    const page = await pageAt(width, height, "no-preference", "/#types", false, true);
    try {
      expect(await page.locator("button.pause, #pause-motion").count()).toBe(0);
      await page.locator("#types").scrollIntoViewIfNeeded();
      // The faked clock does not let the page render, so give it real time to report the pictures in view.
      await page.waitForTimeout(150);
      await page.clock.runFor(100);
      const start = await posterState(page);
      await page.clock.runFor(2000);
      expect(await posterState(page)).not.toBe(start);
      await page.clock.runFor(3000);
      const settled = await posterState(page);
      await page.clock.runFor(2700 * 6);
      expect(await posterState(page)).toBe(settled);
      await page.locator("#noul-hit").click();
      expect(await posterState(page)).not.toBe(settled);
    } finally { await page.close(); }
  }, 20000);
}

test("[integration] E16 under reduced motion there is no pause button and the posters do not cycle", async () => {
  const page = await pageAt(390, 844, "reduce", "/", false, true);
  try {
    expect(await page.locator("button.pause, #pause-motion").count()).toBe(0);
    const start = await posterState(page);
    await page.clock.runFor(2700 * 3);
    expect(await posterState(page)).toBe(start);
  } finally { await page.close(); }
});

test("[integration] E4 every card or region with a number carries the word EXAMPLE", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    const regions = await page.evaluate(() => Array.from(document.querySelectorAll("#week .pic, .jx article.poster, section.payoff")).map((node) => {
      const text = node.textContent ?? "";
      return { name: node.className || node.tagName, numbers: /\d/.test(text), example: /example/i.test(text) };
    }));
    expect(regions.length).toBe(6);
    expect(regions.filter((r) => r.numbers).length).toBeGreaterThanOrEqual(2);
    for (const region of regions) if (region.numbers) expect({ name: region.name, example: region.example }).toEqual({ name: region.name, example: true });
    // The two cards that show a figure are labelled on the picture itself, not only in a caption.
    const labelled = await page.locator("article.poster svg text").evaluateAll((nodes) => nodes.filter((n) => n.textContent === "EXAMPLE").length);
    expect(labelled).toBe(2);
  } finally { await page.close(); }
});

for (const [width, height] of VIEWPORTS) {
  test(`[integration] E5 every SVG text renders at 12 px or more at ${width} px`, async () => {
    const page = await pageAt(width, height, "reduce");
    try {
      const sizes = await page.evaluate(() => Array.from(document.querySelectorAll(".jx svg text")).flatMap((node) => {
        if (!(node instanceof SVGGraphicsElement) || node.getClientRects().length === 0) return [];
        const matrix = node.getScreenCTM();
        if (matrix === null) return [];
        return [{ text: node.textContent ?? "", px: parseFloat(getComputedStyle(node).fontSize) * Math.hypot(matrix.a, matrix.b) }];
      }));
      expect(sizes.length).toBeGreaterThan(40);
      const small = sizes.filter((s) => s.px < 11.95).map((s) => `${s.text}: ${s.px.toFixed(2)}`);
      expect(small).toEqual([]);
    } finally { await page.close(); }
  });
}

test("[unit] E6 'A helper is' is defined exactly once", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    expect(helperDefinitions(await copyOf(page))).toBe(1);
  } finally { await page.close(); }
});

test("[integration] E7 the payoff links to the guide, For developers is a 44 px target, and the picture story's links resolve", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    const payoff = await page.locator("#payoff a.cta").getAttribute("href");
    expect(new URL(payoff ?? "", page.url()).pathname).toBe("/guide/");
    const dev = await page.locator("a.dev").boundingBox();
    expect(dev?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(dev?.height ?? 0).toBeGreaterThanOrEqual(44);
    const hrefs = await page.locator(".jx a[href]:not(#skill a)").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") ?? ""));
    expect(hrefs.length).toBe(3);
    for (const href of hrefs) {
      if (href.startsWith("#")) continue;
      const url = new URL(href, page.url());
      expect(url.origin).toBe(`http://127.0.0.1:${server.port}`);
      expect((await fetch(url)).status).toBe(200);
    }
  } finally { await page.close(); }
});

test("[integration] E8 reduced motion shows all three scenes, fully drawn", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "reduce");
    try {
      const scenes = await page.locator("#story .frame").evaluateAll((nodes) => nodes.map((n) => {
        const box = n.getBoundingClientRect();
        const hidden = Array.from(n.querySelectorAll(".in,.pop,.lit")).filter((p) => getComputedStyle(p).opacity !== "1").length;
        return { height: box.height, position: getComputedStyle(n).position, opacity: getComputedStyle(n).opacity, hidden };
      }));
      expect(scenes.length).toBe(3);
      for (const scene of scenes) expect(scene).toMatchObject({ position: "static", opacity: "1", hidden: 0 });
      for (const scene of scenes) expect(scene.height).toBeGreaterThan(100);
      expect(await page.evaluate(() => document.documentElement.classList.contains("motion"))).toBe(false);
      // The payoff bars are at their final state without waiting for a scroll.
      const widths = await page.locator(".tube .seg.l").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().width));
      expect(widths.every((w) => w > 20)).toBe(true);
    } finally { await page.close(); }
  }
});

test("[integration] E9 the payoff bars: thin slices stay visible at 390 px and LIMIT HIT is not red on red", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    const slices = await page.locator(".gauge").first().locator(".seg.s, .seg.m").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().width));
    expect(slices.length).toBe(2);
    for (const w of slices) expect(w).toBeGreaterThanOrEqual(11.5);
    const stamp = await page.locator(".stamp").evaluate((node) => {
      const css = getComputedStyle(node);
      return { color: css.color, background: css.backgroundColor };
    });
    expect(contrast(stamp.color, stamp.background)).toBeGreaterThanOrEqual(4.5);
    const [red = 0, green = 0, blue = 0] = rgb(stamp.color);
    expect(red > green + 60 && red > blue + 60).toBe(false);
    const subtitles = await page.locator(".job i").evaluateAll((nodes) => nodes.map((n) => parseFloat(getComputedStyle(n).fontSize)));
    expect(subtitles.length).toBe(4);
    for (const size of subtitles) expect(size).toBeGreaterThanOrEqual(12);
  } finally { await page.close(); }
});

test("[integration] E10 plain scene 3 labels, brightened wait line, dimmed options at 4.5:1 or better", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    const copy = await copyOf(page);
    expect(copy.text).toContain("YOUR CHOICE");
    expect(copy.text).toContain("WHAT HAPPENS");
    expect(copy.text).not.toContain("YOUR RULE");
    expect(copy.text).not.toContain("DECISION");
    expect(copy.text).toContain("You decide");
    expect(copy.text).toContain("Jev picks from a short list of answers you write. For people who hit their Claude weekly limit.");
    expect(copy.text).toContain("No weekly limit? You can skip this.");
    // For each SVG text: its fill against the nearest rect drawn before it in the same picture.
    const pairs = await page.evaluate(() => {
      const wanted = ["If Large: wait", "Medium", "Large"];
      return Array.from(document.querySelectorAll("svg.narrow text")).flatMap((node) => {
        const text = node.textContent ?? "";
        if (!wanted.includes(text)) return [];
        let rect: Element | null = node.previousElementSibling;
        while (rect !== null && rect.tagName !== "rect") rect = rect.previousElementSibling;
        if (rect === null) return [];
        return [{ text, fg: getComputedStyle(node).fill, bg: getComputedStyle(rect).fill, inLit: node.closest(".lit") !== null }];
      });
    });
    const wait = pairs.find((p) => p.text === "If Large: wait");
    expect(wait).toBeDefined();
    expect(contrast(wait?.fg ?? "", wait?.bg ?? "")).toBeGreaterThanOrEqual(4.5);
    const dim = pairs.filter((p) => p.inLit && (p.text === "Medium" || p.text === "Large"));
    expect(dim.length).toBe(2);
    for (const p of dim) expect(contrast(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5);
    // The unlit tickets in the Pick one card are faded, not erased: ink on a faded paper stays at 4.5:1.
    const opacity = await page.locator("#choice-tickets .tk").nth(0).evaluate((node) => parseFloat(getComputedStyle(node).opacity));
    expect(opacity).toBeGreaterThanOrEqual(0.7);
    const paper = rgb("rgb(239, 226, 196)");
    const ink = rgb("rgb(26, 5, 8)");
    const stage = rgb("rgb(38, 7, 13)");
    const mix = (a: number[], b: number[]): number[] => a.map((c, i) => opacity * c + (1 - opacity) * (b[i] ?? 0));
    expect(contrastRgb(mix(ink, stage), mix(paper, stage))).toBeGreaterThanOrEqual(4.5);
  } finally { await page.close(); }
});

test("[integration] E11 no request leaves the served origin except the Google Fonts hosts", async () => {
  seen.length = 0;
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height, "no-preference");
    await page.waitForTimeout(300);
    await page.close();
  }
  const origins = [...new Set(seen)];
  expect(origins).toContain(`http://127.0.0.1:${server.port}`);
  for (const origin of origins) {
    const url = new URL(origin);
    expect(origin === `http://127.0.0.1:${server.port}` || (url.protocol === "https:" && FONT_HOSTS.has(url.hostname))).toBe(true);
  }
  // Scripts come only from the page's own folder (pictures.js), never from another host.
  expect(readFileSync(PAGE_FILE, "utf8")).not.toMatch(/<script[^>]+src="(https?:)?\/\//i);
});

test("[integration] E12 one h1, four kinds of question, every caption 8 words or fewer", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator("article.poster").count()).toBe(4);
    const captions = await page.locator(".jx .p-cap, .jx .cap").evaluateAll((nodes) => nodes.map((n) => (n.textContent ?? "").trim().split(/\s+/).length));
    expect(captions.length).toBe(7);
    for (const words of captions) expect(words).toBeLessThanOrEqual(8);
  } finally { await page.close(); }
});

// #267: the payoff legend names its unit, covers every bar kind, labels the stretched slices and needs no footnote.
async function legendProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const text = (node: Element | null): string => (node?.textContent ?? "").trim();
    const head = text(document.querySelector("#payoff .keyhead"));
    if (!/share of the weekly limit/i.test(head)) problems.push(`legend heading states no unit: "${head}"`);
    const items = Array.from(document.querySelectorAll("#payoff .key li"));
    for (const li of items) if (!/\d+%/.test(text(li))) problems.push(`legend entry without a percent: "${text(li)}"`);
    const gauge = document.querySelector("#payoff .gauge");
    const kinds = ["base", "s", "m", "l"].filter((kind) => gauge?.querySelector(`.tube .seg.${kind}`) != null);
    if (kinds.length !== 4) problems.push(`first bar draws ${kinds.length} kinds, expected 4`);
    for (const kind of kinds) if (document.querySelector(`#payoff .key li.k-${kind}`) === null) problems.push(`no legend entry for ${kind}`);
    const marks: { kind: string; left: number; right: number }[] = [];
    for (const kind of ["s", "m"]) {
      const seg = gauge?.querySelector(`.tube .seg.${kind}`);
      const mark = gauge?.querySelector(`.marks .mk.${kind}`);
      const label = text(mark?.querySelector("em") ?? null);
      const want = kind === "s" ? "+1%" : "+4%";
      if (seg == null || mark == null) { problems.push(`no label for the ${kind} slice`); continue; }
      if (label !== want) problems.push(`${kind} slice label is "${label}", expected "${want}"`);
      const a = seg.getBoundingClientRect();
      const b = mark.getBoundingClientRect();
      if (Math.abs(a.left - b.left) > 1 || Math.abs(a.width - b.width) > 1) problems.push(`${kind} label is not aligned with its slice`);
      const em = mark.querySelector("em")?.getBoundingClientRect();
      if (em !== undefined) marks.push({ kind, left: em.left, right: em.right });
    }
    const [first, second] = marks;
    if (first !== undefined && second !== undefined && first.right > second.left) problems.push("the +1% and +4% labels overlap");
    if (!/^\+16%$/.test(text(gauge?.querySelector(".tube .seg.l span") ?? null))) problems.push("the large slice carries no +16% label");
    const note = text(document.querySelector("#payoff .legend"));
    if (/thin slices/i.test(note)) problems.push("legend still has the thin-slices footnote");
    if (!/small and medium slices are drawn wider/i.test(note)) problems.push(`legend does not name the widened slices: "${note}"`);
    return problems;
  });
}

for (const [width, height] of VIEWPORTS) {
  test(`[integration] E17 the payoff legend states its unit, covers every bar kind and labels the thin slices at ${width} px`, async () => {
    const page = await pageAt(width, height, "reduce");
    try {
      expect(await legendProblems(page)).toEqual([]);
    } finally { await page.close(); }
  });
}

test("[unit] E17b the legend checker fails the shipped legend (no unit, no slice labels, thin-slices footnote)", async () => {
  const page = await pageAt(390, 844, "reduce", "/old-legend/");
  try {
    const problems = await legendProblems(page);
    expect(problems.some((p) => p.startsWith("legend heading states no unit"))).toBe(true);
    expect(problems.some((p) => p.startsWith("legend entry without a percent"))).toBe(true);
    expect(problems).toContain("no label for the s slice");
    expect(problems).toContain("no label for the m slice");
    expect(problems).toContain("the large slice carries no +16% label");
    expect(problems).toContain("legend still has the thin-slices footnote");
  } finally { await page.close(); }
});

// #268: each caption names its question in everyday words and matches its heading.
async function captionProblems(page: Page): Promise<string[]> {
  const posters = await page.locator("article.poster").evaluateAll((nodes) => nodes.map((node) => {
    const id = node.getAttribute("aria-labelledby") ?? "";
    const heading = id === "" ? null : document.getElementById(id);
    return { heading: (heading?.textContent ?? "").trim(), headingTag: heading?.tagName ?? "", caption: (node.querySelector(".p-cap")?.textContent ?? "").trim() };
  }));
  const problems: string[] = [];
  const wanted = ["Yes or no", "Pick one", "How hard", "Where"];
  if (JSON.stringify(posters.map((p) => p.heading)) !== JSON.stringify(wanted)) problems.push(`headings are ${JSON.stringify(posters.map((p) => p.heading))}`);
  for (const poster of posters) {
    if (poster.headingTag !== "H2") problems.push(`"${poster.heading}": aria-labelledby does not reach an h2`);
    if (!/^(Will|Which|How|Where|What|Is|Does|Can)\b[^?]*\?/.test(poster.caption)) problems.push(`"${poster.heading}": caption asks no plain question: "${poster.caption}"`);
    if (/points to a spot|marks a rung/i.test(poster.caption)) problems.push(`"${poster.heading}": caption uses the banned phrasing`);
  }
  for (const heading of ["How hard", "Where"]) {
    const poster = posters.find((p) => p.heading === heading);
    if (poster !== undefined && !poster.caption.includes(heading)) problems.push(`"${heading}": caption does not use the heading's words`);
  }
  const copy = await copyOf(page);
  for (const phrase of ["How far up", "points to a spot", "marks a rung"]) if (everyString(copy).some((s) => s.includes(phrase))) problems.push(`page still says "${phrase}"`);
  return problems;
}

test("[integration] E18 the four poster captions each ask a plain question and match their headings", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    expect(await captionProblems(page)).toEqual([]);
  } finally { await page.close(); }
});

test("[unit] E18b the caption checker fails the shipped captions and the old How far up heading", async () => {
  const page = await pageAt(1440, 900, "reduce", "/old-captions/");
  try {
    const problems = await captionProblems(page);
    expect(problems.some((p) => p.includes("caption asks no plain question"))).toBe(true);
    expect(problems.some((p) => p.includes("banned phrasing"))).toBe(true);
    expect(problems).toContain("page still says \"How far up\"");
    expect(problems).toContain("page still says \"points to a spot\"");
  } finally { await page.close(); }
});

// #269: every label inside a picture renders at 14 px or more on a phone (screen size: font size x the picture's scale).
const PICTURE_TEXT = ".tube span, .key li, .job b, .job i, .gname, .reading small, .legend, .stamp, .keyhead, .marks em";
async function smallLabels(page: Page): Promise<{ total: number; small: string[] }> {
  return page.evaluate((selector) => {
    const found: { text: string; px: number }[] = [];
    for (const node of Array.from(document.querySelectorAll(".jx svg text"))) {
      if (!(node instanceof SVGGraphicsElement) || node.getClientRects().length === 0) continue;
      const matrix = node.getScreenCTM();
      if (matrix === null) continue;
      found.push({ text: (node.textContent ?? "").trim(), px: parseFloat(getComputedStyle(node).fontSize) * Math.hypot(matrix.a, matrix.b) });
    }
    for (const node of Array.from(document.querySelectorAll(selector))) {
      if (node.getClientRects().length === 0) continue;
      found.push({ text: (node.textContent ?? "").trim(), px: parseFloat(getComputedStyle(node).fontSize) });
    }
    return { total: found.length, small: found.filter((f) => f.px < 13.95).map((f) => `${f.text}: ${f.px.toFixed(2)}`) };
  }, PICTURE_TEXT);
}

test("[integration] E19 every label in the pictures renders at 14 px or more at 390 px", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    const report = await smallLabels(page);
    expect(report.total).toBeGreaterThan(70);
    expect(report.small).toEqual([]);
  } finally { await page.close(); }
});

test("[unit] E19b the size checker fails a planted 13 px SVG label and a planted 13 px payoff label", async () => {
  const page = await pageAt(390, 844, "reduce", "/small-label/");
  try {
    const report = await smallLabels(page);
    expect(report.small.some((s) => s.startsWith("PICK ONE"))).toBe(true);
    expect(report.small.some((s) => s.startsWith("already used"))).toBe(true);
  } finally { await page.close(); }
});

// #269: the hero chart tells easy, ordinary and hard jobs apart by a second cue, not hue alone.
async function patternProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const svg = document.querySelector("#week svg");
    if (svg === null) return ["no hero chart"];
    const fillOf = (rect: Element): string => rect.getAttribute("fill") ?? "";
    const idOf = (fill: string): string => fill.match(/^url\(#([^)]+)\)$/)?.[1] ?? "";
    const blocks = Array.from(svg.querySelectorAll("g[stroke] g rect")).map(fillOf);
    const kinds = new Set(blocks);
    if (kinds.size !== 3) problems.push(`blocks use ${kinds.size} distinct fills, expected 3`);
    const ids = [...kinds].map(idOf);
    for (const id of ids) {
      if (id === "") problems.push("a block fill is a plain colour, not a pattern");
      else if (svg.querySelector(`defs pattern#${id}`) === null) problems.push(`pattern ${id} is not defined in the chart`);
    }
    if (new Set(ids).size !== ids.length) problems.push("two job kinds share a pattern");
    const rows: [string, number][] = [["easy job", 0], ["ordinary job", 1], ["hard job", 2]];
    for (const [label, index] of rows) {
      const text = Array.from(svg.querySelectorAll("text")).find((t) => t.textContent === label);
      let swatch: Element | null = text?.previousElementSibling ?? null;
      while (swatch !== null && swatch.tagName !== "rect") swatch = swatch.previousElementSibling;
      const fill = swatch === null ? "" : fillOf(swatch);
      if (idOf(fill) === "" || idOf(fill) !== ids[index]) problems.push(`legend swatch for ${label} does not use the pattern of its blocks`);
    }
    return problems;
  });
}

test("[integration] E20 easy, ordinary and hard blocks and their legend swatches use three different patterns", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    expect(await patternProblems(page)).toEqual([]);
  } finally { await page.close(); }
});

test("[unit] E20b the pattern checker fails a hue-only chart", async () => {
  const page = await pageAt(390, 844, "reduce", "/hue-only/");
  try {
    const problems = await patternProblems(page);
    expect(problems).toContain("a block fill is a plain colour, not a pattern");
    expect(problems.some((p) => p.startsWith("legend swatch for hard job"))).toBe(true);
  } finally { await page.close(); }
});

// #269: dimmed option text stays at 4.5:1 on the colours as drawn, including the faded paper of the unlit tickets.
type Dimmed = { what: string; fg: string; bg: string; opacity: number; stage: string };
async function dimmedOptions(page: Page, wide: boolean): Promise<Dimmed[]> {
  const out: Dimmed[] = [];
  for (const i of [0, 1, 2]) {
    await page.locator(`#choice-tickets .tk[data-i="${i}"]`).click();
    out.push(...await page.evaluate((lit) => Array.from(document.querySelectorAll("#choice-tickets .tk")).flatMap((group, k) => {
      const rect = group.querySelector("rect");
      const label = group.querySelector("text");
      const stage = group.closest("svg")?.querySelector(":scope > rect");
      if (k === lit || rect === null || label === null || stage == null) return [];
      return [{ what: `ticket ${k} while ${lit} is lit`, fg: getComputedStyle(label).fill, bg: getComputedStyle(rect).fill, opacity: parseFloat(getComputedStyle(group).opacity), stage: getComputedStyle(stage).fill }];
    }), i));
  }
  out.push(...await page.evaluate((selector) => Array.from(document.querySelectorAll(`${selector} .lit text`)).flatMap((node) => {
    const label = node.textContent ?? "";
    if (label !== "Medium" && label !== "Large") return [];
    let rect: Element | null = node.previousElementSibling;
    while (rect !== null && rect.tagName !== "rect") rect = rect.previousElementSibling;
    if (rect === null || node.getClientRects().length === 0) return [];
    return [{ what: `${label} in ${selector}`, fg: getComputedStyle(node).fill, bg: getComputedStyle(rect).fill, opacity: 1, stage: getComputedStyle(rect).fill }];
  }), wide ? "svg.wide" : "svg.narrow"));
  return out;
}

const dimmedFailures = (options: Dimmed[]): string[] => options.flatMap((o) => {
  const stage = rgb(o.stage);
  const mix = (c: number[]): number[] => c.map((v, i) => o.opacity * v + (1 - o.opacity) * (stage[i] ?? 0));
  const ratio = contrastRgb(mix(rgb(o.fg)), mix(rgb(o.bg)));
  return ratio >= 4.5 ? [] : [`${o.what}: ${ratio.toFixed(2)}:1`];
});

test("[integration] E21 every dimmed option, unlit ticket and dim scene 2 answer is 4.5:1 or better on its blended colours", async () => {
  const sizes: [number, number, boolean][] = [[390, 844, false], [1440, 900, true]];
  for (const [width, height, wide] of sizes) {
    const page = await pageAt(width, height, "reduce");
    try {
      const options = await dimmedOptions(page, wide);
      expect(options.length).toBe(8);
      expect(dimmedFailures(options)).toEqual([]);
    } finally { await page.close(); }
  }
});

test("[unit] E21b the dimmed-option checker fails a planted faint option colour and a planted 40% ticket", async () => {
  const page = await pageAt(390, 844, "reduce", "/low-contrast/");
  try {
    const failures = dimmedFailures(await dimmedOptions(page, false));
    expect(failures.some((f) => f.startsWith("Medium in svg.narrow"))).toBe(true);
    expect(failures.some((f) => f.startsWith("ticket "))).toBe(true);
  } finally { await page.close(); }
});

type Fit = { checked: number; failures: string[]; fontsLoaded: number };

// For every visible SVG text: its tspan-aware box must lie inside the nearest enclosing [data-fit] shape with at
// least 4 user units of padding, and inside its own viewBox. Fonts are awaited first, so a webfont that is wider
// than the fallback is measured as it renders.
async function fitReport(page: Page): Promise<Fit> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const fontsLoaded = Array.from(document.fonts).filter((face) => face.status === "loaded").length;
    const failures: string[] = [];
    let checked = 0;
    for (const text of Array.from(document.querySelectorAll(".jx svg text"))) {
      if (!(text instanceof SVGTextElement) || text.getClientRects().length === 0) continue;
      const svg = text.ownerSVGElement;
      const rootInverse = svg?.getScreenCTM()?.inverse();
      const textScreen = text.getScreenCTM();
      if (svg === null || svg === undefined || rootInverse === undefined || textScreen === null) continue;
      // Coordinates in the picture's own units (its viewBox), whatever size it is drawn at.
      const matrix = rootInverse.multiply(textScreen);
      const label = (text.textContent ?? "").trim();
      const box = text.getBBox();
      const corners = [new DOMPoint(box.x, box.y), new DOMPoint(box.x + box.width, box.y + box.height)].map((p) => p.matrixTransform(matrix));
      const [topLeft, bottomRight] = corners;
      if (topLeft === undefined || bottomRight === undefined) continue;
      const view = svg.viewBox.baseVal;
      if (topLeft.x < view.x || topLeft.y < view.y || bottomRight.x > view.x + view.width || bottomRight.y > view.y + view.height) failures.push(`${label}: outside its picture`);
      const centre = new DOMPoint((topLeft.x + bottomRight.x) / 2, (topLeft.y + bottomRight.y) / 2);
      let best: { left: number; top: number; right: number; bottom: number } | null = null;
      let bestArea = Infinity;
      for (const shape of Array.from(svg.querySelectorAll("[data-fit]"))) {
        if (!(shape instanceof SVGGraphicsElement)) continue;
        const shapeScreen = shape.getScreenCTM();
        if (shapeScreen === null) continue;
        const shapeMatrix = rootInverse.multiply(shapeScreen);
        const b = shape.getBBox();
        const a = new DOMPoint(b.x, b.y).matrixTransform(shapeMatrix);
        const c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(shapeMatrix);
        if (centre.x < a.x || centre.x > c.x || centre.y < a.y || centre.y > c.y) continue;
        const area = (c.x - a.x) * (c.y - a.y);
        if (area < bestArea) { bestArea = area; best = { left: a.x, top: a.y, right: c.x, bottom: c.y }; }
      }
      if (best === null) continue;
      checked++;
      const pads = { left: topLeft.x - best.left, right: best.right - bottomRight.x, top: topLeft.y - best.top, bottom: best.bottom - bottomRight.y };
      const least = Math.min(pads.left, pads.right, pads.top, pads.bottom);
      if (least < 4) failures.push(`${label}: padding ${least.toFixed(1)} (left ${pads.left.toFixed(1)}, right ${pads.right.toFixed(1)}, top ${pads.top.toFixed(1)}, bottom ${pads.bottom.toFixed(1)})`);
    }
    return { checked, failures, fontsLoaded };
  });
}

function rgb(color: string): number[] {
  const match = color.match(/rgba?\(([^)]+)\)/);
  if (match === null) throw new Error(`not a colour: ${color}`);
  return (match[1] ?? "").split(",").slice(0, 3).map((part) => Number(part.trim()));
}

function luminance(channels: number[]): number {
  const [r = 0, g = 0, b = 0] = channels.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRgb(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

function contrast(fg: string, bg: string): number {
  return contrastRgb(rgb(fg), rgb(bg));
}
