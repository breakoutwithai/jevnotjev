// The programme scroll on the landing page: a parchment scroll that unrolls once on a first visit and points at the
// guide, then rolls up to a persistent "Read the programme" button. Real site files, real Chromium (playwright-core).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    if (pathname === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
    const path = join(SITE, pathname.endsWith("/") ? `${pathname}index.html` : pathname);
    if (!path.startsWith(`${SITE}/`)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(file);
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

interface Visit { readonly motion: "no-preference" | "reduce"; readonly curtain?: boolean; readonly storage?: "ok" | "throws"; readonly errors?: string[] }

/** A page with the curtain already seen this tab session (a later page), unless `curtain` asks for the first one. */
async function landing(width: number, height: number, visit: Visit): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: visit.motion });
  if (visit.errors) { const errors = visit.errors; page.on("pageerror", (error) => errors.push(error.message)); }
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  if (!visit.curtain) await page.addInitScript(() => { try { sessionStorage.setItem("jnj-overture", "seen"); } catch { /* the curtain plays */ } });
  if (visit.storage === "throws") {
    await page.addInitScript(() => {
      const fail = (): never => { throw new DOMException("blocked", "SecurityError"); };
      Object.defineProperty(window, "localStorage", { configurable: true, get: fail });
    });
  }
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
  return page;
}

async function state(page: Page): Promise<string | null> {
  return page.locator("#programme").getAttribute("data-state");
}

test("[smoke] PG-1 the served landing page carries the programme scroll and its rolled button, both linking to /guide/", async () => {
  const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
  expect(html).toContain('id="programme"');
  expect(html).toMatch(/<a class="programme-read" id="programmeRead" href="\/guide\/">Read the programme<\/a>/);
  expect(html).toMatch(/<a class="programme-rolled" id="programmeRolled" href="\/guide\/">(?:<span[^>]*><\/span>)?Read the programme<\/a>/);
  expect(html).toContain('id="programLink" href="/guide/"');
  expect(html).toContain("See whether your Claude plan is going to waste, and when Jev is worth using.");
  expect(html).toContain('<script src="programme.js"></script>');
});

test("[unit] PG-2 theatre.css switches the programme animation off under prefers-reduced-motion: reduce", () => {
  const css = readFileSync(join(SITE, "theatre.css"), "utf8");
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{[^@]*\.programme[^@]*\}/);
  expect(block?.[0]).toContain("animation: none");
  expect(block?.[0]).toContain("transition: none");
});

for (const [width, height] of VIEWPORTS) {
  test(`[integration] PG-3 first visit unrolls the scroll, keyboard reaches its links with a visible focus ring, no overflow (${width}px)`, async () => {
    const errors: string[] = [];
    const page = await landing(width, height, { motion: "no-preference", errors });
    try {
      await page.locator("#programme").scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.getElementById("programme")?.dataset.state === "open");
      expect(await page.locator("#programme").evaluate((el) => el.classList.contains("unroll"))).toBe(true);
      await page.locator("#programmeSheet").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
      expect(await page.locator("#programmeRead").isVisible()).toBe(true);
      expect(await page.locator("#programmeRolled").isVisible()).toBe(false);
      const fit = await page.evaluate(() => {
        const h1 = document.getElementById("t1")?.getBoundingClientRect();
        const scroll = document.getElementById("programme")?.getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          right: scroll ? scroll.right <= innerWidth : false,
          belowHeading: h1 && scroll ? scroll.top >= h1.bottom : false,
        };
      });
      expect(fit).toEqual({ overflow: 0, right: true, belowHeading: true });
      await page.locator("#programmeRead").focus();
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.id)).toBe("programmeClose");
      const ring = await page.locator("#programmeClose").evaluate((el) => { const s = getComputedStyle(el); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; });
      expect(ring.style).not.toBe("none");
      expect(ring.width).toBeGreaterThanOrEqual(2);
      for (const id of ["#programmeRead", "#programmeClose"]) {
        const box = await page.locator(id).boundingBox();
        expect(box !== null && box.width >= 24 && box.height >= 24).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 30000);
}

test("[integration] PG-4 dismissing rolls it up to a visible Read the programme button, focus moves there, and a reload stays rolled", async () => {
  const page = await landing(390, 844, { motion: "no-preference" });
  try {
    await page.locator("#programme").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.getElementById("programme")?.dataset.state === "open");
    await page.locator("#programmeClose").click();
    await page.waitForFunction(() => document.getElementById("programme")?.dataset.state === "rolled");
    expect(await page.locator("#programmeRolled").isVisible()).toBe(true);
    expect(await page.locator("#programmeRead").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("programmeRolled");
    expect(await page.locator("#programmeRolled").getAttribute("href")).toBe("/guide/");
    expect(await page.evaluate(() => localStorage.getItem("jnj-programme"))).toBe("rolled");
    await page.reload({ waitUntil: "load" });
    expect(await state(page)).toBe("rolled");
    expect(await page.locator("#programmeRolled").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  } finally { await page.close(); }
}, 30000);

test("[integration] PG-5 the scroll unrolls once: a second visit shows the rolled button without dismissing", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  try {
    await context.addInitScript(() => { try { sessionStorage.setItem("jnj-overture", "seen"); } catch { /* the curtain plays */ } });
    const first = await context.newPage();
    await first.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    await first.locator("#programme").scrollIntoViewIfNeeded();
    await first.waitForFunction(() => document.getElementById("programme")?.dataset.state === "open");
    await first.close();
    const second = await context.newPage();
    await second.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
    expect(await state(second)).toBe("rolled");
    expect(await second.locator("#programmeRolled").isVisible()).toBe(true);
  } finally { await context.close(); }
}, 30000);

test("[integration] PG-6 reduced motion shows the scroll open and static, with no animation running", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await landing(width, height, { motion: "reduce" });
    try {
      expect(await state(page)).toBe("open");
      expect(await page.locator("#programmeRead").isVisible()).toBe(true);
      const anim = await page.locator("#programmeSheet").evaluate((el) => ({ name: getComputedStyle(el).animationName, running: el.getAnimations().length }));
      expect(anim).toEqual({ name: "none", running: 0 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    } finally { await page.close(); }
  }
}, 30000);

test("[integration] PG-7 with storage blocked the scroll still shows and dismisses, and nothing throws", async () => {
  const errors: string[] = [];
  const page = await landing(390, 844, { motion: "reduce", storage: "throws", errors });
  try {
    expect(await state(page)).toBe("open");
    await page.locator("#programmeClose").click();
    expect(await state(page)).toBe("rolled");
    expect(await page.locator("#programmeRolled").isVisible()).toBe(true);
    expect(errors).toEqual([]);
  } finally { await page.close(); }
}, 30000);

test("[integration] PG-8 on the first page of a session the scroll waits for the curtain, then unrolls once it opens", async () => {
  const page = await landing(1440, 900, { motion: "no-preference", curtain: true });
  try {
    expect(await page.evaluate(() => document.documentElement.dataset.curtain)).toBe("closed");
    expect(await state(page)).toBe("waiting");
    const typesTop = (): Promise<number> => page.evaluate(() => (document.getElementById("types")?.getBoundingClientRect().top ?? 0) + scrollY);
    const before = await typesTop();
    await page.locator("#raise").click();
    await page.waitForFunction(() => document.documentElement.dataset.curtain === "open");
    await page.locator("#programme").scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.getElementById("programme")?.dataset.state === "open");
    await page.locator("#programmeSheet").evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    // Unrolling moves nothing under it: the results keep their place in the page.
    expect(await typesTop()).toBe(before);
  } finally { await page.close(); }
}, 30000);
