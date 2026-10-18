import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
const PAGE_FILE = join(SITE, "explainer", "index.html");
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
  return html.replace("</footer>", `<span>token A helper is ${EM_DASH} here</span></footer>`);
}

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/planted/") return new Response(planted(), { headers: { "content-type": "text/html; charset=utf-8" } });
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file);
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

async function pageAt(width: number, height: number, motion: "no-preference" | "reduce", path = "/explainer/"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: motion });
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    seen.push(url.origin);
    // Fonts are allowed but not fetched: the tests stay offline-safe and the fallback faces still lay out.
    return url.origin === `http://127.0.0.1:${server.port}` ? route.continue() : route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.port}${path}`, { waitUntil: "domcontentloaded" });
  return page;
}

type Copy = { text: string; labels: string[]; pageTitle: string; meta: string[] };

// Every string a visitor can read or hear: the text, each aria-label, the title and the meta content.
async function copyOf(page: Page): Promise<Copy> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    if (!(clone instanceof HTMLElement)) throw new Error("body is not an element");
    clone.querySelectorAll("script,style").forEach((node) => node.remove());
    const pageTitle = document.title;
    const labels = Array.from(document.querySelectorAll("[aria-label]")).map((node) => node.getAttribute("aria-label") ?? "");
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
    test(`[integration] E2 the entry button scrolls to the four kinds of question at ${width} px (${motion})`, async () => {
      const page = await pageAt(width, height, motion);
      try {
        expect(await page.locator("a.cta").first().getAttribute("href")).toBe("#types");
        await page.locator("a.cta").first().click();
        await page.waitForFunction(() => {
          const box = document.getElementById("types")?.getBoundingClientRect();
          return box !== undefined && box.top < innerHeight && box.bottom > 0;
        });
        expect(new URL(page.url()).hash).toBe("#types");
        const box = await page.locator("#types").evaluate((node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, inner: innerHeight }; });
        expect(box.top).toBeLessThan(box.inner);
        expect(box.bottom).toBeGreaterThan(0);
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

test("[integration] E4 every card or region with a number carries the word EXAMPLE", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    const regions = await page.evaluate(() => Array.from(document.querySelectorAll("header.entry .pic, article.poster, section.payoff, footer")).map((node) => {
      const text = node.textContent ?? "";
      return { name: node.className || node.tagName, numbers: /\d/.test(text), example: /example/i.test(text) };
    }));
    expect(regions.length).toBe(7);
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
      const sizes = await page.evaluate(() => Array.from(document.querySelectorAll("svg text")).flatMap((node) => {
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

test("[integration] E7 the payoff links to the guide, For developers is a 44 px target, and links resolve under /explainer/", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    const payoff = await page.locator("#payoff a.cta").getAttribute("href");
    expect(payoff?.endsWith("/guide/")).toBe(true);
    const dev = await page.locator("a.dev").boundingBox();
    expect(dev?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(dev?.height ?? 0).toBeGreaterThanOrEqual(44);
    const hrefs = await page.locator("a[href]").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("href") ?? ""));
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
      const scenes = await page.locator(".frame").evaluateAll((nodes) => nodes.map((n) => {
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
    const opacity = await page.locator("#tickets .tk").nth(0).evaluate((node) => parseFloat(getComputedStyle(node).opacity));
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
  expect(readFileSync(PAGE_FILE, "utf8")).not.toMatch(/<script[^>]+src=/i);
});

test("[integration] E12 one h1, four kinds of question, every caption 8 words or fewer", async () => {
  const page = await pageAt(1440, 900, "reduce");
  try {
    expect(await page.locator("h1").count()).toBe(1);
    expect(await page.locator("article.poster").count()).toBe(4);
    const captions = await page.locator(".p-cap, .cap").evaluateAll((nodes) => nodes.map((n) => (n.textContent ?? "").trim().split(/\s+/).length));
    expect(captions.length).toBe(7);
    for (const words of captions) expect(words).toBeLessThanOrEqual(8);
  } finally { await page.close(); }
});

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
