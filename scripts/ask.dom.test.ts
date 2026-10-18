import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createHandler } from "../src/backstage/server.ts";
import { QuestionStore } from "../src/guest-intake/store.ts";
import { resolveChromium } from "./uat/happy-path-lib.ts";
import { parseArgs } from "../site/tm/map.ts";

const SITE = join(import.meta.dir, "..", "site");
const VIEWPORTS: [number, number][] = [[390, 844], [1440, 900]];
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let handler: ReturnType<typeof createHandler>;
let storePath = "";
let failNext = 0;
let conflictNext = 0;
const sentKeys: string[] = [];

beforeAll(async () => {
  const found = resolveChromium(null, process.env.UAT_CHROMIUM_PATH, chromium.executablePath(), existsSync);
  if ("error" in found) throw new Error(found.error);
  storePath = join(mkdtempSync(join(tmpdir(), "ask-dom-")), "tickets.sqlite");
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, srv) {
      if (new URL(request.url).pathname === "/api/questions") {
        const sent: unknown = await request.clone().json().catch(() => null);
        const key = typeof sent === "object" && sent !== null && "request_key" in sent && typeof sent.request_key === "string" ? sent.request_key : "";
        sentKeys.push(key);
      }
      if (failNext > 0 && new URL(request.url).pathname === "/api/questions") {
        failNext -= 1;
        return Response.json({ code: "store-error" }, { status: 503 });
      }
      if (conflictNext > 0 && new URL(request.url).pathname === "/api/questions") {
        conflictNext -= 1;
        return Response.json({ code: "request-key-reused" }, { status: 409 });
      }
      return handler(request, { remoteAddress: srv.requestIP(request)?.address ?? "127.0.0.1" });
    },
  });
  handler = createHandler({ version: "test", origin: server.url.origin, staticRoot: SITE, tickets: { path: storePath }, log: () => {}, questions: { limiterCapacity: 10_000, limits: {} } });
  browser = await chromium.launch({ executablePath: found.path });
});

afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  handler?.close();
});

async function open(width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${server.url.origin}/ask/`);
  return page;
}

const overflow = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

describe("ask page", () => {
  test("[integration] GI-1 keyboard-only submit shows the reference and a copyable status code at 390 and 1440", async () => {
    for (const [w, h] of VIEWPORTS) {
      const page = await open(w, h);
      expect(await page.getByLabel("What decision are you trying to make?").count()).toBe(1);
      expect(await page.getByLabel("Your email").count()).toBe(1);
      expect(await page.locator("#askReply").isChecked()).toBe(false);
      expect(await page.locator("#askMarketing").isChecked()).toBe(false);
      await page.getByLabel("What decision are you trying to make?").focus();
      await page.keyboard.type(`Route shop questions at ${w}px? Cases are fictional.`);
      await page.keyboard.press("Tab");
      await page.keyboard.type("seeded-dom@example.test");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Space");
      await page.locator("#askSubmit").focus();
      await page.keyboard.press("Enter");
      await page.locator("#askReceipt").waitFor({ state: "visible" });
      const code = (await page.locator("#askCode").textContent()) ?? "";
      expect(code).toMatch(/^Q-[0-9A-F]{12}\.[A-Za-z0-9_-]{43}$/);
      expect(await page.locator("#askCopy").isVisible()).toBe(true);
      expect(await page.locator("#askReceipt").innerText()).toContain("pending review");
      expect(await page.locator("#askReceipt").innerText()).not.toContain("seeded-dom@example.test");
      expect(await overflow(page)).toBe(false);
      await page.close();
    }
  }, 60_000);

  test("[integration] GI-2 missing consent and a bad email show field errors and send nothing", async () => {
    const page = await open(390, 844);
    const before = new QuestionStore(storePath).counts().questions;
    await page.getByLabel("What decision are you trying to make?").fill("A question");
    await page.getByLabel("Your email").fill("not-an-email");
    await page.locator("#askSubmit").click();
    expect(await page.locator("#askEmailErr").isVisible()).toBe(true);
    expect(await page.locator("#askReplyErr").isVisible()).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("askEmail");
    expect(new QuestionStore(storePath).counts().questions).toBe(before);
    await page.close();
  }, 30_000);

  test("[integration] GI-6 a temporary failure keeps the typed draft, and the retry returns one receipt", async () => {
    const page = await open(1440, 900);
    const before = new QuestionStore(storePath).counts().questions;
    await page.getByLabel("What decision are you trying to make?").fill("Draft that must survive a failure");
    await page.getByLabel("Your email").fill("seeded-draft@example.test");
    await page.locator("#askReply").check();
    failNext = 1;
    await page.locator("#askSubmit").click();
    await page.locator("#askFormErr").waitFor({ state: "visible" });
    expect(await page.locator("#askQuestion").inputValue()).toBe("Draft that must survive a failure");
    expect(await page.locator("#askEmail").inputValue()).toBe("seeded-draft@example.test");
    expect(await page.locator("#askReceipt").isVisible()).toBe(false);
    await page.locator("#askSubmit").click();
    await page.locator("#askReceipt").waitFor({ state: "visible" });
    expect(new QuestionStore(storePath).counts().questions).toBe(before + 1);
    await page.close();
  }, 30_000);

  test("[integration] GI-4b after request-key-reused, sending again uses a fresh attempt and stores one row", async () => {
    const page = await open(390, 844);
    const before = new QuestionStore(storePath).counts().questions;
    await page.getByLabel("What decision are you trying to make?").fill("Draft whose first attempt is refused");
    await page.getByLabel("Your email").fill("seeded-conflict@example.test");
    await page.locator("#askReply").check();
    conflictNext = 1;
    const from = sentKeys.length;
    await page.locator("#askSubmit").click();
    await page.locator("#askFormErr").waitFor({ state: "visible" });
    expect(await page.locator("#askFormErr").innerText()).toContain("send again");
    expect(await page.locator("#askQuestion").inputValue()).toBe("Draft whose first attempt is refused");
    await page.locator("#askSubmit").click();
    await page.locator("#askReceipt").waitFor({ state: "visible" });
    const keys = sentKeys.slice(from);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(new QuestionStore(storePath).counts().questions).toBe(before + 1);
    await page.close();
  }, 30_000);

  test("[integration] GI-11 a reviewed reply containing markup is shown as text on the status view", async () => {
    const page = await open(390, 844);
    await page.getByLabel("What decision are you trying to make?").fill("Status view check");
    await page.getByLabel("Your email").fill("seeded-status@example.test");
    await page.locator("#askReply").check();
    await page.locator("#askSubmit").click();
    await page.locator("#askReceipt").waitFor({ state: "visible" });
    const code = (await page.locator("#askCode").textContent()) ?? "";
    const id = code.split(".")[0] ?? "";
    const store = new QuestionStore(storePath);
    store.transition(id, "approved", 1, "operator", Date.now());
    const hostile = '<img src=x onerror="window.__owned=1"> Try two fixed choices.';
    store.answer(id, 2, "operator", Date.now(), hostile, "human_reviewed");
    await page.goto(`${server.url.origin}/ask/#status`);
    await page.getByLabel("Your status code").fill(code);
    await page.locator("#statusCheck").click();
    await page.locator("#statusResult").waitFor({ state: "visible" });
    expect(await page.locator("#statusState").innerText()).toContain("answered");
    expect(await page.locator("#statusResponse").innerText()).toBe(hostile);
    expect(await page.locator("#statusResult img").count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, "__owned"))).toBeUndefined();
    expect(await page.locator("#statusResult").innerText()).toContain("reviewed by a person");
    expect(await overflow(page)).toBe(false);
    await page.close();
  }, 30_000);
});

describe("optional usage map", () => {
  /** The prompt exactly as the page shows it, with the HTML entities decoded. */
  function usagePrompt(): string {
    const html = readFileSync(join(SITE, "ask", "index.html"), "utf8");
    const raw = /<pre id="usagePrompt">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? "";
    return raw.replace(/<\/?span[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  test("[unit] S4 every flag the usage prompt names is one site/tm/map.ts accepts, with chosen folders and period, and none shares", () => {
    const prompt = usagePrompt();
    expect(prompt.length).toBeGreaterThan(200);
    const named = [...new Set([...prompt.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]))].sort();
    expect(named).toEqual(["--claude", "--codex", "--days", "--from", "--out", "--to"]);
    expect(prompt).toContain("https://jevnotjev.breakoutwithai.com/tm/map.ts");
    const dir = mkdtempSync(join(tmpdir(), "usage-prompt-"));
    const claude = join(dir, "claude");
    mkdirSync(claude);
    const env = { home: dir, now: Date.parse("2026-10-18T12:00:00Z"), cwd: dir };
    const byDays = parseArgs(["--claude", claude, "--codex", "none", "--days", "7", "--out", join(dir, "a")], env);
    expect([byDays.claude, byDays.codex, byDays.days, byDays.share]).toEqual([claude, null, 7, false]);
    const byDates = parseArgs(["--claude", "none", "--codex", claude, "--from", "2026-10-01", "--to", "2026-10-07", "--out", join(dir, "b")], env);
    expect([byDates.claude, byDates.codex, byDates.days, byDates.share]).toEqual([null, claude, 7, false]);
    expect(() => parseArgs(["--help"], env)).toThrow("unknown option");
  });

  test("[integration] S4 the usage section is optional and separate: the full prompt shows before copy, copying sends nothing, and it has no form", async () => {
    for (const [w, h] of VIEWPORTS) {
      const page = await open(w, h);
      const sent: string[] = [];
      page.on("request", (r) => { if (r.method() !== "GET") sent.push(r.url()); });
      expect(await page.locator("#usagePrompt").isVisible()).toBe(true);
      expect((await page.locator("#usagePrompt").innerText()).trim()).toBe(usagePrompt().trim());
      expect(await page.locator("#usage form, #usage input, #usage textarea").count()).toBe(0);
      expect(await page.locator("#usage a[href=\"/maps/\"]").count()).toBe(1);
      expect(await page.locator("#usage a[href=\"/tm/\"]").count()).toBe(1);
      await page.locator("#usageCopy").focus();
      await page.keyboard.press("Enter");
      await page.locator("#usageCopied").filter({ hasText: /\S/ }).waitFor();
      expect(sent).toEqual([]);
      expect(await page.locator("#askReceipt").isVisible()).toBe(false);
      expect(await overflow(page)).toBe(false);
      await page.close();
    }
  }, 60_000);
});
