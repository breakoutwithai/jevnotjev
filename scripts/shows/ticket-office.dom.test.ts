import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "../uat/happy-path-lib.ts";
import type { Poster } from "../../src/shows/posters.ts";

const SITE = process.env.LANDING_TEST_SITE ?? join(import.meta.dir, "..", "..", "site");
const POSTERS: { posters: Poster[] } = JSON.parse(readFileSync(join(SITE, "shows", "posters.json"), "utf8"));
const CAPTURE = process.env.UAT_SCREENSHOT_DIR;
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
const MOTIONS: ("no-preference" | "reduce")[] = ["no-preference", "reduce"];
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

async function pageAt(width: number, height: number, reducedMotion: "reduce" | "no-preference" = "no-preference"): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion });
  await page.route("**/*", (route) => route.request().url().startsWith(`http://127.0.0.1:${server.port}/`) ? route.continue() : route.abort());
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
  return page;
}

test("[integration] #136 plain first screen and ticket-office link are visible and clickable", async () => {
  for (const [width, height] of VIEWPORTS) for (const motion of MOTIONS) {
    const page = await pageAt(width, height, motion);
    try {
      expect(await page.locator("#t1").innerText()).toBe("Jev picks one answer from a fixed list. It does not write text.");
      const jump = page.getByRole("link", { name: "Go to the ticket office" });
      expect(await jump.isVisible()).toBe(true);
      expect(await jump.evaluate((node) => { const box = node.getBoundingClientRect(); return box.top >= 0 && box.top < innerHeight; })).toBe(true);
      if (CAPTURE && motion === "no-preference") { mkdirSync(CAPTURE, { recursive: true }); await page.screenshot({ path: join(CAPTURE, `first-${width}.png`) }); }
      await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });
      await jump.click();
      expect(new URL(page.url()).hash).toBe("#tickets");
      await page.waitForFunction(() => {
        const office = document.getElementById("tickets");
        return office !== null && Math.abs(office.getBoundingClientRect().top) <= 100;
      }, null, { polling: 100, timeout: 5000 });
      expect(await page.locator("#officeOpen").isVisible()).toBe(true);
    } finally { await page.close(); }
  }
}, 20000);

test("[integration] #136 first screen explains the fixed-answer decision", async () => {
  for (const [width, height] of VIEWPORTS) for (const motion of MOTIONS) {
    const page = await pageAt(width, height, motion);
    try {
      expect(await page.locator("#t1").innerText()).toBe("Jev picks one answer from a fixed list. It does not write text.");
      expect(await page.locator("#t1").isVisible()).toBe(true);
    } finally { await page.close(); }
  }
}, 20000);

test("[integration] #135 the sample badge intersects no office control or text line across the whole office", async () => {
  const page = await pageAt(390, 844);
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
    const intersections = await page.evaluate(async () => {
        document.documentElement.style.scrollBehavior = "auto";
        const office = document.getElementById("tickets");
        const badge = document.getElementById("sampleBadge");
        if (!office || !badge) return ["missing office or badge"];
        const top = office.getBoundingClientRect().top + scrollY;
        const bottom = top + office.offsetHeight;
        const hits: string[] = [];
        for (let target = top; target <= bottom + 150; target = Math.min(target + 150, bottom + 150)) {
          scrollTo(0, target);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const b = badge.getBoundingClientRect();
          if (b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth) {
            const crosses = (r: DOMRect) => r.width > 0 && r.height > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
            for (const element of office.querySelectorAll("a, button, input, select, textarea, label")) {
              if (getComputedStyle(element).visibility === "visible" && crosses(element.getBoundingClientRect())) hits.push(`${Math.round(scrollY)}:${element.tagName}:${(element.textContent ?? "").trim().slice(0, 25)}`);
            }
            const walker = document.createTreeWalker(office, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
              const node = walker.currentNode;
              if (!node.textContent?.trim() || !node.parentElement || getComputedStyle(node.parentElement).visibility !== "visible") continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              let lineContainer = node.parentElement;
              while (lineContainer !== office && getComputedStyle(lineContainer).display === "inline" && lineContainer.parentElement) lineContainer = lineContainer.parentElement;
              const lineWidth = lineContainer.getBoundingClientRect();
              if ([...range.getClientRects()].some((line) => crosses(new DOMRect(lineWidth.left, line.top, lineWidth.width, line.height)))) hits.push(`${Math.round(scrollY)}:text:${node.textContent.trim().slice(0, 25)}`);
            }
          }
          if (target === bottom + 150) break;
        }
        return hits;
      });
    expect(intersections).toEqual([]);
  } finally { await page.close(); }
}, 20000);

test("[integration] #135 house lights remain visible and clickable at phone and desktop widths", async () => {
  for (const [width, height] of VIEWPORTS) {
    const page = await pageAt(width, height);
    try {
      const lights = page.locator("#lights");
      expect(await lights.isVisible()).toBe(true);
      await lights.click({ timeout: 2000 });
      expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    } finally { await page.close(); }
  }
}, 10000);

test("[integration] #137 no show picker or ticket button; every card opens its show, evidence or idea directly", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
    const shows = POSTERS.posters.filter((poster) => poster.stage === "show");
    const firstShow = shows[0];
    if (!firstShow) throw new Error("posters.json contains no show");
    expect(await page.locator("#tkShow").count()).toBe(0);
    expect(await page.locator("#tkPosters .tk-poster").first().getAttribute("data-id")).toBe(firstShow.id);
    for (const poster of POSTERS.posters) {
      const card = page.locator(`.tk-poster[data-id="${poster.id}"]`);
      expect(await card.count()).toBe(1);
      expect(await card.locator(".tk-pick").count()).toBe(0);
      expect(await card.getByRole("link", { name: poster.watch ? /Watch now/ : poster.run ? /Open the evidence/ : /Read the idea/ }).count()).toBe(1);
    }
  } finally { await page.close(); }
}, 10000);
