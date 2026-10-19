import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const site = join(import.meta.dir, "..", "site");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw Error(found.error);
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/tickets/ranking") return Response.json({ ids: [], counts: {} });
    const file = Bun.file(join(site, path.endsWith("/") ? `${path}index.html` : path));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  } });
  browser = await chromium.launch({ headless: true, executablePath: found.path });
});
afterAll(async () => { await browser?.close(); server?.stop(); });
async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
  await page.locator("#tkBring").click();
  return page;
}

test("[integration] #138 ready prompt and playground link appear before email entry", async () => {
  const page = await open();
  try {
    expect(await page.locator("#tkEmail").inputValue()).toBe("");
    expect(await page.locator("#tkReadyPrompt").isVisible()).toBe(true);
    expect(await page.locator("a#tkPlayground[href='https://console.typesafe.ai/playground']").isVisible()).toBe(true);
    expect(await page.locator("#tkPlayground").evaluate((node) => { const r = node.getBoundingClientRect(); return r.top >= 0 && r.top < innerHeight; })).toBe(true);
    const prompt = await page.locator("#tkReadyPrompt").innerText();
    expect(prompt).toContain("made-up or redacted");
    expect(prompt).not.toMatch(/(?:sk-|jng_|jnj_)[A-Za-z0-9_-]{12,}/);
  } finally { await page.close(); }
});

test("[integration] #138 both entry buttons keep the focused field and the playground link on screen at 390x844 and 1440x900", async () => {
  for (const [width, height] of [[390, 844], [1440, 900]] as const) {
    for (const [button, field] of [["#tkBring", "tkIdea"], ["#officeOpen", "tkEmail"]] as const) {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      try {
        await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
        await page.locator(button).click();
        const seen = await page.evaluate((id) => {
          const inView = (node: Element | null) => { if (node === null) return false; const r = node.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; };
          return { focus: document.activeElement?.id, field: inView(document.getElementById(id)), link: inView(document.getElementById("tkPlayground")) };
        }, field);
        expect({ width, button, ...seen }).toEqual({ width, button, focus: field, field: true, link: true });
      } finally { await page.close(); }
    }
  }
}, 20000);

test("[integration] #138 unchecked consent rejects without a request", async () => {
  const page = await open();
  try {
    let posts = 0;
    await page.route("**/api/tickets", (route) => { posts++; return route.fulfill({ status: 200, json: { ticket: "JNJ-TEST" } }); });
    await page.locator("#tkEmail").fill("guest@example.com");
    await page.locator("#tkForm .tk-submit").click();
    expect(posts).toBe(0);
    expect(await page.locator("#tkConsentErr").isVisible()).toBe(true);
  } finally { await page.close(); }
});

test("[integration] #138 consented request posts once and confirms storage and deletion", async () => {
  const page = await open();
  try {
    const requests: unknown[] = [];
    await page.route("**/api/tickets", (route) => { requests.push(route.request().postDataJSON()); return route.fulfill({ status: 200, json: { ticket: "JNJ-TEST", kind: "backstage" } }); });
    await page.locator("#tkEmail").fill("guest@example.com");
    await page.locator("#tkConsent").check();
    await page.locator("#tkForm .tk-submit").click();
    await page.locator("#tkIssued").waitFor({ state: "visible" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ email: "guest@example.com", consent: true, kind: "backstage" });
    const confirmation = await page.locator("#tkIssued").innerText();
    expect(confirmation).toContain("email");
    expect(confirmation).toContain("website");
    expect(confirmation).toContain("decision");
    expect(confirmation).toContain("delete");
  } finally { await page.close(); }
});
