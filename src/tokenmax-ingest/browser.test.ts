import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { resolveChromium } from "../../scripts/uat/happy-path-lib.ts";
import { ingestDraft } from "./ingest.ts";
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let posts = 0;
beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/tokenmax/preview") { posts++; const r = ingestDraft(await request.text()); return Response.json(r); }
    if (path === "/collect/" || path === "/collect/collect.js") return new Response(Bun.file(join(import.meta.dir, "../../site/collect", path.endsWith(".js") ? "collect.js" : "index.html")));
    return new Response("Not found", { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: found.path, headless: true });
});
afterAll(async () => { await browser?.close(); server?.stop(true); });
test("[integration] TM-UI1 mobile editing, rejection recovery, samples and explicit platform submission", async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${server.url}collect/`);
  await page.locator("#instructions").waitFor();
  expect(await page.locator("#instructions").inputValue()).toContain("ZERO Jev calls");
  await page.locator("#provider").selectOption("codex"); await page.locator("#mode").selectOption("jev");
  expect(await page.locator("#instructions").inputValue()).toContain("NOT RUN/unavailable");
  expect(await page.locator("#instructions").inputValue()).toContain("Codex");
  for (const name of ["Busy developer", "Part-time builder", "Simple chat"]) {
    await page.getByRole("button", { name: `${name} (synthetic)`, exact: true }).click();
    await page.locator("#validate").click();
    await page.waitForFunction(() => document.getElementById("preview")?.textContent?.includes("SYNTHETIC SAMPLE"));
  }
  expect(posts).toBe(0);
  await page.locator("#draft").fill(JSON.stringify({privatePath:["", "Users", "SecretCanary"].join("/")}));
  await page.locator("#validate").click();
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("Needs correction"));
  expect(await page.locator("#draft").inputValue()).toContain("SecretCanary");
  expect(posts).toBe(0);
  if (process.env.TOKENMAX_CAPTURE) { const dir = join(import.meta.dir, "../../docs/product/runs/tokenmax-collection/screenshots"); mkdirSync(dir, { recursive: true }); await page.screenshot({ path: join(dir, "mobile-rejection.png"), fullPage: true }); }
  await page.getByRole("button", { name: "Busy developer (synthetic)", exact: true }).click();
  await page.locator("#validate").click();
  await page.waitForFunction(() => document.getElementById("preview")?.textContent?.includes("SYNTHETIC SAMPLE"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.getByRole("button", { name: "Join leaderboard · pending integration", exact: true }).isDisabled()).toBe(true);
  if (process.env.TOKENMAX_CAPTURE) { const dir = join(import.meta.dir, "../../docs/product/runs/tokenmax-collection/screenshots"); await page.screenshot({ path: join(dir, "mobile-preview.png"), fullPage: true }); }
  await page.locator("#platform").click();
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.includes("Platform received"));
  expect(posts).toBe(1);
  await page.close();
}, 30000);
