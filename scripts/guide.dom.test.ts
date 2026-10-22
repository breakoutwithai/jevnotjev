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

test("[unit] guide: the pictures link does not point at the landing page", () => {
  const html = readFileSync(join(SITE, "guide", "index.html"), "utf8");
  const match = /<p><a href="([^"]*)">New to Jev\? See it in pictures first\.<\/a><\/p>/.exec(html);
  if (!match) throw new Error("pictures link not found");
  const href = match[1] ?? "";
  expect(href).not.toBe("/");
  expect(href).not.toBe("../");
  expect(href).not.toContain("#types");
  expect(href).toBe("/little-shop/");
  expect(existsSync(join(SITE, "little-shop", "index.html"))).toBe(true);
});

test("[integration] guide at 390x844: every interactive element is at least 24x24 CSS px", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/guide/`, { waitUntil: "load" });
    const small = await page.evaluate((min) => {
      const found: string[] = [];
      for (const el of document.querySelectorAll("a[href], button, input, select, textarea, summary, [role=button]")) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.width < min || box.height < min) found.push(`${el.tagName.toLowerCase()} ${Math.round(box.width)}x${Math.round(box.height)} ${(el.textContent ?? "").trim().slice(0, 30)}`);
      }
      return found;
    }, MIN);
    expect(small).toEqual([]);
  } finally {
    await page.close();
  }
});
