import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "../uat/happy-path-lib.ts";
import type { Poster } from "../../src/shows/posters.ts";

const SITE = join(import.meta.dir, "..", "..", "site");
const POSTERS: { posters: Poster[] } = JSON.parse(readFileSync(join(SITE, "shows", "posters.json"), "utf8"));
const CAPTURE = process.env.UAT_SCREENSHOT_DIR;
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
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

test("[integration] #136 a ticket-office link is visible and clickable on the first screen in all four viewport and motion states", async () => {
  for (const [width, height] of VIEWPORTS) {
    for (const motion of ["no-preference", "reduce"] as const) {
      const page = await pageAt(width, height, motion);
      try {
        const links = page.locator('a[href="#tickets"]');
        const visible = await links.evaluateAll((nodes) => nodes.some((node) => {
          const box = node.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          return box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight &&
            getComputedStyle(node).visibility === "visible" && getComputedStyle(node).opacity !== "0" &&
            (() => { const hit = document.elementFromPoint(x, y); return hit === node || (hit !== null && node.contains(hit)); })();
        }));
        expect(visible).toBe(true);
        if (CAPTURE && motion === "no-preference") {
          mkdirSync(CAPTURE, { recursive: true });
          await page.screenshot({ path: join(CAPTURE, `first-${width}.png`) });
        }
        const jump = page.locator(motion === "reduce" ? ".first-screen-jump" : ".overture-jump");
        await jump.click({ timeout: 2000 });
        expect(new URL(page.url()).hash).toBe("#tickets");
        if (CAPTURE && motion === "no-preference") {
          await page.evaluate(() => {
            document.documentElement.style.scrollBehavior = "auto";
            document.getElementById("tickets")?.scrollIntoView();
          });
          await page.screenshot({ path: join(CAPTURE, `office-${width}.png`) });
        }
      } finally { await page.close(); }
    }
  }
}, 20000);

test("[integration] #136 the first screen explains a fixed-answer decision and says Jev does not write text", async () => {
  for (const [width, height] of VIEWPORTS) {
    for (const motion of ["no-preference", "reduce"] as const) {
      const page = await pageAt(width, height, motion);
      try {
        const text = await page.evaluate(() => {
          const region = document.documentElement.classList.contains("motion") ? document.querySelector(".playbill") : document.querySelector("#act1");
          if (!region) return "";
          return [...region.querySelectorAll("p")].filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.top >= 0 && box.bottom <= innerHeight && getComputedStyle(node).visibility === "visible";
          }).map((node) => node.textContent ?? "").join(" ");
        });
        expect(text).toMatch(/fixed (?:answers|list)|pick(?:s)? one answer/i);
        expect(text).toMatch(/does not write text/i);
      } finally { await page.close(); }
    }
  }
}, 20000);

test("[integration] #135 the sample badge intersects no office control or text line at top, middle or bottom scroll", async () => {
  const page = await pageAt(390, 844);
  try {
    for (const fraction of [0, 0.5, 1]) {
      const intersections = await page.evaluate((position) => {
        document.documentElement.style.scrollBehavior = "auto";
        const office = document.getElementById("tickets");
        const badge = document.getElementById("sampleBadge");
        if (!office || !badge) return ["missing office or badge"];
        const top = office.offsetTop + (office.offsetHeight - innerHeight) * position;
        scrollTo(0, top);
        const b = badge.getBoundingClientRect();
        const crosses = (r: DOMRect) => r.width > 0 && r.height > 0 && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top;
        const hits: string[] = [];
        for (const element of office.querySelectorAll("a, button, input, select, textarea, label")) {
          if (getComputedStyle(element).display !== "none" && crosses(element.getBoundingClientRect())) hits.push(element.tagName + ":" + (element.textContent ?? "").trim().slice(0, 25));
        }
        const walker = document.createTreeWalker(office, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.trim() || !node.parentElement || getComputedStyle(node.parentElement).display === "none") continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if ([...range.getClientRects()].some(crosses)) hits.push("text:" + node.textContent.trim().slice(0, 25));
        }
        return hits;
      }, fraction);
      expect(intersections).toEqual([]);
    }
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

test("[unit] #137 picker options equal show posters and other stages have no ticket button", async () => {
  const page = await pageAt(390, 844, "reduce");
  try {
    await page.waitForFunction(() => document.querySelectorAll("#tkPosters .tk-poster").length > 0);
    const shows = POSTERS.posters.filter((poster) => poster.stage === "show");
    const firstShow = shows[0];
    if (!firstShow) throw new Error("posters.json contains no show");
    const options = await page.locator("#tkShow option").evaluateAll((nodes) => nodes.slice(1).map((node) => node.getAttribute("value")));
    expect(options).toEqual(shows.map((poster) => poster.id));
    expect(await page.locator("#tkPosters .tk-poster").first().getAttribute("data-id")).toBe(firstShow.id);
    for (const poster of POSTERS.posters.filter((item) => item.stage !== "show")) {
      const card = page.locator(`.tk-poster[data-id="${poster.id}"]`);
      expect(await card.count()).toBe(1);
      expect(await card.locator(".tk-pick").count()).toBe(0);
      expect(await card.getByRole("link", { name: poster.stage === "rehearsal" ? /Follow this/ : /Read the idea/ }).count()).toBe(1);
    }
  } finally { await page.close(); }
}, 10000);
