import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/backstage/" && pathname !== "/backstage/backstage.css") return new Response("Not found", { status: 404 });
    const path = join(SITE, pathname === "/backstage/" ? "backstage/index.html" : pathname.slice(1));
    return new Response(Bun.file(path));
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });

test("[integration] W5 question field fits above the fold at 1280x900 and 390x844", async () => {
  const viewports: readonly [number, number][] = [[1280, 900], [390, 844]];
  for (const [width, height] of viewports) {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.goto(`http://127.0.0.1:${server.port}/backstage/`);
      const firstHeading = await page.locator("main :is(h1,h2,h3):visible").first().innerText();
      expect(firstHeading).toBe("What do you want to decide?");
      const box = await page.locator("#question").boundingBox();
      expect(box).not.toBeNull();
      expect(box?.y ?? Infinity).toBeGreaterThanOrEqual(0);
      expect((box?.y ?? Infinity) + (box?.height ?? Infinity)).toBeLessThanOrEqual(height);
      const detected = await page.locator("#question").evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit === node;
      });
      expect(detected).toBe(true);
      await page.addStyleTag({ content: "#question { margin-top: 1000px !important; }" });
      const shifted = await page.locator("#question").boundingBox();
      expect((shifted?.y ?? 0) + (shifted?.height ?? 0)).toBeGreaterThan(height);
    } finally {
      await page.close();
    }
  }
});
