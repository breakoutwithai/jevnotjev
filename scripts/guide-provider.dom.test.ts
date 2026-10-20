// /guide/ provider request dialog in a real browser against the real server handler and a throwaway SQLite store:
// open, focus trap, Escape, labelled fields at 390px, and a submit that is stored and confirmed with a reference.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHandler } from "../src/backstage/server.ts";
import { PROVIDER_REQUEST_PREFIX } from "../src/guest-intake/contract.ts";
import { QuestionStore } from "../src/guest-intake/store.ts";
import { resolveChromium } from "./uat/happy-path-lib.ts";

const SITE = join(import.meta.dir, "..", "site");
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let handler: ReturnType<typeof createHandler>;
let storePath = "";
let clientSeq = 0;

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  storePath = join(mkdtempSync(join(tmpdir(), "guide-provider-")), "tickets.sqlite");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      clientSeq += 1;
      return handler(request, { remoteAddress: `198.51.100.${(clientSeq % 250) + 1}` });
    },
  });
  handler = createHandler({ version: "test", origin: server.url.origin, staticRoot: SITE, tickets: { path: storePath }, log: () => {}, questions: { limiterCapacity: 10_000, limits: {} } });
  browser = await chromium.launch({ executablePath: found.path });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  handler?.close();
});

async function open(width: number, height: number, hash = ""): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${server.url.origin}/guide/${hash}`);
  return page;
}

const overflow = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
const activeId = (page: Page): Promise<string> => page.evaluate(() => document.activeElement?.id ?? "");

describe("guide provider request dialog (browser)", () => {
  test("[integration] GPR-B1 the CTA opens the dialog, focus stays inside, Escape closes it and focus returns, at 390 and 1440", async () => {
    for (const [w, h] of VIEWPORTS) {
      const page = await open(w, h);
      expect(await page.locator("#providers-title").textContent()).toBe("What works today and what is next");
      await page.locator("#providerAsk").click();
      expect(await page.locator("#providerDialog").isVisible()).toBe(true);
      expect(await activeId(page)).toBe("providerWant");
      expect(await page.getByLabel("Provider or model you want").count()).toBe(1);
      expect(await page.getByLabel("What do you use it for?").count()).toBe(1);
      expect(await page.getByLabel("Contact email (optional)").count()).toBe(1);
      // Focus stays inside after every Tab and every Shift+Tab, and both boundaries wrap.
      const inside = (): Promise<boolean> => page.evaluate(() => {
        const d = document.getElementById("providerDialog");
        return d !== null && d.contains(document.activeElement);
      });
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) { await page.keyboard.press("Tab"); expect(await inside()).toBe(true); seen.add(await activeId(page)); }
      for (let i = 0; i < 12; i++) { await page.keyboard.press("Shift+Tab"); expect(await inside()).toBe(true); }
      expect(seen.has("providerWant")).toBe(true);
      await page.locator("#providerSend").focus();
      await page.keyboard.press("Tab");
      expect(await activeId(page)).toBe("providerClose");
      await page.keyboard.press("Shift+Tab");
      expect(await activeId(page)).toBe("providerSend");
      await page.locator("#providerWant").focus();
      await page.keyboard.press("Shift+Tab");
      expect(await activeId(page)).toBe("providerClose");
      await page.keyboard.press("Escape");
      expect(await page.locator("#providerDialog").isVisible()).toBe(false);
      expect(await activeId(page)).toBe("providerAsk");
      expect(await overflow(page)).toBe(false);
      await page.close();
    }
  }, 60_000);

  test("[integration] GPR-B2 at 390px a Grok request with no email, consent and send by keyboard, is stored and confirmed with a reference", async () => {
    const page = await open(390, 844);
    await page.locator("#providerAsk").click();
    expect(await overflow(page)).toBe(false);
    const box = await page.locator("#providerDialog").boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    // Sending empty shows the errors, makes no request and stores nothing.
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/questions")) posts.push(r.url()); });
    const store0 = new QuestionStore(storePath);
    const before = store0.counts().questions;
    store0.close();
    await page.locator("#providerSend").click();
    expect(await page.locator("#providerWantErr").isVisible()).toBe(true);
    expect(await page.locator("#providerUseErr").isVisible()).toBe(true);
    expect(await page.locator("#providerConsentErr").isVisible()).toBe(true);
    expect(posts.length).toBe(0);
    const store1 = new QuestionStore(storePath);
    expect(store1.counts().questions).toBe(before);
    store1.close();
    await page.locator("#providerWant").selectOption({ label: "xAI (Grok)" });
    await page.locator("#providerUse").focus();
    await page.keyboard.type("Map my Grok CLI usage next to Claude Code in TokenMax.");
    await page.locator("#providerConsent").focus();
    await page.keyboard.press("Space");
    expect(await page.locator("#providerConsent").isChecked()).toBe(true);
    await page.locator("#providerSend").focus();
    await page.keyboard.press("Enter");
    await page.locator("#providerReceipt").waitFor({ state: "visible" });
    const ref = (await page.locator("#providerRef").textContent()) ?? "";
    const code = (await page.locator("#providerCode").textContent()) ?? "";
    expect(ref).toMatch(/^Q-[0-9A-F]{12}$/);
    expect(code.startsWith(`${ref}.`)).toBe(true);
    expect(await page.locator("#providerReceipt a[href='/ask/#status']").count()).toBe(1);
    expect(await overflow(page)).toBe(false);
    const store = new QuestionStore(storePath);
    const row = store.show(ref);
    store.close();
    expect(row?.email).toBeNull();
    expect(row?.state).toBe("pending_review");
    expect(row?.question).toBe(`${PROVIDER_REQUEST_PREFIX}Wanted: xAI (Grok)\nUse: Map my Grok CLI usage next to Claude Code in TokenMax.`);
    await page.close();
  }, 30_000);

  test("[integration] GPR-B4 an over-long request says so and stores nothing; an unreadable success keeps the key so a resend does not duplicate", async () => {
    const page = await open(1440, 900, "#ask-provider");
    const count = (): number => { const s = new QuestionStore(storePath); const n = s.counts().questions; s.close(); return n; };
    const before = count();
    await page.locator("#providerWant").selectOption({ label: "xAI (Grok)" });
    await page.locator("#providerUse").fill("x".repeat(4096));
    await page.locator("#providerConsent").check();
    await page.locator("#providerSend").click();
    expect(await page.locator("#providerErr").textContent()).toContain("too long");
    expect(await page.locator("#providerUseErr").isVisible()).toBe(false);
    expect(count()).toBe(before);
    await page.locator("#providerUse").fill("Unreadable reply probe.");
    const keys: string[] = [];
    let first = true;
    await page.route("**/api/questions", async (route) => {
      const sent: unknown = JSON.parse(route.request().postData() ?? "{}");
      keys.push(typeof sent === "object" && sent !== null && "request_key" in sent && typeof sent.request_key === "string" ? sent.request_key : "");
      if (first) { first = false; const real = await route.fetch(); await route.fulfill({ response: real, body: "{" }); return; }
      await route.continue();
    });
    await page.locator("#providerSend").click();
    await page.locator("#providerErr").waitFor({ state: "visible" });
    expect(await page.locator("#providerErr").textContent()).toContain("could not confirm");
    await page.locator("#providerSend").click();
    await page.locator("#providerReceipt").waitFor({ state: "visible" });
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1] ?? "");
    expect(count()).toBe(before + 1);
    await page.close();
  }, 30_000);

  test("[integration] GPR-B5 the client applies the server's NFC and control rules, and a 200 without a valid reference is not shown as received", async () => {
    const page = await open(1440, 900, "#ask-provider");
    await page.locator("#providerWant").selectOption({ label: "Google (Gemini)" });
    await page.locator("#providerConsent").check();
    await page.locator("#providerUse").fill("hello\u001bworld");
    await page.locator("#providerSend").click();
    expect(await page.locator("#providerErr").textContent()).toContain("characters we cannot store");
    // 2,100 decomposed e-acute: over the limit as raw code points, under it after NFC, so the server accepts it.
    const decomposed = "é".repeat(2100);
    await page.locator("#providerUse").fill(decomposed);
    let fake = true;
    await page.route("**/api/questions", async (route) => {
      if (fake) { fake = false; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "", status_code: "" }) }); return; }
      await route.continue();
    });
    await page.locator("#providerSend").click();
    await page.locator("#providerErr").waitFor({ state: "visible" });
    expect(await page.locator("#providerErr").textContent()).toContain("could not confirm");
    expect(await page.locator("#providerReceipt").isVisible()).toBe(false);
    await page.locator("#providerSend").click();
    await page.locator("#providerReceipt").waitFor({ state: "visible" });
    const ref = (await page.locator("#providerRef").textContent()) ?? "";
    const store = new QuestionStore(storePath);
    expect(store.show(ref)?.question).toBe(`${PROVIDER_REQUEST_PREFIX}Wanted: Google (Gemini)\nUse: ${"é".repeat(2100)}`);
    store.close();
    await page.close();
  }, 30_000);

  test("[integration] GPR-B3 Other needs a name, an email is kept, and /guide/#ask-provider opens the dialog directly", async () => {
    const page = await open(1440, 900, "#ask-provider");
    expect(await page.locator("#providerDialog").isVisible()).toBe(true);
    await page.locator("#providerWant").selectOption({ label: "Other" });
    expect(await page.locator("#providerOther").isVisible()).toBe(true);
    await page.locator("#providerUse").fill("Compare local models.");
    await page.locator("#providerConsent").check();
    await page.locator("#providerSend").click();
    expect(await page.locator("#providerOtherErr").isVisible()).toBe(true);
    await page.locator("#providerOther").fill("Mistral");
    await page.locator("#providerEmail").fill("Tester@Example.test");
    await page.locator("#providerSend").click();
    await page.locator("#providerReceipt").waitFor({ state: "visible" });
    const ref = (await page.locator("#providerRef").textContent()) ?? "";
    const store = new QuestionStore(storePath);
    const row = store.show(ref);
    store.close();
    expect(row?.email).toBe("tester@example.test");
    expect(row?.question).toBe(`${PROVIDER_REQUEST_PREFIX}Wanted: Other: Mistral\nUse: Compare local models.`);
    await page.close();
  }, 30_000);
});
