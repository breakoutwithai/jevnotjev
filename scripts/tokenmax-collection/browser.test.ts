import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { resolveChromium } from "../uat/happy-path-lib.ts";
import { createHandler } from "../../src/backstage/server.ts";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let handler: ReturnType<typeof createHandler>;
beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  const bundle = await Bun.build({ entrypoints: [join(import.meta.dir, "../../src/tokenmax-ingest/main.ts")], target: "browser" });
  if (!bundle.success || !bundle.outputs[0]) throw new Error("Collection browser build failed");
  const js = await bundle.outputs[0].text();
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    const path = new URL(request.url).pathname;
    if (path === "/collect/collect.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
    if (path === "/collect/") return new Response(Bun.file(join(import.meta.dir, "../../site/collect/index.html")));
    return handler(request);
  } });
  handler = createHandler({ version: "test", origin: `http://127.0.0.1:${server.port}` });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); handler?.close(); server?.stop(); });
test("[integration] TM-B1 mobile and desktop retain rejected draft and recover through the same sample path", async () => {
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests: string[] = [];
    page.on("request", req => { if (req.url().includes("/api/")) requests.push(req.url()); });
    try {
      await page.goto(`http://127.0.0.1:${server.port}/collect/`);
      await page.locator("#samples button").first().waitFor();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.selectOption("#provider", "codex");
      await page.selectOption("#mode", "jev");
      expect(await page.locator("#instructions").inputValue()).toContain("NOT RUN");
      const bad = '{"private":"SecretCanary@example.test"}';
      await page.locator("#draft").fill(bad);
      await page.locator("#validate").click();
      await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("Needs correction"));
      expect(await page.locator("#draft").inputValue()).toBe(bad);
      for (let index = 0; index < 3; index++) {
        await page.locator("#samples button").nth(index).click();
        await page.locator("#validate").click();
        await page.waitForFunction(() => document.getElementById("preview")?.textContent?.includes("SYNTHETIC"));
        expect(await page.locator("#preview").innerText()).toContain("excluded from rankings");
      }
      expect(requests).toHaveLength(0);
      if (process.env.TOKENMAX_CAPTURE === "1") {
        const dir = join(import.meta.dir, "../../docs/product/runs/tokenmax-collection/screenshots");
        mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: join(dir, `collection-${width}.png`), fullPage: true });
      }
    } finally { await page.close(); }
  }
}, 20000);
