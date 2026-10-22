// Guide page: the "see it in pictures" link must not loop back to the landing page, and no tap target is under 24 px at phone width.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = resolve(process.env.LANDING_TEST_SITE ?? join(import.meta.dir, "..", "site"));
const MIN = 24;

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
  server?.stop(true);
});

const MIN_MEASURED = 30;

test("[integration] guide: the pictures link resolves to Little Shop, not the landing page", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/guide/`, { waitUntil: "load" });
    expect(response?.ok()).toBe(true);
    const links = page.getByRole("link", { name: "New to Jev? See it in pictures first." });
    expect(await links.count()).toBe(1);
    expect(await links.first().isVisible()).toBe(true);
    const target = new URL(await links.first().evaluate((el) => (el instanceof HTMLAnchorElement ? el.href : "")));
    expect(target.pathname).toBe("/little-shop/");
    expect(target.hash).toBe("");
    const shop = await page.request.get(target.href);
    expect(shop.ok()).toBe(true);
  } finally {
    await page.close();
  }
});

test("[integration] guide at 390x844: every interactive element is at least 24x24 CSS px", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    const response = await page.goto(`http://127.0.0.1:${server.port}/guide/`, { waitUntil: "load" });
    expect(response?.ok()).toBe(true);
    expect(await page.getByRole("heading", { level: 1 }).first().isVisible()).toBe(true);
    const result = await page.evaluate((min) => {
      const small: string[] = [];
      let measured = 0;
      for (const el of document.querySelectorAll("a[href], button, input, select, textarea, summary, [role=button]")) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        measured++;
        if (box.width < min || box.height < min) small.push(`${el.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)} ${(el.textContent ?? "").trim().slice(0, 30)}`);
      }
      return { small, measured };
    }, MIN);
    expect(result.measured).toBeGreaterThanOrEqual(MIN_MEASURED);
    expect(result.small).toEqual([]);
  } finally {
    await page.close();
  }
});
