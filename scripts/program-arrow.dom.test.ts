// The blue arrow at Program (guide) and the programme scroll that drops when the link or a Read the programme button is
// hovered, focused or touched. Real site files, real Chromium (playwright-core).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
const SIZES: [number, number][] = [[1440, 900], [1280, 900], [768, 1024], [390, 844]];
type Motion = "no-preference" | "reduce";
type Mode = "closed" | "rolled" | "open";
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

/** closed: the first visit's closed curtain. rolled: curtain seen, scroll rolled up. open: curtain seen, scroll open (reduced motion shows it open). */
async function landing(width: number, height: number, mode: Mode, motion: Motion = "no-preference", touch = false): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, hasTouch: touch });
  const page = await context.newPage();
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.addInitScript((m: Mode) => {
    try {
      if (m !== "closed") sessionStorage.setItem("jnj-overture", "seen");
      if (m === "rolled") localStorage.setItem("jnj-programme", "rolled");
    } catch { /* nothing remembered */ }
  }, mode);
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "load" });
  if (mode === "open") await page.waitForFunction(() => document.getElementById("programme")?.dataset.state === "open");
  if (mode === "rolled") await page.waitForFunction(() => document.getElementById("programme")?.dataset.state === "rolled");
  return page;
}

interface Box { x: number; y: number; width: number; height: number }

async function box(page: Page, selector: string): Promise<Box> {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`no box for ${selector}`);
  return found;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The arrow's box with every visible link, button and field box that is not the Program link itself. */
async function crowd(page: Page): Promise<{ arrow: Box; others: { name: string; box: Box }[] }> {
  const arrow = await box(page, "#programArrow");
  const others = await page.evaluate(() => [...document.querySelectorAll("a,button,input,select,summary,[tabindex]")]
    .filter((el) => el.id !== "programLink" && getComputedStyle(el).visibility !== "hidden")
    .map((el) => ({ name: `${el.tagName}#${el.id}.${el.className}`, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0)
    .map(({ name, r }) => ({ name, box: { x: r.x, y: r.y, width: r.width, height: r.height } })));
  return { arrow, others };
}

/** Every box above the fold (the curtain drapes sway on their own, so the proscenium is left out): id or tag, class, rounded rect. */
async function foldBoxes(page: Page, height: number): Promise<string[]> {
  return page.evaluate((h) => [...document.querySelectorAll("body *")]
    .filter((el) => !el.closest("svg") && !el.closest(".proscenium") && !el.closest("#programme .programme-scroll") && !el.matches(".programme-scroll"))
    .map((el) => ({ name: `${el.tagName}#${el.id}`, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0 && r.top < h)
    .map(({ name, r }) => `${name}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`), height);
}

test("[smoke] PA-1 the landing HTML draws the arrow as inline SVG inside the Program (guide) link, hidden from assistive tech", async () => {
  const html = await (await fetch(`http://127.0.0.1:${server.port}/`)).text();
  expect(html).toMatch(/<a class="program-link" id="programLink" href="\/guide\/">Program \(guide\)<svg class="program-arrow" id="programArrow"[^>]*aria-hidden="true"[^>]*>.*?<\/svg><\/a>/);
  expect(html).not.toMatch(/program-arrow[^>]*\bsrc=/);
});

for (const [width, height] of SIZES) for (const mode of ["closed", "open"] as const) {
  test(`[integration] PA-2 at ${width}x${height} (${mode}) the blue arrow is visible, points at Program (guide) from its left, and covers no control`, async () => {
    const page = await landing(width, height, mode);
    try {
      const arrowEl = page.locator("#programArrow");
      const visible = await arrowEl.isVisible();
      const { arrow, others } = await crowd(page);
      const link = await box(page, "#programLink");
      const fill = await arrowEl.evaluate((el) => getComputedStyle(el).fill);
      expect(fill).toBe("rgb(42, 160, 255)");
      expect(await page.locator("#programArrow path").count()).toBe(1);
      const nudged = await page.evaluate(() => document.getElementById("programArrow")?.getAnimations().map((a) => a instanceof CSSAnimation ? a.animationName : "") ?? []);
      expect(nudged).toEqual(["program-arrow-nudge"]);
      // Phones with no clear room may hide the arrow; wherever it shows it must point at the link and cover nothing.
      if (width >= 768) expect(visible).toBe(true);
      if (!visible) return;
      expect(arrow.x + arrow.width).toBeLessThanOrEqual(link.x + 1);
      expect(arrow.x + arrow.width).toBeGreaterThanOrEqual(link.x - 90);
      expect(arrow.y + arrow.height).toBeGreaterThan(link.y);
      expect(arrow.y).toBeLessThan(link.y + link.height);
      expect(overlaps(arrow, link)).toBe(false);
      expect(others.filter((o) => overlaps(arrow, o.box)).map((o) => o.name)).toEqual([]);
      expect(arrow.x).toBeGreaterThanOrEqual(0);
    } finally { await page.context().close(); }
  }, 30000);
}

test("[integration] PA-3 the arrow does not move the layout: boxes above the fold are the same with and without it", async () => {
  const page = await landing(1440, 900, "rolled");
  try {
    const pos = await page.locator("#programArrow").evaluate((el) => getComputedStyle(el).position);
    expect(pos).toBe("absolute");
    const before = await foldBoxes(page, 900);
    await page.locator("#programArrow").evaluate((el) => { el.style.display = "none"; });
    expect(await foldBoxes(page, 900)).toEqual(before);
  } finally { await page.context().close(); }
});

const TRIGGERS: { id: string; mode: Mode }[] = [{ id: "#programLink", mode: "rolled" }, { id: "#programmeRolled", mode: "rolled" }, { id: "#programLink", mode: "open" }, { id: "#programmeRead", mode: "open" }];

for (const t of TRIGGERS) for (const how of ["hover", "focus"] as const) {
  test(`[integration] PA-4 ${how} on ${t.id} with the scroll ${t.mode} adds the playing state, and leaving removes it`, async () => {
    const page = await landing(1440, 900, t.mode);
    try {
      expect(await page.locator("#programme").evaluate((el) => el.classList.contains("peek"))).toBe(false);
      if (how === "hover") await page.locator(t.id).hover(); else await page.locator(t.id).focus();
      await page.waitForFunction(() => document.getElementById("programme")?.classList.contains("peek"));
      // The scroll is on show and unrolling: a programme-unroll animation runs on the sheet, then it finishes.
      const names = await page.locator("#programmeSheet").evaluate((el) => el.getAnimations().map((a) => a instanceof CSSAnimation ? a.animationName : ""));
      if (t.mode === "rolled" || t.id === "#programLink") expect(names).toContain("programme-unroll");
      expect(await page.locator("#programmeSheet").isVisible()).toBe(true);
      if (how === "hover") await page.mouse.move(5, 500); else await page.locator(t.id).blur();
      await page.waitForFunction(() => !document.getElementById("programme")?.classList.contains("peek"));
      if (t.mode === "rolled") expect(await page.locator("#programmeSheet").isVisible()).toBe(false);
    } finally { await page.context().close(); }
  }, 30000);
}

test("[integration] PA-5 the Read the programme overlay is absolute, takes no pointer events, and the rolled button stays clickable to /guide/", async () => {
  const page = await landing(1440, 900, "rolled");
  try {
    await page.locator("#programmeRolled").hover();
    await page.waitForFunction(() => document.getElementById("programme")?.classList.contains("peek"));
    const style = await page.locator(".programme-scroll").evaluate((el) => ({ position: getComputedStyle(el).position, events: getComputedStyle(el).pointerEvents }));
    expect(style).toEqual({ position: "absolute", events: "none" });
    await Promise.all([page.waitForURL("**/guide/"), page.locator("#programmeRolled").click()]);
  } finally { await page.context().close(); }
}, 30000);

for (const t of TRIGGERS) test(`[integration] PA-6 hovering ${t.id} (${t.mode}) moves no box above the fold`, async () => {
  const page = await landing(1440, 900, t.mode);
  try {
    // Wait out the first-visit entrance so only the hover can change a box.
    await page.waitForTimeout(1500);
    const before = await foldBoxes(page, 900);
    await page.locator(t.id).hover();
    await page.waitForFunction(() => document.getElementById("programme")?.classList.contains("peek"));
    await page.waitForTimeout(400);
    expect(await foldBoxes(page, 900)).toEqual(before);
    await page.waitForTimeout(900);
    expect(await foldBoxes(page, 900)).toEqual(before);
  } finally { await page.context().close(); }
}, 30000);

test("[integration] PA-7 a first tap is not swallowed: touchstart plays the scroll and the tap still follows the link", async () => {
  const page = await landing(390, 844, "rolled", "no-preference", true);
  try {
    const prevented = await page.evaluate(() => new Promise<boolean>((resolve) => {
      const link = document.getElementById("programLink");
      if (!link) { resolve(true); return; }
      const event = new Event("touchstart", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      resolve(event.defaultPrevented);
    }));
    expect(prevented).toBe(false);
    expect(await page.locator("#programme").evaluate((el) => el.classList.contains("peek"))).toBe(true);
    await page.waitForFunction(() => !document.getElementById("programme")?.classList.contains("peek"), undefined, { timeout: 5000 });
    await Promise.all([page.waitForURL("**/guide/"), page.locator("#programLink").tap()]);
  } finally { await page.context().close(); }
}, 30000);

for (const t of TRIGGERS) test(`[integration] PA-8 reduced motion: no nudge and no drop on ${t.id} (${t.mode})`, async () => {
  const page = await landing(1440, 900, t.mode === "rolled" ? "rolled" : "open", "reduce");
  try {
    const arrowAnimations = await page.evaluate(() => document.getElementById("programArrow")?.getAnimations().length ?? -1);
    expect(arrowAnimations).toBe(0);
    expect(await page.locator("#programArrow").isVisible()).toBe(true);
    await page.locator(t.id).hover();
    await page.locator(t.id).focus();
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => ({ peek: document.getElementById("programme")?.classList.contains("peek"), running: document.getElementById("programmeSheet")?.getAnimations().length ?? -1 }));
    expect(after).toEqual({ peek: false, running: 0 });
    if (t.mode === "rolled") expect(await page.locator("#programmeSheet").isVisible()).toBe(false);
  } finally { await page.context().close(); }
}, 30000);
